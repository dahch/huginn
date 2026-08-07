# Huginn — Architecture Decision Records

These ADRs are inferred from the codebase as it exists today (no git history is
available in this working copy). Each record states the context, the decision
as implemented, and the consequences — including the alternatives that the code
structure rules out or deliberately avoids. They are ordered by how central the
decision is to the design.

---

## ADR-1: Pipeline-as-data over imperative control flow

- **Date**: 2026-08-07 (inferred — no history available)
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
  `src/engine/types.ts` are the single source of truth for order, and the
  `PhasesTable` in the TUI and the progress markdown renderer both re-derive
  from it.
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
