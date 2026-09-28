# Huginn — Architecture Decision Records

These ADRs are inferred from the codebase as it exists today. Each record
states the context, the decision as implemented, and the consequences —
including the alternatives that the code structure rules out or deliberately
avoids. They are ordered by how central the decision is to the design.

---

## ADR-1: Pipeline-as-data over imperative control flow

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: Huginn must run the same eight-phase cycle on every iteration of
  a plan, with retry, fix, and escalation behavior that is nearly identical
  across phases yet differs in the details: three gate styles (`spec-audit`,
  `validate-step`, `judge`), different fix phases, and two phases that must
  never block. An imperative `if (phase === ...)` chain in the engine would
  duplicate the retry loop for each phase and make the pipeline order invisible.
- **Decision**: The pipeline is a data table — `PIPELINE: PipelineStep[]` in
  `src/engine/cycle.ts` — where each step declares its `phase`, phase function
  `fn`, `gate` kind, `fixPhase`, `fixLabel`, and `blocking` flag. One generic
  `runPhase()` loop drives every step: run once → gate → record → fix on the
  thinker → retry → escalate. The eight phases of `MAIN_PHASES` in
  `src/engine/types.ts` are the single source of truth for order; the progress
  markdown renderer (`renderProgressMarkdown`, `src/state/store.ts`) re-derives
  from it. The TUI's `PipelineCard` keeps its own local `BASE_PHASES` copy
  (`src/tui/Dashboard.tsx`) that must be kept in sync with `MAIN_PHASES` by
  hand.
- **Consequences**:
  - *Positive*: adding a phase is adding one table row plus its `phases.ts`
    function; retry/escalation semantics cannot diverge per phase; the
    non-blocking nature of `DOC_SYNC`/`COMMIT_ALL` is a one-word flag.
  - *Negative*: phase-specific control flow is hidden behind the table's
    `gate`/`fixPhase` indirection; reading the engine requires understanding
    the `PipelineStep` contract first.
  - *Alternative considered*: a chain of explicit per-phase methods with a
    shared retry helper — rejected because the helper would still need a
    switch, and the pipeline order would be scattered across the class.

## ADR-2: FIFO decision broker

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: Two independent producers create decision requests: the engine
  (`gate-blocked` escalations) and the opencode permission event stream
  (`permission` requests in `--permissions ask` mode). Both can be pending at
  the same time. A naive "render the latest request, resolve whatever the user
  answered" approach can silently overwrite an earlier request — the code
  comment in `src/engine/decisionBroker.ts` states this previously "orphaned a
  promise and hung the run."
- **Decision**: All decisions flow through one `DecisionBroker` — a FIFO queue
  of `{req, resolve}` pairs. Only the head of the queue is surfaced via the
  `decision` event; resolving it resolves that promise and surfaces the next.
  `request()` emits `decision` only when the new request becomes the head.
  `resolveAll(choice)` drains the queue on abort/error so no pending `await`
  outlives the run.
- **Consequences**:
  - *Positive*: every request gets exactly one answer, in arrival order; the
    engine can safely `await` a decision without worrying about pre-emption;
    abort is a clean O(n) drain.
  - *Negative*: a stuck human blocks later decisions (correct — they are
    presented one at a time); the broker itself must be single-threaded.
  - *Alternative considered*: a per-request promise with a `last-wins` render —
    rejected for the hang it caused; a priority queue — rejected, no request
    kind is more important than another.

## ADR-3: Fail-closed gates

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: Gate verdicts must be extracted from free-form LLM report text
  (`✅/⚠️/🛑` markers, `Overall fidelity:` lines, or a judge's JSON). LLM output
  can be empty, truncated, or hallucinated. The dangerous failure mode is
  silently treating an unreadable report as a pass and letting a broken
  iteration reach `commit-all`.
- **Decision**: The verdict parsers (`parseValidateStepVerdict`,
  `parseSpecAuditVerdict`) return `Verdict | null`; `null` means "no parseable
  marker." The engine's `gatedVerdict()` converts `null` to `blocked` and logs
  a warning pointing at the report file. The `judgePhase` path fails the same
  way: unparseable judge output falls back to keyword heuristics, and if those
  fail, it returns `blocked` with `parsed: false` (logged). There is no code
  path that upgrades an unreadable report to `pass`.
- **Consequences**:
  - *Positive*: the run never advances past an unverifiable gate; the failed
    gate is visible in the log and can be re-run with the fix loop.
  - *Negative*: a well-meaning report that omits the marker blocks the pipeline
    until fixed — by design; false negatives (report is actually fine) require
    a human `force-continue`, which is the intended escape hatch.
  - *Alternative considered*: defaulting unknown output to `pass` — rejected as
    the exact failure mode this ADR exists to prevent.

## ADR-4: Atomic state persistence + path-independent plan hash for resume

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: Runs can be killed at any point (SIGINT, crash, CI timeout) and
  must resume from the exact phase. State is written after every phase, so a
  torn write could corrupt the only record of progress. Resume correctness also
  depends on knowing whether the input documents changed since the run began —
  but the repo may legitimately move between runs (clone elsewhere, different
  checkout path).
- **Decision**: `saveState` writes `state.json.tmp` then `renameSync`s over
  `state.json` — the rename is atomic on the filesystems huginn targets, so a
  crash leaves either the old or the new state, never a fragment. Corrupt state
  throws at load rather than being silently reset. `computePlanHash` hashes
  each document as `basename \0 content \0` (SHA-256), making the resume hash
  **path-independent**: moving or re-cloning the repo does not invalidate saved
  progress. The hash is compared on every run; mismatch refuses to resume unless
  `--ignore-plan-changes`; `--force-restart` wipes `.harness/` wholesale.
- **Consequences**:
  - *Positive*: resume is reliable across crashes and repo relocations; hash
    changes force an explicit decision instead of silently resuming against
    stale plans; `PROGRESS.md` regenerated on every persist gives a human
    checkpoint even when `state.json` is unreadable.
  - *Negative*: every phase does a full write of `state.json` (small — bounded
    by history size); basename-hashing means two different repos with identical
    `plan.md`/`spec.md`/`adr.md` contents share a hash (accepted: content
    equality is exactly what resume requires).
  - *Alternative considered*: hashing absolute paths — rejected, breaks resume
    after `git clone`; in-place `writeFileSync` without tmp+rename — rejected,
    risks truncation on crash.

## ADR-5: Bundling opencode agents/commands as markdown templates with opt-in installation

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: The cycle depends on opencode subagents and slash commands
  (`spec-auditor`, `qa`, `security`, `doc-writer`, `reviewing` + six commands)
  that live in the user's opencode config (`~/.config/opencode/{agents,commands}`).
  They are not built into opencode (the `build` agent is — it is deliberately
  not bundled). The user needs these definitions present, up-to-date, and
  discoverable.
- **Decision**: The agent/command definitions ship inside the package as
  `templates/{agents,commands}/*.md` and are installed into the opencode config
  dir by `huginn install`, by the `bun install` postinstall hook, and — as a
  warning-only nudge — by `huginn run`/`plan` when pieces are missing
  (`getMissing`). The template location is resolved by walking up from the
  compiled module (works from `src/`, `dist/`, and `scripts/`) with a
  `HUGINN_TEMPLATES_DIR` override; the destination is overridable with
  `HUGINN_OPENCODE_CONFIG_DIR`.
- **Consequences**:
  - *Positive*: zero manual setup beyond `huginn install`; the definitions are
    plain markdown the user can read and personalize; tests can point the
    installer at a temp dir and assert the full 11-piece inventory.
  - *Negative*: the templates can drift from the engine's parser contract (the
    verdict-marker lines and the `## Iteration N —` format are the coupling
    points); a user's customized copy that omits the markers will fail closed —
    which the gate model then surfaces as a blockage.
  - *Alternative considered*: hardcoding prompts in the engine — rejected, less
    transparent and harder for users to tweak; a separate repo/setup script —
    rejected, adds a distribution step.

## ADR-6: No-overwrite installer policy

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: The same config dir that huginn writes into is where a user may
  have personally edited their own `qa`/`reviewing` agents. A `bun install`
  that clobbered those files would destroy user configuration out from under
  them, silently.
- **Decision**: `installTemplates` copies a template only if the destination
  does not exist, unless `force: true` is passed. `huginn install` shows what
  will happen (installed / already present / will overwrite) before asking for
  confirmation, and reports `installed`/`skipped`/`overwritten`/`still missing`
  after. The postinstall hook stays silent when everything is already present.
- **Consequences**:
  - *Positive*: user customizations are never clobbered by `bun install`;
    idempotency is trivially testable (`installTemplates` twice → second run
    installs nothing).
  - *Negative*: a user's stale copy can diverge from the bundled contract;
    `--force` exists for that, but requires an explicit decision. Missing files
    are detected and warned about at run time, so the failure mode is visible,
    not silent.
  - *Alternative considered*: always overwrite (simplest) — rejected as hostile
    to config ownership; checksum-based "overwrite only if unchanged" — more
    machinery than the problem needs given the fail-closed gate safety net.

## ADR-7: Timeout/abort model — AbortController + session.abort + PhaseTimeoutError

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: Every phase step blocks on a single opencode model call that can
  stall indefinitely (provider hiccup, agent loop). The engine must never hang
  the whole run on one call, and the default budget is generous (20 minutes per
  step, `--phase-timeout`; `0` disables).
- **Decision**: All `prompt`/`runCommand` calls go through `withTimeout`
  (`src/server/client.ts`): an `AbortController` + timer races the fetch; on
  expiry the server-side agent is interrupted via `client.session.abort` (best
  effort), the local fetch is aborted, and a typed `PhaseTimeoutError` is
  thrown. The engine treats it as a phase failure: retry up to `maxRetries`,
  then escalate to a human decision. Late settlements are detected and logged
  ("request settled after its timeout") rather than silently merging results.
  `timeoutMs <= 0` disables the mechanism entirely.
- **Consequences**:
  - *Positive*: a stalled provider cannot hang the run; the abort is two-sided
    (local signal + server interrupt); timeouts are indistinguishable from
    other phase errors by the retry loop, keeping the control flow uniform.
  - *Negative*: a slow-but-healthy phase past the deadline is killed — mitigated
    by the large default and the disable option; the late-settle detection adds
    a small post-race bookkeeping cost.
  - *Alternative considered*: abandoning `session.abort` and only aborting the
    local fetch — rejected, the server-side agent would keep running and burn
    tokens; no timeout at all — rejected, that was the hang this ADR fixes.

## ADR-8: Global typed event emitter over direct callbacks

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: The engine, the permission subscriber, the TUI dashboard, and
  the headless frontend all need to observe the same runtime facts (phase
  start/end, streamed text, verdicts, decisions, logs, state updates,
  completion). Wiring these as constructor-injected callbacks would thread
  dozens of parameters through `CycleEngine` and make the two frontends a
  permanent part of the engine's API.
- **Decision**: A single typed `Emitter` (`src/engine/engineEvents.ts`) with a
  fixed `EngineEvents` event/payload map is imported wherever needed. Listeners
  register/unregister per event; exceptions thrown by one listener are caught
  and logged so a broken subscriber cannot kill the engine. The engine emits
  facts and never knows who is listening; both frontends subscribe in `finally`
  blocks. The only direct callback the engine accepts is the decision channel
  (`engine.ask()`), which itself just proxies into the DecisionBroker.
- **Consequences**:
  - *Positive*: decouples engine from UI; the event map doubles as the
    runtime's observable API; adding a frontend is additive.
  - *Negative*: global state — two engines in one process would share events
    (unused: one engine per process); the dashboard must re-derive UI state
    from event history rather than reading engine internals (bounded: it only
    needs the last phase, stream tail, log tail).
  - *Alternative considered*: observer classes per subsystem — rejected as
    heavier than the one global emitter; React context — rejected, headless
    mode has no React tree.

## ADR-9: Single-file bundled bin

- **Date**: 2026-08-07 (inferred)
- **Status**: Accepted
- **Context**: `package.json` declares `bin: { "huginn": "dist/cli.js" }` and
  the build is `bun build src/cli.ts --target=bun --outdir=dist --minify`.
  The tool must be installable/global via `bun link` and runnable anywhere,
  including when the repo layout has moved relative to the source.
- **Decision**: Ship a single bundled entry point (`dist/cli.js`, shebang
  `#!/usr/bin/env bun`) as the only public surface. Paths that must survive the
  bundle — the `templates/` directory and the opencode config dir — are
  resolved at runtime, not baked in: `findTemplatesRoot()` walks up from
  `import.meta.dir` (or honors `HUGINN_TEMPLATES_DIR`), and the config dir is
  `~/.config/opencode` (or `HUGINN_OPENCODE_CONFIG_DIR`). The shebang comes
  from `src/cli.ts`'s first line.
- **Consequences**:
  - *Positive*: one artifact to install/distribute; no module-resolution
    surprises for consumers; template discovery deliberately avoids embedding
    an absolute path.
  - *Negative*: the bundle is Bun-target-specific (not portable to Node); the
    `import.meta.dir` walk assumes `templates/` is reachable within 8 parent
    levels, which the env override exists to escape.
  - *Alternative considered*: publishing the full source tree with a bin
    wrapper (e.g. `bin/huginn.js` importing `src/cli.ts`) — rejected for
    distribution simplicity; a Node/tsx wrapper — rejected, Bun is the declared
    runtime and `bun run`/`bun link` is the documented install path.

## ADR-10: Greenfield SPEC_AUDIT skip with a `skipped` verdict

- **Date**: 2026-08-13
- **Status**: Accepted
- **Context**: The first gate of every iteration is `SPEC_AUDIT`, which has a
  subagent audit semantic alignment between `spec.md` and the implementation.
  On a greenfield repo — typically the first iteration after `huginn plan`
  bootstraps the documents, when nothing has been built yet — there is no
  implementation to audit. Running the auditor would burn a model call and
  produce vacuous MAJOR DEVIATION noise against an empty tree, and the
  `spec-auditor` prompt embeds documents the agent has nothing to check
  against. The pipeline needed a way to record "this gate is intentionally
  not run yet" without weakening fail-closed semantics.
- **Decision**: Before invoking the auditor, the engine classifies the repo
  with `hasImplementationCode` (`src/engine/diff.ts`): a file from
  `git ls-files --cached --others --exclude-standard` counts as implementation
  code when it has a source extension from `SOURCE_EXTENSIONS` and is not in an
  ignored directory (`.harness`, `.git`, `node_modules`, `dist`, …).
  Config/scaffolding/docs (`.json`, `tsconfig`, lockfiles, markdown) do not
  count. When no such file exists, `recordSkippedSpecAudit` writes a history
  entry with verdict `skipped` — no agent call, and `phaseAttempts` is
  deliberately *not* incremented so a real audit later (e.g. on resume after
  code appears) still starts at attempt 1. `skipped` is a fourth member of the
  `Verdict` union (`pass | warning | blocked | skipped`) that no gate parser or
  judge ever produces; it is exclusive to this skip path. The progress renderer
  and both frontends render it as a pass-equivalent (`⏭️`).
- **Consequences**:
  - *Positive*: greenfield bootstraps skip a pointless audit cheaply; the skip
    is fully visible (`state.json` history, `PROGRESS.md`, TUI, headless) and
    resumable; fail-closed semantics are untouched because `skipped` is
    recorded directly, not parsed, and never blocks or passes a gate.
  - *Negative*: a fourth verdict value that every consumer (schema, progress
    renderer, TUI, headless) must handle; a repo whose implementation exists
    only in non-source files (e.g. pure JSON config) is misclassified as
    greenfield — mitigated by the wide `SOURCE_EXTENSIONS` set and by counting
    untracked files; the classification adds a git call per iteration.
  - *Alternative considered*: running the auditor anyway and trusting a 🟢 on an
    empty repo — rejected, wasteful and misleading; treating greenfield as a
    plain `pass` — rejected, that would hide a broken `hasImplementationCode`
    classification behind a gate that never ran.

## ADR-11: npm trusted publishing — scoped package, provenance on version tags

- **Date**: 2026-08-13
- **Status**: Accepted
- **Context**: huginn is distributed as a public npm package. The initial
  1.0.0 was published under the unscoped name `huginn`; ahead of the 1.0.1
  release it was renamed to the scoped `@dahch/huginn`
  (`publishConfig.access: "public"`). Publishing must be deliberate (not on
  every push), tamper-evident, and consistent between the git tag and the
  published version. The repo also dropped `package-lock.json` in favor of
  Bun's `bun.lock`.
- **Decision**: `.github/workflows/publish.yml` publishes only when a `v*`
  tag is pushed. The workflow first verifies that the tag version
  (`GITHUB_REF_NAME` minus the `v` prefix) equals `package.json`'s `version`,
  failing the job otherwise; it then installs with
  `bun install --frozen-lockfile`, runs `bun run build`, `bun test` and
  `bun run typecheck`, and finally runs `npm publish --provenance` with the
  workflow's `id-token: write` permission — npm provenance via OIDC, so the
  published artifact is attestation-signed by GitHub. The publish step runs on
  **Node 24** (`actions/setup-node`), which npm's trusted-publishing/OIDC flow
  requires. `prepublishOnly` (`bun run build && bun test && bun run typecheck`)
  is an additional npm-side guard. The LICENSE is MIT.
- **Consequences**:
  - *Positive*: releases are tag-driven and reproducible; the tag↔version
    check prevents mislabeled publishes; npm provenance gives consumers
    machine-verifiable attestations; scoped naming avoids squatting on the
    bare `huginn` name.
  - *Negative*: publishing is all-or-nothing on a tag push — there is no
    manual "publish this exact commit" path; a version bump requires both
    `package.json` and a matching tag (`huginn`'s own release flow, e.g. the
    `huginn run` cycle, is what produces them); OIDC publishing pins the
    workflow to Node ≥ 24 for the npm step.
  - *Alternative considered*: publishing from `main` on every push — rejected,
    no version control and no provenance story; publishing manually via
    `npm publish` locally — rejected, no OIDC provenance and no
    tag↔version guard.

## ADR-12: Live mode as a thin orchestrator that reuses the cycle engine and plan-mode drafting

- **Date**: 2026-08-19
- **Status**: Accepted
- **Context**: `huginn plan` drafts the three documents in one shot and prints
  a `huginn run` command; the developer then manually edits/approves and runs
  the cycle separately. The iteration loop between "idea" and "execution" is
  where requirements actually get shaped, and it happened outside huginn.
  Building a separate drafting stack for an interactive mode would have
  duplicated the plan-mode prompts, the format contract, the decision flow, and
  the cycle itself.
- **Decision**: `huginn live` is implemented as `LiveEngine`
  (`src/engine/liveMode.ts`), a small state machine (refine → draft → approve
  → execute) that **reuses existing machinery** rather than replacing it:
  - the same opencode session + `prompt`/`withTimeout` path as the cycle, all
    on the thinker model with a 20-minute budget;
  - the same `DecisionBroker` FIFO queue for the three new decision kinds
    (`approve-draft`, `scope-extraction`, `draft-format`), with
    `ask`/`resolveDecision`/`requestAbort` delegating to the `CycleEngine`
    after handoff;
  - the plan-mode prompt builders and `OUTPUT_FORMAT_CONTRACT` /
    `validateDraftFormat` / `unwrapFences` (exported from `src/engine/planMode.ts`)
    for all drafting; live mode only adds the validate→retry-once→human-decision
    loop around them;
  - git as the review surface: `git add -N` intent-to-add staging so the human
    reviews `git diff HEAD -- spec.md adr.md plan.md`, then a `docs(scope)`
    commit and a fresh `CycleEngine` on approval.
  The only genuinely new contract is scope extraction: the thinker must reply
  to `/draft` with a `SCOPE:` line + fenced block, and a missing/unparseable
  block fails closed to a human decision instead of inventing a scope.
- **Consequences**:
  - *Positive*: one drafting implementation, one decision path, one cycle — live
    mode is ~400 lines of orchestration on top of existing code; the run-cycle
    rendering (Dashboard, headless summary, `runHeadless`) is reused verbatim
    after handoff; format-contract violations are caught mechanically instead of
    being shipped to the cycle.
  - *Negative*: live mode is the one path where huginn itself writes
    `spec.md`/`adr.md`/`plan.md` (breaking the "read-only documents" invariant
    for `run`) — mitigated by explicit human approval and a dedicated `docs(scope)`
    commit; headless live mode cannot chat (the CLI idea is used as-is), so the
    interactive value is TUI-only.
  - *Alternative considered*: a full separate chat/agent product — rejected, it
    would duplicate the session, decision, and drafting machinery; extending
    `huginn plan` with a REPL — rejected, plan mode has no executor/handoff path
    and the TUI would still be missing.

## ADR-13: Handling Opencode question tools and SSE events

- **Date**: 2026-08-19
- **Status**: Accepted
- **Context**: In Opencode, models have access to built-in tools including `question`
  (for interactive multiple-choice and clarifying questions). When an agent
  invokes the `question` tool during execution (e.g. during live refinement or
  build execution), the Opencode server suspends session progress and emits a
  `question.asked` SSE event waiting for an HTTP POST reply
  (`/session/:id/question/:reqId/reply`) or reject (`/session/:id/question/:reqId/reject`).
  Because huginn's event subscriber previously only handled `permission.updated`,
  an agent's invocation of `question` caused `prompt()` to hang indefinitely,
  freezing `live.chat()` and the TUI until timeout.
- **Decision**:
  - `subscribeToEvents` (`src/engine/permissions.ts`) handles `question.asked`,
    `question.v2.asked`, and `question.updated` alongside permission events.
  - In `--permissions auto` mode, huginn auto-answers with the first/recommended
    option from each question item (`respondQuestion`, `src/server/client.ts`)
    and logs the resolution, unblocking the agent immediately.
  - In `--permissions deny` mode, huginn rejects the question (`rejectQuestion`).
  - In `--permissions ask` mode, huginn creates a `question` decision request via
    `DecisionBroker`, rendering interactive prompts in both TUI (`LiveDashboard.tsx`,
    `Dashboard.tsx`) and headless mode (`src/headless.ts`).
  - In `liveMode.ts`, `refineSystemPrompt` explicitly guides the thinker model to
    emit clarifying questions directly in conversational markdown text.
- **Consequences**:
  - *Positive*: Opencode tools cannot deadlock or freeze the harness; consistent
    permission/question policy enforcement (`auto`/`ask`/`deny`); robust fail-safe
    with dynamic baseUrl resolution in `client.ts`.
  - *Negative*: Adds `respondQuestion` and `rejectQuestion` endpoints to the client
    adapter layer and adds `"question"` to the `DecisionKind` union.

## ADR-14: Persistent Semantic and Symbol Memory Engine ("Muninn") via SQLite FTS5 & MCP

- **Date**: 2026-09-26
- **Status**: Accepted
- **Context**: In AI-assisted development agent workflows (Claude Code, Cursor, Windsurf, OpenCode), every new session loses context regarding architectural decisions, local conventions, discoveries, and debugging findings. Existing tools like Engram provide plain-text SQLite FTS5 search, but plain text lacks topological code context: when an agent inspects a function or interface, it does not know which conventions or architectural decisions govern it. Huginn requires a persistent memory engine ("Muninn") that not only retains structured text observations, but also connects observations to AST symbols and file entities via a lightweight knowledge graph in SQLite, exposed through a standard Model Context Protocol (MCP) server.
- **Decision**:
  1. Structure the subsystem cleanly inside `src/muninn/` (`db/`, `service/`, `mcp/`).
  2. Use embedded SQLite with `better-sqlite3` and FTS5 enabled, supporting deterministic path resolution rules in `src/muninn/db/client.ts`:
     - If an explicit custom path (or `:memory:`) is provided, use it directly (empty string falls back to auto resolution).
     - Otherwise, search upward from `process.cwd()` for the nearest `.git` directory (`findGitRoot`); if located, resolve to `<git_root>/.huginn/muninn.db`.
     - When no git repository is present, fallback to user-global `~/.huginn/muninn.db`.
     - Ensure the parent directory is created automatically with restricted permissions (`mode: 0o700`).
  3. Configure essential SQLite PRAGMAs upon connection:
     - `PRAGMA foreign_keys = ON;`: Enforces referential integrity and cascading deletes across projects, observations, and entities.
     - `PRAGMA journal_mode = WAL;`: Enables Write-Ahead Logging for high concurrency, non-blocking reads, and crash resilience.
     - `PRAGMA busy_timeout = 5000;`: Waits up to 5 seconds during lock contention rather than failing immediately with `SQLITE_BUSY`.
     - `PRAGMA recursive_triggers = ON;`: Essential for cascade deletions to trigger FTS5 cleanup hooks (`obs_ad`) automatically when parent projects or observations are removed.
  4. Implement automatic schema initialization and migrations in `src/muninn/db/client.ts` executing `src/muninn/db/schema.sql` (or embedded `SCHEMA_SQL` fallback) defining `projects`, `observations`, `observations_fts` virtual table with automatic synchronization triggers (`obs_ai`, `obs_ad`, `obs_au`), `entities`, and `observation_entities`.
  5. Provide `ensureProject` for idempotent workspace registration, inspecting `.git/config` for origin URLs while stripping basic authentication credentials via `sanitizeGitRemote` to prevent token leakage.
  6. Implement `MemoryService` in `src/muninn/service/memory-service.ts` providing `saveObservation`, `search` (BM25 FTS5 ranking), `getContext`, `linkSymbol`, `getStats`, and JSONL disk sync/import (`.huginn/memories.jsonl`) for git sharing.
  7. Provide an MCP server in `src/muninn/mcp/server.ts` with `StdioServerTransport` and Zod-validated tool definitions: `muninn_save`, `muninn_search`, `muninn_context`, `muninn_link_symbol`, and `muninn_stats`.
  8. Extend the Huginn CLI (`src/commands/memory.ts`, `src/cli.ts`) with `huginn memory init`, `huginn memory search <query>`, `huginn memory sync [--import]`, and `huginn mcp run`.
  9. Maintain comprehensive test coverage using `vitest` under `test/muninn/`.
- **Consequences**:
  - *Positive*: Zero external dependencies or paid embedding APIs; lightning-fast BM25 lexical search combined with code symbol graph navigation; standard JSON-RPC 2.0 stdio MCP server pluggable into any agent IDE; deterministic context retrieval; portable JSONL git sync; robust data integrity via foreign keys, WAL mode, recursive triggers, and busy timeout.
  - *Negative*: Native SQLite binary bindings must compile cleanly across platforms (macOS, Linux, Windows), mitigated by `better-sqlite3` prebuilds.

## ADR-15: MemoryService — Safe BM25 FTS5 Search, Transactional Entity Graph, and Atomic 0o600 JSONL Sync

- **Date**: 2026-09-26
- **Status**: Accepted
- **Context**: The low-level database layer provides SQLite tables and FTS5 triggers, but application-level consumers (the CLI, future MCP server, and agent tools) require a unified service abstraction. Interacting directly with SQLite FTS5 introduces critical edge cases: raw user input with slashes, colons, or punctuation (common in file paths and code symbols like `src/auth.ts::verifyToken`) crashes SQLite FTS5 with syntax errors; loading entities for hundreds of search results can exceed SQLite's host parameter limit (`SQLITE_LIMIT_VARIABLE_NUMBER`, typically 999 or 32766); file exports could leave partial writes or expose sensitive project notes via default world-readable file permissions; and symbol association must be transactional and idempotent.
- **Decision**:
  1. Implement `MemoryService` in `src/muninn/service/memory-service.ts` managing the database lifecycle, current project context via `ensureProject`, and transactional memory operations.
  2. Implement `sanitizeFtsQuery` to tokenize raw search strings:
     - Extracts double-quoted phrases and standalone alphanumeric terms.
     - Wraps individual terms in quotes (`"term"`) to treat punctuation, slashes, and colons as literal search strings rather than FTS5 boolean operators.
     - Preserves valid prefix searches ending with `*` (`"prefix"*`).
     - Discards standalone syntax operators (`*`, `:::`, `///`) and returns an empty query to safely return `[]` without throwing FTS5 syntax exceptions.
  3. Enforce atomic transactional consistency in `saveObservation`:
     - Validates category against `VALID_CATEGORIES` (`decision`, `convention`, `discovery`, `bugfix`, `architecture`).
     - Normalizes symbols into `{ identifier, filePath, entityType }` via `normalizeSymbol`, deduplicating identical symbols within the observation input.
     - Reuses existing entities matching `(project_id, identifier)` and links them via `observation_entities` within a single `db.transaction()` block.
  4. Optimize chronological context retrieval with `idx_observations_project_updated`:
     - Adds composite index `idx_observations_project_updated ON observations(project_id, updated_at DESC, created_at DESC)`.
     - `getContext` queries use this index to avoid full table scans.
  5. Chunk entity association queries (`_fetchEntitiesForObservations`):
     - For both `search` and `getContext`, entity joins for matching observation IDs are fetched in chunks of at most 500 parameters (`IN (?, ?, ...)`), completely insulating the system against SQLite variable limit exhaustion.
  6. Implement atomic, secure disk synchronization (`syncToDisk`):
     - Formats observations and linked entities into JSON Lines (`.jsonl`).
     - Writes to `<targetPath>.tmp` with explicit restrictive file permissions `0o600` (`rw-------`), ensures mode via `chmod`, and replaces the target file via atomic filesystem `renameSync`. Cleans up `.tmp` on write failures.
  7. Implement idempotent, fault-tolerant ingestion (`importFromDisk`):
     - Parses line-by-line within a single database transaction.
     - Skips records with existing observation IDs (no duplicate inserts).
     - Validates string types for `id`, `title`, and `content`, falling back to `currentProject.id` if referenced projects are unknown, and defaulting invalid categories to `'decision'`.
- **Consequences**:
  - *Positive*: Complete immunity to SQLite FTS5 syntax injection/crashes; atomic writes ensure zero corrupt/partial `.jsonl` files; owner-only `0o600` permissions prevent local credential or architectural note leakage; chunked entity queries guarantee scalability over large result sets; symbol normalization simplifies agent integrations.
  - *Negative*: Two-tier data representation (SQLite relational database + `.huginn/memories.jsonl` export) requires deliberate synchronization via `syncToDisk` and `importFromDisk`.

## ADR-16: Muninn Model Context Protocol (MCP) Server Architecture, Declarative Registry, and Security Hardening

- **Date**: 2026-09-26
- **Status**: Accepted
- **Context**: Muninn needs to expose its memory persistence engine to autonomous AI coding agents (Claude Code, Cursor, OpenCode, Windsurf) through a standard protocol. The Model Context Protocol (MCP) using JSON-RPC 2.0 over standard I/O (`stdio`) is the designated standard. However, exposing database operations to LLM tool calls presents unique operational and security challenges:
  1. *Erratic LLM Argument Serialization*: Different LLM clients serialize optional arguments inconsistently, often transmitting explicit `null` or `undefined` values for omitted fields (which fail naive Zod `.optional()` checks) or passing `snake_case` aliases instead of `camelCase`.
  2. *Prototype Pollution*: Unsanitized JSON payloads from external tool invocations could contain `__proto__`, `constructor`, or `prototype` keys, leading to object prototype pollution vulnerabilities.
  3. *Unbounded Payload & Resource Exhaustion*: LLMs could generate arbitrarily large string payloads or oversized symbol arrays, leading to memory spikes or database degradation.
  4. *Transport Fragility*: Uncaught exceptions thrown during tool execution or schema validation crash the stdio stream, abruptly severing the agent's MCP session.
  5. *Architectural Coupling*: Binding the MCP server directly to the concrete `MemoryService` implementation impedes isolated unit testing, mocking, and alternative storage backends.
- **Decision**:
  1. **Transport & Protocol**:
     - Implement standard JSON-RPC 2.0 over stdio using `Server` and `StdioServerTransport` from `@modelcontextprotocol/sdk`.
     - Expose `createMcpServer(serviceOrOptions?)` for dependency injection and `startMcpServer(options?)` for standalone process execution.
  2. **Port Interface Decoupling (`IMemoryService`)**:
     - Formalize the `IMemoryService` port interface in `src/muninn/service/memory-service.ts` (re-exported by `src/muninn/mcp/server.ts`).
     - Decouple `createMcpServer` and tool handlers from concrete implementations, accepting any object satisfying `IMemoryService`.
  3. **Declarative `TOOL_REGISTRY`**:
     - Replace imperative routing with a declarative `TOOL_REGISTRY: Record<string, ToolDefinition>` mapping each tool to `{ name, description, schema, handler }`.
     - Automatically derive the static `MUNINN_TOOLS` array and MCP tool metadata via `z.toJSONSchema`.
  4. **Strict Payload Bounds & Zod Schemas**:
     - Validate all tool inputs with dedicated Zod schemas:
       - `muninn_save`: title bounded to 1–1,000 chars, content bounded to 1–1,000,000 chars, topicKey bounded to 256 chars, symbols array capped at 500 items.
       - `muninn_search`: query bounded to 1–2,000 chars, limit clamped to 1–500 (default: 10).
       - `muninn_context`: limit clamped to 1–500 (default: 20), topicKey bounded to 256 chars.
       - `muninn_link_symbol`: requires non-empty observationId and valid symbol.
       - `muninn_stats`: validates boolean `allProjects`.
     - `SymbolSchema` enforces `.refine()` requiring at least one identifier property (`name`, `identifier`, `filePath`, or `file_path`), rejecting empty `{}` symbol objects.
  5. **Nullish Argument Normalization & Prototype Pollution Defense**:
     - Implement `normalizeArgs(args)` invoked prior to Zod validation:
       - Skips `__proto__`, `constructor`, and `prototype` keys to prevent prototype pollution.
       - Prunes `null` and `undefined` properties, allowing Zod `.nullish()` and defaults to resolve cleanly.
       - Translates common `snake_case` aliases (`topic_key` -> `topicKey`, `observation_id` -> `observationId`, `all_projects` -> `allProjects`).
     - Wrap argument extraction and normalization within a defensive `try...catch` block.
  6. **Fail-Safe Tool Error Responses**:
     - All tool execution and validation errors are intercepted within `CallToolRequestSchema` handler and returned as standard `{ isError: true, content: [{ type: "text", text: ... }] }` responses.
     - Validation errors are formatted into readable property paths and messages via `formatZodErrors`.
     - Fatal SQLite storage errors (disk corruption, full disk, I/O errors) are explicitly detected, logged to stderr, and rethrown, while non-fatal search query failures log warnings and return empty results.
- **Consequences**:
  - *Positive*: Seamless compatibility with all modern MCP-compliant AI agents; complete protection against prototype pollution and payload flooding; resilience against erratic LLM null/snake_case serialization; rock-solid stdio transport stability with structured error reporting; testable and modular architecture via the `IMemoryService` port.
  - *Negative*: Schema definition duplication between TypeScript interfaces and Zod schemas; JSON serialization overhead for MCP tool payload responses over stdio.

## ADR-17: CLI Command Integration for Muninn Memory Subsystem and Stdio MCP Runner

- **Date**: 2026-09-26
- **Status**: Accepted
- **Context**: Muninn memory engine and its MCP server reside in `src/muninn/`, but developers and external tooling need direct command-line access to initialize databases, search observations with BM25 ranking, sync memories with git-portable `.jsonl` files, and launch the stdio MCP server. Huginn's CLI entry point (`src/cli.ts`) was historically designed for single-command executions (`run`, `plan`, `live`, `install`) with single positional argument parsing. Supporting hierarchical subcommands (`huginn memory init`, `huginn memory search <query>`, `huginn memory sync [--import]`, `huginn mcp run`) exposed several structural issues:
  1. *Boolean Flag Ingestion*: A naive argv loop treats any non-flag token following `--flag` as that flag's value. For standalone boolean flags (`--import`, `--yes`, `--force`), this caused the flag to mistakenly consume subsequent positional arguments or filenames.
  2. *Single Positional Loss*: `parseArgs` only stored the first non-command positional in `_positional`, dropping trailing arguments needed for subcommands and queries (e.g. `memory` -> command, `search` -> subcommand, `vector indexing` -> query).
  3. *Keyword Shadowing*: If a search query or sync target filename matched a command name (e.g. `huginn memory search search` or `huginn memory sync sync`), positional extraction could confuse the argument with the subcommand.
  4. *Stdio Transport Corruption*: When `huginn mcp run` launches, any standard output outputted to stdout (such as initialization banners or logs) corrupts JSON-RPC frame parsing in MCP clients (Cursor, Claude Code, OpenCode).
  5. *Process Teardown & Exit Codes*: Command validation errors (e.g. missing query) must set `process.exitCode = 1` rather than calling `process.exit(1)` immediately, allowing asynchronous stdout/stderr streams to drain cleanly.
  6. *Test Pipeline Orchestration*: Core unit tests run on `bun test` while Muninn's SQLite and MCP tests run on `vitest`. The test scripts needed unification.
- **Decision**:
  1. **Subcommand Module Architecture**:
     - Implement `src/commands/memory.ts` encapsulating CLI interaction logic: `handleMemoryCommand`, `handleMcpCommand`, `printMemoryUsage`, and `printMcpUsage`.
     - Route top-level `memory` and `mcp` commands from `src/cli.ts` without polluting the core harness engine.
  2. **Enhanced CLI Argument Parser (`parseArgs`)**:
     - Maintain an explicit `BOOLEAN_FLAGS` set (`--yes`, `--force`, `--resume`, `--force-restart`, `--ignore-plan-changes`, `--tui`, `--headless`, `--import`, `--help`, `-h`) so boolean flags never consume subsequent tokens.
     - Capture all positional arguments in an ordered `_positionals: string[]` array while maintaining backwards compatibility with `_positional`.
     - Implement robust numeric conversion helper `num(v: unknown, fallback: number)` handling non-string inputs safely.
  3. **Disambiguated Positional Subcommand Dispatch**:
     - Subcommands are extracted from `_positionals[0]`, passing the remaining `positionals.slice(1)` to command handlers.
     - Handles searches for the literal word "search" and sync operations on files named "sync" without argument shadowing or routing collisions.
  4. **Strict Stdio Hygiene for MCP Runner**:
     - `huginn mcp run` outputs zero text to `stdout`, keeping the channel clean for JSON-RPC 2.0 communication.
     - Manages process lifecycle via an unresolved Promise, listening on `transport.onclose` and binding `SIGINT` and `SIGTERM` signals for graceful teardown of both `MuninnServer` and `MemoryService`.
  5. **Clean Exit Code Propagation**:
     - Input validation failures log formatted messages via `chalk.red` and set `process.exitCode = 1`.
     - `cli.ts`'s `main()` resolves cleanly and calls `process.exit(process.exitCode ?? 0)`.
  6. **Unified Test Orchestration**:
     - Update `package.json` script `"test": "bun test && vitest run"` to execute both the Bun harness test suite and the Vitest Muninn test suite.
     - Update `"prepublishOnly": "bun run build && npm run test && bun run typecheck"`.
- **Consequences**:
  - *Positive*: Intuitive, Unix-compliant CLI interface for memory operations; robust parsing preventing flag ingestion bugs; immune to positional keyword collisions; perfectly compliant stdio MCP server execution; graceful process termination; unified CI test automation.
  - *Negative*: `parseArgs` maintains a manual `BOOLEAN_FLAGS` registry rather than full schema-driven CLI parsing (such as `yargs` or `commander`), chosen to avoid adding heavy CLI dependencies to huginn.

---

## ADR-18: Verified Execution Contracts via Compiler API & Automatic AST Symbol Graph

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: In SDD/ODD-based autonomous agent architectures, verification has historically relied exclusively on running test suites (`npm test`) or asking an LLM to self-review its output. This approach presents two critical problems:
  1. *Wasted Thought Cycles*: Agents frequently introduce obvious syntax or type errors that slip past local generation and are only caught in late phases (`TEST_MODULE` or `REVIEW`), triggering expensive prompt recovery loops with thinker models.
  2. *Memory Disconnect*: Muninn's Phase 1 linked observations to code entities only when explicitly passed by agent tool calls. Without an automated AST indexer, Muninn remains blind to the code symbol topology, imports, and inheritance graphs.
  Huginn requires:
  1. A compiler verification contract ("Compiler Contract") operating in the pipeline (`VALIDATE_STEP` and pre-commit) that inspects syntactic and semantic diagnostics directly using the TypeScript Compiler API.
  2. A lightweight static AST symbol indexer that scans files modified during an iteration, extracts functions, classes, methods, interfaces, and dependencies, and populates `entities` and `entity_dependencies` in Muninn.
- **Decision**:
  1. **Compiler Verification Contract (`src/contracts/`)**:
     - Implement `verifyTypeScriptContracts` and `TypeValidator` using the TypeScript Compiler API (`ts.readConfigFile`, `ts.parseJsonConfigFileContent`, `ts.createProgram`, `ts.getPreEmitDiagnostics`).
     - Load project `tsconfig.json` or fall back to safe strict defaults (`strict: true`, `target: ES2022`, `moduleResolution: NodeNext`).
     - Filter diagnostics strictly to requested or modified files.
     - Implement `createVisualSnippet` to render formatted line/column snippets with ASCII underline carats (`^^^^`) and file line context.
     - Return `{ valid: boolean, errorsCount: number, diagnostics: FormattedDiagnostic[] }`.
  2. **Topological AST Indexer & Graph Storage (`src/muninn/indexer/`)**:
     - Add `entity_dependencies` table to Muninn SQLite schema with `(source_entity_id, target_entity_id, relation_type)` primary key and cascading foreign keys.
     - Traverse AST using `ts.createSourceFile` and `ts.forEachChild` identifying functions, classes, public methods, interfaces, and type aliases.
     - Format canonical identifiers as `<relPath>::<symbolName>` and `<relPath>::<ClassName>.<methodName>`.
     - Extract static dependency relationships (`imports`, `calls`, `implements`, `extends`, `references`).
     - Ingest symbols into `entities` and dependencies into `entity_dependencies` idempotently via `indexFilesIntoMuninn`.
  3. **Harness Cycle Integration (`src/engine/phases.ts`)**:
     - In `validateStep`: Before test execution, run `verifyTypeScriptContracts` on iteration modules. If severe compilation errors exist, block the gate and inject structured diagnostics into the prompt context for `FIX_VALIDATE`.
     - In `commitAll` or post-execution: Run `indexFilesIntoMuninn` over iteration modified files (`git diff`) to keep Muninn's symbol graph synchronized automatically.
  4. **MCP Tooling Extensions (`src/muninn/mcp/`)**:
     - Expose `muninn_inspect_symbol`: Returns symbol definition, file path, incoming/outgoing dependencies, and linked observations.
     - Expose `muninn_verify_contract`: Enables on-demand typecheck diagnostics for specified files.
  5. **CLI Extensions (`src/commands/check.ts`, `src/commands/memory.ts`, `src/cli.ts`)**:
     - Add `huginn check [files...]` for standalone compiler contract validation.
     - Add `huginn memory index [files...]` for AST re-indexing.
- **Consequences**:
  - *Positive*: Immediate, zero-overhead failure detection in `VALIDATE_STEP` before executing slow tests; clear, actionable diagnostics for thinker recovery loops; automated, transparent symbol and dependency topology for Muninn; dual runtime Node.js and Bun compatibility.
  - *Negative*: TypeScript Compiler API program creation has CPU/memory overhead, mitigated by filtering diagnostics to modified files.

## ADR-19: Live-First CLI Default, Universal Agent Integrator & Git Worktree Isolation

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: Three friction points remain in the Huginn entrypoint and execution model:
  1. *Fragmented entrypoint*: running `huginn` without arguments required manually preparing `run` flags (`--project`, `--thinker`, `--executor`) and pre-existing `spec.md`/`adr.md`/`plan.md`, forcing a batch workflow even for first-time, exploratory use.
  2. *Configuration coupling*: wiring the Muninn MCP server and the mandatory agent directives into each agent/IDE (Cursor, Claude Code, Windsurf, OpenCode, Gemini CLI, Qwen Code, Codex, Antigravity, Kimi, Pi, Command Code, Oh My Pi, …) required hand editing a different config file per tool, so the "consult before coding, verify before emitting" contract was rarely actually installed.
  3. *Workspace contamination*: during `EXECUTE` and `FIX_*` the build agent mutates the developer's live working tree directly. A failed or aborted iteration leaves orphaned files or a dirty git working tree that the human must untangle by hand.
  Alternatives considered: keeping `run` as the default and adding a `live` alias (rejected — does not remove the pre-prepared-docs requirement); shipping a single monolithic agent config (rejected — IDEs disagree on file locations and schema); running agents in a full `git clone` or Docker container per iteration (rejected — too heavy and slow versus a shared-object-database worktree).
- **Decision**:
  1. **Live-First Entrypoint (`src/cli.ts`, `src/config.ts`)**: invoking `huginn` bare (or `huginn "<idea>"`) runs the interactive `live` TUI by default, detecting the current git repository (`process.cwd()`). Model roles resolve through a persistent configuration layer (`.huginn/config.json`, then `~/.huginn/config.json`, then `HUGINN_THINKER_MODEL` / `HUGINN_EXECUTOR_MODEL`, then documented defaults). `run` and `plan` remain explicit subcommands for batch/CI execution.
  2. **Universal Agent Integrator (`src/commands/setup.ts`, `src/agents/integrator.ts`)**: `huginn setup [--agent <id|all>] [--force]` idempotently registers the `huginn mcp run` server and injects/updates a marked rules block for every supported agent, driven by a **declarative target registry** so adding a new agent is a single registry row (id, label, config path(s), format, rules file). Supported ids: `cursor`, `claude`, `opencode`, `windsurf`, `gemini`, `qwen`, `codex`, `agy` (Antigravity CLI), `kimi`, `pi`, `commandcode`, `omp` (Oh My Pi), plus `all`. Three config formats are supported (`mcpServers` JSON, OpenCode's `mcp` key, and Codex's TOML `[mcp_servers.*]`), and a portable `<home>/.huginn/mcp.json` is always emitted for tools that consume an ad-hoc `--mcp-config-file`. `--list` prints the resolved registry. The rules block obligates the LLM to call `muninn_context` / `muninn_inspect_symbol` before designing changes and `muninn_verify_contract` before emitting final code. Per-target paths are overridable via `HUGINN_AGENT_<ID>_MCP_PATH` / `HUGINN_AGENT_RULES_PATH`, since a few of these agents are new and their config locations may move. `huginn doctor` reports the health of git, the Bun/Node runtime, the Opencode CLI, the agent integrations, and the Muninn database.
  3. **Git Worktree Sandboxing (`src/engine/worktree.ts`)**: each iteration runs in an isolated worktree (`.huginn/worktrees/task-iter-<N>` on ephemeral branch `huginn/task-iter-<N>`). `EXECUTE`, `VALIDATE_STEP`, `TEST_MODULE` and `FIX_*` point at the worktree directory. On `COMMIT_ALL` success the sandbox commits are integrated into the user's active branch (`git merge --ff-only`, falling back to `git cherry-pick`) and the worktree+branch are removed; on abort/failure they are discarded without touching the main working tree. `node_modules` and `.env` are symlinked into the sandbox to avoid redundant reinstalls. Enabled by default, disabled with `--no-sandbox`.
- **Consequences**:
  - *Positive*: zero-friction onboarding (`huginn` opens the interactive design console); universal agent compatibility through one `setup` command; absolute isolation so the developer's editor stays on the primary branch while the agent works; resumable, auditable commits.
  - *Negative*: worktrees must share dependencies (mitigated by symlinking `node_modules`/`.env`); merging a sandbox that diverged from the active branch may require cherry-pick conflict resolution; `huginn setup` writes to files outside the project (`~/.claude`, `~/.codeium`, `~/.config/opencode`, `~/.gemini`, `~/.qwen`, `~/.codex`, …), so it is opt-in per `--agent` target and honors a no-overwrite/`--force` policy; a few of the supported agents are new and their config paths may move, mitigated by the per-target `HUGINN_AGENT_<ID>_MCP_PATH` override and the registry being data-driven.

## ADR-20: Muninn Memory Persists to the Primary Project Root under Worktree Sandboxing

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: Phase 3 runs each iteration in a git worktree (`.huginn/worktrees/task-iter-<N>`) and binds the agent and harness tools to that path (AC-17.6). `commitAll` automatically indexes the iteration's modified files into Muninn's AST symbol graph. Because `PhaseContext.projectPath` was the worktree, the indexer's `MemoryService` defaulted to `<worktree>/.huginn/muninn.db`, so every indexed symbol was written into the ephemeral sandbox and destroyed the moment the sandbox was promoted or discarded (`promoteSandbox`/`discardSandbox` both remove the worktree). Muninn is long-term memory that must accumulate across iterations, so this silently defeated the purpose of automatic indexing. Alternatives considered: (a) keep the worktree-local DB and copy it back into the primary `.huginn/` on promotion — rejected (racy with the WAL `-wal`/`-shm` sidecars, easy to lose on abort/conflict); (b) index only after a successful promotion, reading the now-primary files — rejected for this change (a larger architectural move that drops the `COMMIT_ALL` integration point; kept as a possible future follow-up); (c) resolve the database and the project record from the primary root while still scanning the worktree.
- **Decision**: `CycleEngine.runIteration` resolves `primaryDbPath = resolveDatabasePath(undefined, cfg.projectPath)` and injects both `PhaseContext.dbPath = primaryDbPath` and `PhaseContext.primaryProjectRoot = cfg.projectPath`, while `projectPath`/`directory` stay bound to the worktree so agent edits and compiler contracts still run in the sandbox. `commitAll` constructs `MemoryService` with `projectRoot = ctx.primaryProjectRoot ?? ctx.projectPath` and `dbPath = resolveDatabasePath(ctx.dbPath, muninnRoot)`, then calls `indexFilesIntoMuninn(memoryService, files, { projectRoot: ctx.projectPath })` — files are **scanned** from the sandbox but **persisted** to the primary database and attributed to the primary project record.
- **Consequences**:
  - *Positive*: durable symbol/memory state survives the sandbox lifecycle and grows across iterations; consistent with AC-2.1 (project-scoped DB) and AC-2.3 (explicit `dbPath` honored); a single path-resolution convention (`resolveDatabasePath`) is shared by both `CycleEngine` and `commitAll`.
  - *Negative*: indexing still runs during `COMMIT_ALL` (before promotion), so a failed or aborted promotion can leave "phantom" entities for code that never landed in the primary tree — accepted for now (the zombie pruning in `indexFilesIntoMuninn` only removes entities for files it re-scans), with a follow-up to prune by sandbox iteration or move indexing post-promotion. A non-sandbox run now resolves the DB via git-root detection rather than `projectPath`, which is more AC-2.1-correct but changes behavior when `--project` is a subdirectory of a larger repository.

---

## ADR-21: Decoupled Multi-Agent Runtime Architecture (IAgentRuntime)

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: Huginn previously hardcoded its execution loop directly against the OpenCode SDK (`opencode serve` + `@opencode-ai/sdk`). While Huginn's universal setup registry recognized other agents (Claude Code, OpenAI Codex, OMP, Command Code, Qwen) for MCP config and rules injection, Huginn could not actually execute tasks using any runtime other than OpenCode. Developers with active subscriptions to Claude Code, Codex, or local tools (OMP, Qwen) were locked out of running Huginn with their preferred AI agents.
- **Decision**: Introduce a Ports & Adapters abstraction layer:
  1. Define `IAgentRuntime` and `IAgentSession` interfaces in `src/engine/agent/types.ts` abstracting process lifecycle, model discovery, MCP queries, and execution (`prompt`, `runCommand`, `abort`).
  2. Implement concrete runtime adapters:
     - `OpencodeRuntimeAdapter`: Wraps OpenCode daemon and SDK.
     - `ClaudeRuntimeAdapter`: Connects to Claude Code CLI / stdio.
     - `CodexRuntimeAdapter`: Connects to OpenAI Codex CLI.
     - `OmpRuntimeAdapter`: Connects to Oh My Pi (`omp`) CLI.
     - `CommandCodeRuntimeAdapter`: Connects to Command Code CLI.
     - `QwenRuntimeAdapter`: Connects to Qwen Code CLI.
     - `GenericSubprocessRuntimeAdapter`: Configurable stdio JSON-RPC adapter for Kimi, Pi, and custom agents.
  3. Route `CycleEngine` and `LiveEngine` to talk to the configured `IAgentRuntime` rather than concrete `OpencodeClient`.
  4. Allow runtime selection via CLI (`--agent <id>`), project config (`.huginn/config.json`), user config (`~/.huginn/config.json`), or auto-detection of available binaries on `PATH`.
  5. Enable in-session runtime switching via `/agent <id>` in the live console.
- **Consequences**:
  - *Positive*: True agent agnosticism; zero vendor lock-in; developers can run Huginn with Claude Code, OpenCode, Codex, or OMP interchangeably; clean test mocking via fake runtime adapters.
  - *Negative*: Subprocess communication with external agent CLIs requires robust streaming parsers and process signal handling.

---

## ADR-22: Fullscreen Terminal UI with Alternate Screen Buffer & Responsive Viewport

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: Huginn's Ink-based TUI currently renders inline into standard stdout. Because startup banners and server logs are dumped prior to Ink mounting, the terminal scrollback buffer becomes polluted with 25+ lines of logs. Any mouse wheel or touchpad scrolling within the TUI overflows into the host terminal emulator history, destroying immersion and making the UI feel "without a life of its own" compared to tools like OpenCode, lazygit, or vim. Furthermore, card heights were hardcoded to fixed line limits (`VISIBLE_CHAT_LINES = 12; VISIBLE_STREAM_LINES = 8;`), failing to adapt to terminal window resizing.
- **Decision**:
  1. Enter Alternate Screen Buffer (`\x1b[?1049h\x1b[H`) upon TUI initialization and restore primary buffer (`\x1b[?1049l\x1b[?25h`) on exit or signal termination. To eliminate the risk of leaving the terminal cursor hidden upon abrupt process termination, register `\x1b[?1049l\x1b[?25h` directly in a synchronous `process.on('exit')` hook as well as in `try...finally`.
  2. Implement `useTerminalSize()` reacting to `process.stdout.on("resize")` to dynamically calculate viewport bounds (`rows` and `columns`).
  3. Scale card dimensions dynamically so chat, stream, and logs occupy 100% of available screen height without vertical clipping or overflow.
  4. Intercept `console.log`, `console.warn`, and `console.error` via `patchConsole()` while the TUI is active, piping messages into an internal ring-buffer drawer / event stream instead of writing to stdout, preventing screen tearing in the alternate screen.
  5. Trap mouse and keyboard scrolling within the focused container so terminal scrollback never leaks.
  6. Batch and throttle high-frequency stream events (`phaseStream`) using a 60ms flush interval and a 1,000-line ring buffer to protect Ink rendering performance from model token flooding.
- **Consequences**:
  - *Positive*: Immersive desktop-grade terminal UX on par with OpenCode, vim, and gentle-ai; responsive resizing; clean exit leaving the developer's console immaculate and cursor restored.
  - *Negative*: Ink in alternate screen mode requires strict lifecycle cleanup guards to ensure terminal escape sequences are always restored even upon unhandled rejections.

---

## ADR-23: Interactive Model Selection, Provider Auto-Discovery & In-Session Switching

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: Huginn previously hardcoded fallbacks to `anthropic/claude-opus-4-5` (thinker) and `opencode/gpt-5.1-codex` (executor). If a user launched `huginn` without these specific models authenticated in OpenCode, Huginn printed warning messages and proceeded to fail at runtime. Users had no interactive way to browse available models or select their active models.
- **Decision**:
  1. Active runtime queries its provider/model catalog (`runtime.getAvailableModels()`).
  2. If thinker or executor models are unconfigured or invalid, Huginn presents an interactive terminal selector (arrow keys + search filter + enter).
  3. Provide an explicit *"Save as default? (Project / Global / Session only)"* prompt upon selection.
  4. Expose `/models` or `/model <thinker> [executor]` slash command inside Live TUI to switch models on the fly without session interruption.
- **Consequences**:
  - *Positive*: Frictionless onboarding; zero cryptic provider warnings on clean installs; seamless switching between lightweight models (for simple edits) and frontier thinker models (for architecture/fixes).
  - *Negative*: Model catalogs must be cached or queried asynchronously with fallback handling when agent runtimes are offline.

---

## ADR-24: Unified Multi-MCP Status Monitoring & Extensible Skills System

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: Modern agent environments heavily utilize the Model Context Protocol (MCP) and custom project skills. Huginn previously provided zero visual feedback on MCP server health or tool availability. Additionally, live mode only supported `/draft`, `/go`, `/quit`, and `/abort`, with no support for project-specific skills or helper commands.
- **Decision**:
  1. Add a real-time MCP status indicator to the TUI header: `MCP: 🟢 <count> active (<tools> tools)`.
  2. Enforce a strict non-blocking timeout (1500 ms) via `Promise.race` on `runtime.getMcpStatus()` to guarantee that slow or hanging external MCP servers never block Ink rendering or freeze the TUI.
  3. Provide an interactive `/mcp` command displaying connected servers (Muninn + external MCPs), registered tool definitions, and transport latency.
  4. Load project-level MCP configurations from `.huginn/mcp.json` automatically.
  5. Implement dynamic skills discovery scanning `.huginn/skills/*.md`.
  6. Expand live slash commands: `/help`, `/agent`, `/models`, `/mcp`, `/skills`, `/status`, `/clear`, `/draft`, `/quit`.
- **Consequences**:
  - *Positive*: Complete observability into agent tools and MCP state; modular workflow extensibility through markdown skills; standard, discoverable CLI/TUI command interface; guaranteed responsive UI regardless of remote MCP latency.
  - *Negative*: Periodic MCP health probing requires non-blocking timeout handling so a sluggish third-party MCP server never freezes the UI.

---

## ADR-25: File-Based Skills Loader Security Boundary & Shared Terminal-Sanitization Module

- **Date**: 2026-09-27
- **Status**: Accepted
- **Context**: ADR-24 introduced skills discovery and the Live slash-command set; this ADR records the security boundary and code organisation that actually shipped. Two forces shaped it. First, skills are plain markdown files read from the checked-out repository — i.e. from untrusted input — so a hostile repo could otherwise exfiltrate files via a symlinked `.opencode/skills` directory, read an unbounded or non-regular file, pollute `Object.prototype` through frontmatter keys, or emit ANSI/C1 escape sequences that hijack the terminal. Second, `sanitizeTerminalText` lived inside `src/engine/agent/mcpConfig.ts`, an MCP-subsystem module, which meant the new skills loader and the TUI modals would either import a subsystem-specific module or duplicate the primitive. The Live input bar also silently forwarded any unrecognised `/…` string to the model, so a mistyped command produced a confusing model reply instead of an error.
- **Decision**:
   1. **Skills as data (`src/engine/skills/`)**: discover `*.md` skills in `<project>/.huginn/skills/` then `<project>/.opencode/skills/` (first-seen id wins, so `.huginn` takes precedence), parse a deliberately flat YAML subset (`name`/`title`, `description`/`desc`, `triggers` as a dash list / `[a, b]` flow list / comma list, inline `#` comments stripped), fall back to basename + first paragraph when no frontmatter is present, and append three built-in skills (`audit`, `refactor`, `explain`) unless shadowed (`includeBuiltins`).
   2. **Hardened loader boundary**: reject symlinked / non-directory scan roots (`lstatSync` + `realpathSync` containment under the project root), read files through an `O_NOFOLLOW` fd with a 1 MB cap (`readSkillFile`), skip prototype-pollution keys (`__proto__`, `constructor`, `prototype`), and run every parsed field through the shared sanitizer.
   3. **Relocate the sanitizer**: move `sanitizeTerminalText` out of `src/engine/agent/mcpConfig.ts` into the neutral shared module `src/util/text.ts` and broaden the control-character class to include the C1 range (`\x7F–\x9F`, covering 8-bit CSI/DCS/OSC introducers). Every consumer (TUI, agent adapters, MCP monitor, skills loader) imports it from `src/util/text.js`.
   4. **Always-on slash dispatcher**: the Live input bar intercepts `/<…>` before model dispatch; unknown commands are answered with a system message and never forwarded. `/quit` and `/abort` require a two-step confirmation.
   5. **Engine support (`LiveEngine`)**: add `switchRuntime(agentId)` (fails closed when `isAvailable()` is false, aborts the old session, re-seeds the architect system prompt on the next prompt), `getDiagnostics()`, an injectable `runtimeFactory` option for tests, and expose `runtime` via a public getter over a private field.
- **Consequences**:
   - *Positive*: projects gain reusable, version-controlled prompt fragments with zero source edits; the single shared sanitizer removes copy-paste drift and now also neutralises C1 escape sequences; a hostile repository cannot escape the project tree, read unbounded files, or inject terminal escapes through skills; command typos surface an actionable error instead of reaching the model; runtime and model switching work in-session.
   - *Negative*: the flat frontmatter parser intentionally does not support block scalars, nested keys or multi-line values (they degrade to plain text), so authors must keep metadata on one line; moving the sanitizer is a breaking import-path change for any out-of-tree consumer; the loader's containment checks reject a legitimate symlinked skill directory, which is the deliberate fail-closed trade-off.

---

## ADR-26: Guided `huginn init` Wizard, Two-Tier Help Hierarchy & Greenfield Onboarding

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: Huginn's first-run experience was hostile. A developer who cloned a repo and typed `huginn` got either a raw live-mode launch against an unconfigured project or the terse failure `"<path>" is not a git repository.`, with no path to the agent/model/MCP configuration the engine needs; `huginn --help` dumped one flat ~90-line string mixing core commands with installer internals, model-resolution precedence and TUI flags, so the five commands a newcomer needs were indistinguishable from advanced ones. Two forces shaped this iteration. First, every primitive the onboarding needs already existed and was already hardened — `setup()`/`handleSetupCommand` (Muninn MCP + rules registration, idempotent, `--force` aware), `saveUserConfig` (atomic, `0o700`/`0o600`, symlink-safe, unknown-key preserving), `detectAvailableAgents` (PATH scan for all `AGENT_TARGETS`), `getOpencodeConfigDir`, and `promptYesNo` (returns its fallback when `CI` is set or stdio is not a TTY). Second, the CLI is a live-first dispatcher (REQ-14.4): an unknown or absent subcommand is *already* meaningful input (a free-text idea), so onboarding could not simply hijack the no-argument case without breaking `huginn "crear módulo de pagos"`.
- **Decision**:
  1. **`huginn init` is a thin orchestrator (`src/commands/init.ts`), not new I/O.** The wizard adds exactly two new primitives — `existsSync` probes (`.git`, lockfiles) and sectioned `console.log` output — and delegates everything else: agent discovery to `detectAvailableAgents`, MCP registration to `handleSetupCommand` (`--agent/--project/--home/--opencode-config-dir/--force`), and persistence to `saveUserConfig(projectPath, { agent, thinker, executor })`. No new config format, no second MCP writer, no re-implementation of the atomic write, and therefore no way for the wizard and the rest of the CLI to drift apart.
  2. **Six reported steps**: (1) git detection via `existsSync(join(project, ".git"))` — informational only, it prints a `git init` tip and never fails; (2) package manager via the exported pure helper `detectPackageManager(projectPath)` (bun.lock/bun.lockb → bun, pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm, `package.json` alone → npm, nothing → "unknown"; bun wins when several lockfiles coexist); (3) the `detectAvailableAgents` scan, listing the four primary CLIs (opencode, claude, codex, omp) first and then the remaining targets, where available entries show a green `✔` and unavailable ones are dimmed; (4) agent + thinker/executor selection; (5) `huginn setup` for the chosen agent; (6) the initial `.huginn/config.json`. Every step's finding is mirrored into the returned `InitReport`.
  3. **Agent precedence inside the wizard is flag → first detected → `DEFAULT_AGENT`.** `--agent` short-circuits detection; otherwise the default is the first `available: true` entry of the **same primary-first list the wizard just printed** (`PRIMARY_AGENT_CLIS` = opencode, claude, codex, omp, then the remaining registry targets), so the pre-selected agent can never contradict the first line of the section, falling back to `DEFAULT_AGENT` (`opencode`) when nothing is installed. This keeps the wizard's terminal detection step consistent with `resolveAgent`'s (same first-available-agent semantics and opencode fallback), minus the config/env layers that don't exist yet on a greenfield run; the one deliberate difference is the primary-first order, chosen so display and default agree. An unusable `--agent` is the one hard error: it prints the supported targets, sets `process.exitCode = 1` and writes nothing.
  4. **Non-blocking by construction.** The wizard prompts only when stdio is a TTY, `CI` is unset and `--yes` was not passed; otherwise it silently takes the flags and the documented defaults (`DEFAULT_THINKER_MODEL`/`DEFAULT_EXECUTOR_MODEL`). The one TTY-only question is overwriting an existing `.huginn/config.json` (skipped by `--force`), whose `promptYesNo` fallback is `true`, so a non-interactive re-run stays idempotent. `--skip-setup` skips step 5 but still writes the config. Handlers use `process.exitCode`, never `process.exit`.
  5. **Two-tier help with a `--all` escape hatch.** `usageCore()` is the new default for `huginn --help`: usage line, the five Core commands (`live`, `run`, `init`, `setup`, `doctor`), four copy-pasteable examples, the common flags and a single "run `huginn --help --all` for advanced options" pointer. `usage()` remains the single full reference (`huginn --help --all` prints it) — byte-compatible with the contract `test/muninn/commands.test.ts` asserts on — so scripts, docs and muscle memory keep working, and there is no second alias to drift: a drift-guard test asserts every command token of the Core list also appears in the full reference. `huginn --help --all`, `huginn help --all` print the reference; `huginn init --help` prints the wizard's own usage. `--all` and `--skip-setup` were added to `BOOLEAN_FLAGS` so `parseArgs` never swallows the following argument.
  6. **Greenfield detection keys off the absence of `<project>/.huginn/`.** That directory is created by *every* stateful huginn command (`init`, `config set`, `memory init`, live/worktree state), so its absence is the cheapest reliable "this repository has never run huginn" signal — no lock files, no version marker and no read of `.git` needed, and a repo that has ever run huginn keeps the documented live-first behavior. `isGreenfieldLaunch(projectPath)` is the pure predicate; `shouldLaunchInit(args, projectPath)` adds the routing rule (no subcommand at all, no free-text idea positional, no work/mode flag — only the benign `--project`/`--home`/`--opencode-config-dir`/`--yes` may accompany it — and no `--help`), so `huginn "my idea"` and `huginn run --project …` are untouched. Onboarding therefore intercepts **only a bare launch**: a flag-only invocation such as `huginn --headless`, `huginn --resume` or `huginn --thinker X` retains normal routing, because the caller's explicit flags must win over first-run guidance. `main()` routes a qualifying bare invocation to the wizard on an interactive TTY, or prints a four-line pointer to `huginn init` / `huginn --help` when non-interactive — guidance printed on **stdout with exit code 0**, because an unconfigured repository is not an error.
  7. **Hermetic testability via `InitDeps`.** `handleInitCommand(args, deps?)` accepts injectable `projectPath`, `homeDir`, `env`, `isTTY`, `stdin`, `stdout`, `detectAgents`, `runSetup`, `promptText`, `promptChoice`, `confirm`, `log` and `error`, each defaulting to the real primitive. The `env`/`stdin`/`stdout` triple is the *same* seam the prompts read (`promptLine`/`promptYesNo` in `src/setup/install.ts` take it as an optional third argument), so the wizard decides interactivity and the prompt helpers consume answers from identical values — no test has to swap `process.stdin`/`process.stdout` or mutate `process.env.CI`. Tests pin `--project/--home/--opencode-config-dir` to `mkdtemp` directories, inject a fixed detection list, fake TTY streams and a recording `runSetup` (returning a `SetupReport`, or `undefined` for the failure path), and therefore assert the wizard's decisions and emitted config without touching `~`, the real opencode config or the terminal; two integration cases leave `runSetup` real to prove the delegation actually writes the portable MCP fallback inside the injected temp home.
- **Consequences**:
  - *Positive*: a fresh clone gets a discoverable five-minute onboarding (`huginn init`, or just `huginn` on a TTY) that ends with a working agent, models and Muninn MCP registration; `huginn --help` is now scannable in one screen while `--all` preserves the full reference; no raw "not a git repository" failure or missing-template warning dump on first contact; the wizard cannot drift from `setup`/`config` semantics because it owns no I/O; CI and piped usage can never hang on a prompt; and the whole wizard is exercised safely in-process by `test/commands/init.test.ts`.
  - *Negative*: the wizard's default agent now follows `PRIMARY_AGENT_CLIS` (opencode first) rather than `AGENT_TARGETS`/`AGENT_REGISTRY` order, so it can disagree with `resolveAgent`'s terminal first-detected step on a machine where several CLIs are installed — the wizard's choice is display-consistent, the engine's is registry-consistent, and only the wizard order is the deliberate one (engine behavior is unchanged); greenfield detection based on `.huginn/` means a repository that previously ran only a huginn command which never created that directory is still treated as fresh (and, conversely, an empty `.huginn/` directory suppresses onboarding); the wizard writes project-local state (`AGENTS.md`/`CLAUDE.md`, `.mcp.json`, `.cursor/…`) through the real `huginn setup`, so onboarding is not purely additive — `--skip-setup` exists for that case; a failed MCP registration still writes the project config and then reports `process.exitCode = 1`, so a caller must inspect the exit code rather than assume a written config means fully-onboarded; and the two help surfaces (`usageCore`/`usage`) still have to be kept in sync by hand, now guarded by an explicit drift test rather than a duplicated alias.

---

## ADR-27: Connected-Provider Model Discovery with CLI Fallback & Native Model Selection

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: A hand-driven verification on this machine proved the Phase 5 model path (ADR-23) non-functional in practice. `OpencodeRuntimeAdapter.getAvailableModels()` reads `provider.list().all` — the entire models.dev catalog — and returns **8 195** models across 226 providers, where only **581** belong to the 10 providers in the response's `connected` array (byte-identical to the `opencode models` CLI output). The method then catches *any* throw and returns two hardcoded models (`anthropic/claude-opus-4-5`, `opencode/gpt-5.1-codex`) that happen to equal `DEFAULT_THINKER_MODEL`/`DEFAULT_EXECUTOR_MODEL`, which both hides real failure and defeats the `cfg.chooseModel` auto-onboarding gate in `src/cli.ts`. Every other adapter is worse: `CommandCodeRuntimeAdapter` returns a single literal `commandcode/default` while its real CLI lists **82** models; `claude`/`codex`/`qwen`/`omp`/`gemini` return small static arrays, one of them (`codex`) even when the binary is absent. Separately, `validateModels` (`src/cli.ts`) reads `.all` from `config.providers()`, which returns `{ providers, default }`, so its `known` set is always empty and it warns "provider not in the configured provider list" for both roles on every opencode run. Finally, the selected model is forwarded to subprocess CLIs only as a `HUGINN_MODEL` environment variable, which none of those CLIs read, so choosing a model silently has no effect.
- **Decision**:
  1. **opencode discovery filters to `connected`.** `getAvailableModels()` intersects `provider.list().all` with the response's `connected` ids before flattening models, so only models the user can actually run are offered (581 here, not 8 195). Flattened models always carry the provider **id** — never the provider's display name — so the picker badge and filtering are identical whichever discovery path answered.
  2. **CLI fallback instead of fake defaults.** When the SDK is unreachable, discovery parses `opencode models` (one `provider/model` per line). On failure or an empty result the method returns an explicit empty/error signal — never a hardcoded catalog — so the picker and the pre-flight gate react honestly.
  3. **Real catalog per runtime.** `CommandCodeRuntimeAdapter` parses `commandcode --list-models` (group headings, `id` + description rows, ignore the trailing help/docs footer); `omp` parses `omp models` (`<provider> (<count>)` sections + box-drawing table, ids `provider/model`); `agy` parses `agy models` (`id<TAB>name` TSV, provider from the id prefix else the runtime label); other generic adapters gain a declarative per-runtime listing command where the CLI supports one, and return an empty-with-reason result where it does not. The reason travels on an optional `getModelCatalog(): Promise<{ models, reason? }>` (`ModelCatalog`) so "no listing mechanism", "the CLI failed" (missing binary / non-zero exit with the first stderr line / timeout / empty output) and "nothing discovered" stay distinguishable, and `getAvailableModels()` is a thin projection of it. Verified listing mechanisms and counts on the reference machine: `opencode` (SDK `provider.list().connected` + `opencode models` fallback, **581**), `commandcode` (`--list-models`, **82**), `omp` (`models`, **192**), `agy` (`models`, **14**); `claude`, `qwen`, `gemini`, `kimi`, `pi`, `cursor`, `windsurf` and `codex` expose none and return `[]` with a reason. Flattened models carry the **provider id**, with one deliberate exception: a Command Code bare id (no `/`) has no provider prefix, so it carries the CLI's own group heading (`Anthropic`, `OpenAI`, …). A selected model is forwarded verbatim through the runtime's native flag — including bare ids, which the picker accepts from the catalog and (for runtimes that expose them) as free text.
  4. **Native model forwarding.** Subprocess runtimes pass the selected model through their documented flag (`--model`/`-m`); `HUGINN_MODEL` is retained only as an extra hint. When the base argv already carries that flag (`--flag old` or `--flag=old`) its **value** is replaced with the user's selection, so a configured preset can never silently swallow the choice.
  5. **Correct provider validation.** `validateModels` reads `config.providers().providers`.
  6. **Honest picker.** `ModelPickerModal` no longer substitutes `DEFAULT_FALLBACK_MODELS` for an empty or failed discovery; it shows a distinct empty state with free-text entry, surfaces the (sanitized) error, and renders large catalogs incrementally.
  7. **Realistic tests.** Discovery is verified against a local HTTP server serving a captured `GET /provider` payload and against captured `--list-models`/`models` fixtures, not hand-written mocks alone.
- **Consequences**:
  - *Positive*: the picker shows models the user can actually run; a runtime failure is visible instead of masked by a plausible-looking fake list; model selection actually takes effect; the auto-onboarding gate can finally fire on a real catalog.
  - *Negative*: the connected set is host-specific, so the offered catalog changes with the user's provider auth/config (correct, but non-deterministic across machines); the `opencode models` fallback and `commandcode --list-models` parsers are coupled to human-readable CLI output that may change between CLI versions and therefore need fixture-based tests and tolerant parsing; and returning an empty catalog where a CLI has no listing mechanism means those runtimes rely on free-text model ids.

---

## ADR-28: Command Registry as the Single Source of Truth for Dispatch, Help & Autocomplete

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: The Live input bar handles `/…` input through a linear `if`-chain inside `submit()` (`src/tui/LiveDashboard.tsx`), while `HelpModal.tsx` exports a separate, hand-maintained `SLASH_COMMANDS` array for display. The two have already drifted: the cheat sheet omits `/model`, `/models <t> <e>` and `/agent <id>` as distinct entries. Typing `/` does nothing interactive — the character is appended as plain text — so a user must already know the command set. Up/down arrows are deliberately trapped while typing (to prevent terminal scroll leakage) and `Tab` is bound to focus-toggling, so an autocomplete overlay must intercept those keys before they reach the existing handlers.
- **Decision**:
  1. **One registry.** A single exported command registry (`id`, `aliases`, `argHint`, `description`, `category`) is the source of truth. `submit()` dispatches by looking the input up in the registry; `HelpModal` and the new palette both render from it.
  2. **Inline overlay.** Typing `/` at the start of the input opens a suggestion overlay rendered directly beneath the input row, filtered by id/alias substring as the user types; accepting inserts the command plus its argument hint.
  3. **Key precedence while open.** With the overlay visible, `↑`/`↓`/`j`/`k` move the highlight, `Tab` accepts, `Enter` submits/accepts, `Esc` dismisses — taking precedence over focus-toggle and scroll-trap *only* while open.
  4. **Bounded layout.** The overlay is height-capped (≤6 visible rows with scroll markers) and counted in the layout budget so chat/stream cards never overflow.
  5. **Drift guard.** A test asserts every command dispatched by `submit()` is present in the registry and vice versa, and that every Phase 5 command remains dispatchable.
- **Consequences**:
  - *Positive*: the UI can no longer advertise a command the dispatcher does not implement (or hide one it does); discoverability is intrinsic rather than documented in a modal; the two headers/help surfaces stop drifting.
  - *Negative*: `submit()`'s bespoke per-command argument parsing still lives in code (only the command *identity* is centralised), so a new command touches both the registry and its handler; and the overlay adds an input-mode to a view that already multiplexes modals, focus and scroll, which the key-precedence rules must keep unambiguous.

---

## ADR-29: ASCII Raven Identity Component for the TUI Header

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: Both TUI headers render an eagle emoji (`🦅 HUGINN` in `Dashboard.tsx`, `🦅 HUGINN LIVE` in `LiveDashboard.tsx`). Huginn is a raven (the `banner.ts` CLI art and the Grímnismál quote already say so), and a single emoji is not identity — the user reported the interface has "no personality". The ASCII wordmark already exists in `src/banner.ts` but is CLI-only and unused by the TUI.
- **Decision**:
  1. **One brand component** (e.g. `src/tui/RavenHeader`) renders an ASCII raven mark alongside the `HUGINN` wordmark and is used by both dashboards, so the headers cannot diverge.
  2. **No eagle glyph** remains anywhere in the source.
  3. **Graceful degradation**: on narrow terminals the mark collapses to the wordmark only, and its row cost is part of the layout budget so the chat/stream viewport never collapses.
  4. **Presence over decoration**: the header also carries live, useful context (runtime, thinker/executor, project, truthful MCP badge), so the personality is reinforced by meaningful feedback rather than a lone glyph.
- **Consequences**:
  - *Positive*: the interface reads as Huginn; the CLI and TUI share one visual identity; the header becomes informative rather than decorative.
  - *Negative*: ASCII art is wider than an emoji, so narrow-terminal and low-row rendering need explicit fallbacks and must be covered by tests.

---

## ADR-30: Honest MCP Status & Hardened MCP Server stdio Lifecycle

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: The user reported Muninn "was connected and then suddenly disconnected". Investigation showed Huginn holds no MCP client at all: the agent CLI spawns `huginn mcp run`, which serves JSON-RPC over a `StdioServerTransport`. Its lifecycle resolves on `transport.onclose` or a signal, but `StdioServerTransport.start()` only subscribes to `'data'`/`'error'` — never stdin `'end'`/`'close'` — so a parent disconnect is never observed; `send()` writes to `process.stdout`, whose `'error'` (EPIPE) is unhandled and crashes the process; `server.onerror` is never assigned, so protocol errors are discarded; and `send()` waits on a `'drain'` that a broken pipe never emits, hanging the request. On the display side, `GenericSubprocessRuntimeAdapter.getMcpStatus()` derives status from *config files* and hardcodes `status: "connected"`, so for every subprocess runtime the badge stays `MCP: 🟢 n active` after the server has died, while opencode's real probe converts a failure into an indistinguishable `⚪ 0 active`. Nothing detects the drop, and nothing can recover it.
- **Decision**:
  1. **Never fabricate status.** Config-discovered servers are reported as `unknown` (rendered distinctly); only a real probe (opencode) reports `connected`/`error`.
  2. **Propagate errors.** A throwing `getMcpStatus()` yields `degraded: true` plus the sanitized error, so `formatMcpBadge` shows `MCP: 🟡 error` rather than a neutral empty state.
  3. **Harden the stdio server**: install a `process.stdout` `'error'` handler (EPIPE-safe), bridge stdin `'end'`/`'close'` to `transport.onclose`, assign `server.onerror` to log, and bound `send()` so a broken pipe fails the pending request.
  4. **Supervise the opencode daemon** after the initial health check: detect mid-session exit, log it, and attempt recovery so a dead daemon is neither silent nor permanent.
  5. **Surface Muninn DB failures**: `getDiagnostics`/`/status` distinguish "unavailable/error" from "empty", and best-effort indexing failures are logged rather than swallowed.
- **Consequences**:
  - *Positive*: the badge can no longer claim a dead server is healthy; a transient daemon death is visible and recoverable; the MCP server exits cleanly with its parent instead of hanging or crashing with an unhandled EPIPE.
  - *Negative*: reporting `unknown` for config-only servers is a visible regression from the previous always-green badge (intentional truthfulness); daemon supervision adds a poll/retry loop that must not leak timers or fight normal shutdown.

---

## ADR-31: Per-Agent MCP Enumeration via the Agent's Own CLI Listing

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: Phase 6 made MCP status truthful but still *uninformative*: a live session showed `MCP: ⚪ 5 unverified`, an unattributed bare number that named nothing and could print `undefined` (`formatMcpBadge` interpolated `report.totalTools` unguarded). The deeper problem was framing: Huginn holds no MCP client — the **active agent** owns every connection — yet the UI never said so, so a user reasonably concluded Huginn's MCP was broken (and that Muninn was too, though a real MCP handshake proved 7 tools and working `muninn_save`/`search`/`stats`). Investigation showed the information was available all along: **every supported CLI can enumerate its own servers** — `opencode mcp list` (3 servers, `connected`, with command), `agy mcp list` (5-row TSV with `enabled`), `claude mcp list` (health-checks), `qwen mcp list`, `commandcode mcp list` (scope/auth columns) — none of which Huginn used.
- **Decision**:
  1. **Ask the agent.** `IAgentRuntime` gains `listMcpServers(): Promise<McpServerListing[]>`; runtimes with a listing command use it (parsers exported, fixture-tested against captured output), and runtimes without one fall back to config-file discovery with `status: "unknown"`.
  2. **Map statuses honestly.** `connected`/`✔` → probed-and-live; `enabled`/`configured` → configured-but-unprobed; `disabled`/`pending` → as reported; anything unrecognised → `unknown`. Only `connected` may be described as live.
  3. **Attribute everything.** The badge names its source (`MCP: 🟢 3 connected · opencode`), the `/mcp` panel states that the servers belong to the active agent and must be changed there, and every numeric field is nullish-coalesced so `undefined`/`NaN` cannot reach the screen.
  4. **Show detail where it exists** (`commandcode` scope/auth, `claude`/`qwen` health) and say so plainly when it does not.
- **Consequences**:
  - *Positive*: the user finally sees *which* servers the active agent has and how they stand; "Huginn's MCP is broken" becomes "agent X has these servers, change them in X"; the `undefined` class of bug is closed and guarded.
  - *Negative*: enumeration spawns a CLI per poll, and `claude mcp list` performs a health check, so the call must be bounded/cached and must not run on the render path; parsers are coupled to human-readable CLI output and need fixture tests.

---

## ADR-32: Interactive Runtime Picker

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: `/agent` only *listed* runtimes and printed "run `/agent <id>` to switch", so selecting a runtime meant memorising its id — the user's "no me deja seleccionar en agy" (switching itself works: `switchRuntime("agy")` succeeds and yields 14 models).
- **Decision**: `/agent` with no argument opens an interactive picker over `AGENT_TARGETS` showing availability, the active entry and detected paths; `↑`/`↓`/`j`/`k` navigate, `Enter` switches (failing closed with an actionable message when unavailable), `Esc` cancels. `/agent <id>` keeps working.
- **Consequences**:
  - *Positive*: runtimes become discoverable like models; no memorised ids.
  - *Negative*: another modal state in a view that already multiplexes palette, modals and scroll — key precedence must stay explicit.

---

## ADR-33: Composer Input History & Presence

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: the composer had no recall of previous submissions (every other harness offers it) and visually lost to the surrounding panels, sitting unadorned at the bottom of a busy frame.
- **Decision**:
  1. **History**: `↑` recalls the previous submission of the session when the palette is closed and the draft is empty (or the caret is at the boundary), `↓` walks forward and ends at the empty draft; recalled drafts stay editable; the last ≥50 submissions are retained.
  2. **Presence**: the composer gets its own accent treatment (border/background and a clearer prompt glyph) so it reads as the primary affordance at 80×24.
  3. Existing palette `↑`/`↓` navigation and scroll bindings keep their current mode precedence.
- **Consequences**:
  - *Positive*: iterative prompting stops being retyping; the view finally shows where to type.
  - *Negative*: `↑`/`↓` now carry three meanings (palette, history, scroll) distinguished solely by mode, so the precedence rules and their tests are load-bearing.

---

## ADR-34: Honest Panels & Removing the Dead `gemini` Target

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: `REFINEMENT CONVERSATION` reads awkwardly for what is simply the conversation. The adjacent "THINKING & LIVE AGENT STREAM" panel assumes streaming reasoning, which most frontier/closed models increasingly withhold as anti-distillation, so it often renders as an empty box competing for rows. Separately, `gemini` is a dead agent target: its non-interactive form requires `gemini -p <arg>`, but the adapter passes no args and writes the prompt to stdin, so the CLI drops into interactive mode and hangs; the successor is Antigravity CLI (`agy`), already supported.
- **Decision**:
  1. Rename the panel to **`Conversation`** wherever rendered or documented.
  2. Make the agent-stream panel **adaptive**: it collapses (returning its rows to the conversation) when the agent has emitted no reasoning/stream content for the session, and expands when content arrives; it never renders as an empty bordered box.
  3. **Remove `gemini`** from `AGENT_TARGETS`/the registry and docs; a stored config naming a removed agent falls back to detection with a warning instead of throwing.
- **Consequences**:
  - *Positive*: the layout stops reserving space for output that no longer exists; the vocabulary matches reality; a broken target that would hang a run is gone.
  - *Negative*: removing a target is a (documented) breaking change for anyone who had `agent: "gemini"` persisted — handled by the warning-and-fallback path, not a crash; the adaptive panel adds a state transition that must not thrash the layout.

---

## ADR-35: Methodology Profiles — the Huginn Cycle plus SDD, ODD, RDD and Strict-TDD

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: the built-in workflow had no name and no alternative. The pipeline is already **data** (`PIPELINE: PipelineStep[]` in `cycle.ts`), and `mode` (`auto|supervised`) already demonstrates the pattern for a validated enum reachable from CLI flag, `UserConfig`, `sanitizeConfig` and the persisted state. The user asked whether the cycle has a formal name and whether SDD (Proposal→Spec→Design→Tasks→Apply→Verify→Archive), ODD (lightweight daily work), RDD (receipts) and Strict-TDD (frozen evidence) could be selectable, with the built-in cycle as the default differentiator.
- **Decision**:
  1. **Name**: the default pipeline is the **Huginn Cycle** (`profile: "huginn"`).
  2. **Surface**: `--profile <id>` on `run` and `live`, `UserConfig.profile`, `huginn config set --profile`, sanitized/validated like `mode`, defaulting to `huginn`.
  3. **Pipeline as data per profile**: each profile is a `PipelineStep[]` over the existing phase vocabulary, so `runPhase`/`runIteration` are untouched; `--only-phase` validation, the progress renderer and `PHASE_LABEL` derive from the active profile.
  4. **The profiles**: `huginn` (unchanged eight phases); `sdd` (proposal/spec → design → tasks → apply → verify → archive, gating against the spec artifacts); `odd` (execute → test-module → commit-all, no heavy gates); `rdd` (execute → test-module → validate-step emitting a frozen *receipt* the commit references → commit-all); `strict-tdd` (a failing-test step before execute, then execute, then the gates, with a **frozen worktree snapshot** recorded as evidence so "tests passed" cannot be hallucinated).
  5. **Announced & fail-closed**: the active profile appears in the header/`/status` and the CLI banner; a profile whose prompts are missing fails with an actionable message rather than silently degrading to `huginn`.
- **Consequences**:
  - *Positive*: the differentiator becomes a product surface — teams pick the rigour their project warrants, and Strict-TDD/RDD attack the "the agent claims the tests passed" failure mode with frozen snapshots rather than prose.
  - *Negative*: several lists duplicated today (`MAIN_PHASES`, `PHASE_LABEL`, `--only-phase` validation, `REQUIRED_TEMPLATES`) must become profile-aware, and every new phase id extends the closed `PhaseName` union — so profiles that only reorder/subset existing phases are cheap, while ones needing new artifacts (spec-first, receipts) are the real cost.

---

## ADR-36: Agent-Agnostic Question Protocol & Honest Decision UI

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: agent questions only ever surfaced on **opencode**, and only with `permissions: ask`: `subscribeToEvents` is installed by two `runtime.id === "opencode"` ternaries, and it is the sole producer of `kind: "permission"`/`"question"` requests. Every subprocess runtime closes stdin after the prompt, so it cannot ask mid-turn at all. Worse, even on opencode the `DecisionModal` ignores `questionItems` — it offers only "accept the recommended option" or "reject", and any other keypress is swallowed silently, so a multi-option question is effectively unanswerable. The user requires questions to work for **all** supported agents.
- **Decision**:
  1. **A marked block any agent can emit**: `<<<HUGINN_QUESTION>>>…<<<END_HUGINN_QUESTION>>>` containing `QuestionItem[]` JSON. Huginn parses it from the agent's output, strips it from the displayed text, presents it through the same `DecisionRequest` pipeline, and resumes the session in a follow-up turn carrying the chosen answer(s). This needs no protocol support from the CLI.
  2. **opencode keeps its native channel**; both producers yield the same request shape.
  3. **Real options in the modal**: one row per option with description, numeric and `↑`/`↓` selection, `Enter` to confirm, multi-select when `multiple`, free-text when `custom`; every keypress gives feedback and nothing is silently swallowed.
  4. **Fail-closed and visible**: an unparseable block is surfaced (sanitized) rather than dropped, an empty option list degrades to free text, and a pending question that times out aborts the turn with a message instead of hanging.
- **Consequences**:
  - *Positive*: clarifying questions become a first-class, agent-independent interaction; the "recommended option or nothing" dead end is removed; a hung question can no longer stall a run silently.
  - *Negative*: the block protocol relies on the agent honouring an output convention (it is a contract, not a transport), so it must be documented for users and injected into the agent rules; parsing adversarial output requires the same sanitization discipline as the CLI parsers.

---

## ADR-37: Muninn Provisioning Across Agents & Agent-Independent Memory

- **Date**: 2026-09-28
- **Status**: Accepted
- **Context**: Muninn is Huginn's primary brain and the strongest reason to use it, yet provisioning is partial by accident: the MCP server is registered for one target at a time, a live session showed Muninn absent from the active agent's config (opencode listed `playwright/codegraph/engram`, not muninn) while the user concluded memory was broken — even though a real MCP handshake proved all 7 tools working. Memory's value compounds only if it is **independent of whichever agent is driving**, and available to every agent the user actually has.
- **Decision**:
  1. **Project-scoped, never agent-scoped**: the database stays `<project>/.huginn/muninn.db` (per ADR-20); the engine must never key memory by `runtime.id`, so switching runtime reads and writes the same brain. Asserted by a test that switches runtime mid-session and observes identical stats.
  2. **The user chooses the fleet**: provisioning lists the **installed** agents (`detectAvailableAgents`), marks which already register Muninn, and offers all-installed or a per-agent selection; non-interactive `--agent <id>` (repeatable) and `--all`; uninstalled agents are skipped with a note.
  3. **Native `mcp add` first**: `opencode`/`claude`/`qwen`/`agy`/`commandcode` all expose an idempotent `mcp add`, so provisioning prefers the agent's own command and otherwise uses the existing hardened integrator (`registerMcpForTarget`). Existing registrations are no-ops; unparseable configs are reported, never silently rewritten.
  4. **Visible matrix**: `huginn doctor` and `/mcp` render agent × (installed · Muninn registered · source) with the exact fix command.
  5. **Profiles lean on the brain**: every auditing/verifying profile — `huginn` above all — mandates `muninn_context`/`muninn_inspect_symbol` before changes and `muninn_verify_contract` before final code, and no gate passes on a claim that contradicting Muninn evidence refutes.
  6. **Safe and reviewable**: idempotent, non-destructive, with a report/`--dry-run` mode enumerating exactly what would change.
- **Consequences**:
  - *Positive*: memory becomes a durable asset that outlives any individual agent and any switch between them; the user sees exactly which agents share the brain and can fix gaps in one command; the `huginn` profile's quality claims get an independent evidence source.
  - *Negative*: provisioning touches many third-party configs, so it must be conservative (idempotent, key-preserving, dry-runnable) and its native-`mcp add` calls add a dependency on each CLI's argument contract, which needs fixture/behaviour tests to stay honest.
