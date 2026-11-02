# Huginn — Agent & Command Inventory

This file documents the roles and step instructions **huginn composes and drives itself**, plus what
a developer working *on* huginn needs to know to run, test, and debug it.

The definitions live in `src/engine/steps/instructions.ts` (the inlined role texts and task bodies),
are composed per step by `src/engine/steps/prompts.ts` over the bounded context helpers in
`src/engine/steps/context.ts`, and are driven by `src/engine/phases.ts` + `src/engine/cycle.ts`.

> There is **nothing to install**. The old opencode subagents/slash commands, the `templates/` tree,
> `scripts/postinstall.ts` and `HUGINN_TEMPLATES_DIR` are gone; `huginn install` prints a
> compatibility notice and exits 0. The only agent huginn ever asks opencode for by name is the
> built-in `build` agent — used by `EXECUTE` and the **application** half of every `FIX_*` phase so
> the SDK session keeps that agent's tools. The architect's `DIAGNOSE` turn is a plain, read-only
> prompt. Every other step is a plain prompt, which is what makes a subprocess runtime
> (Claude Code, Codex, …) behave identically.

## 1. The five embedded roles

Each role is one inlined string. They are read from memory, never from disk, so a bundled
`dist/cli.js` and a source checkout behave the same — and none of them carries opencode frontmatter
permissions any more: what a role may touch is decided by the runtime, and *read-only-ness* is
enforced by huginn (see §4).

### `spec-auditor` (`ROLE_SPEC_AUDITOR`)
- **Purpose**: Contract auditor. Detects **semantic deviation** between `spec.md` and the
  implementation — omissions, additions, substitutions — across module boundaries, domain model,
  port/adapter contracts, behavior, config, and `EXECUTION_CONSTRAINTS`. Explicitly *not* a
  code-quality reviewer.
- **Contract with the engine**: the report must state
  `### Overall fidelity: 🟢 ALIGNED / 🟡 MINOR DRIFT / 🔴 MAJOR DEVIATION`;
  `parseSpecAuditVerdict` in `src/engine/gate.ts` reads it.
- **Driven by**: `SPEC_AUDIT` (`specAuditPrompt`, whole-document, once per cycle — memoized on
  `computePlanHash([spec, adr, plan])`) and `VALIDATE_STEP` (`validateStepPrompt`, the
  per-increment fidelity audit)
  (`validateStepSpecPrompt`).
- **Greenfield skip**: on a repo with no implementation code (`hasImplementationCode`,
  `src/engine/diff.ts`) the role is never invoked — the audit is recorded as `skipped`.

### `qa` (`ROLE_QA`)
- **Purpose**: Senior QA engineer. Tests (unit 70% / integration 20% / E2E 10%), coverage analysis,
  gap reporting. Has **two modes** decided by the prompt it receives: with the `AUDIT-ONLY MODE`
  block it must **not** write or modify any test file; otherwise it is the full test-authoring mode.
- **Guardrails**: tests always run **non-interactively** — never watch mode (`vitest run` /
  `jest --watchAll=false --ci --runInBand` / `bun test` / `pytest -q`). Searches must never
  recursively glob package-manager/build-cache directories (`node_modules`, `build/`, `dist/`,
  `.git/`, `~/.gradle`, `~/.m2`, `~/.npm`, `Pods/`, `.build/`) — scope to the project tree with
  bounded patterns instead. In **audit mode** the suite runs **once**, one heavy command at a time
  (never `fmt && clippy && test && coverage`), and **no coverage tool ever runs**: instrumentation
  rebuilds the whole workspace and writes the artifacts the read-only guard rejects, so the report
  reads the coverage the repository already publishes or says "not measured in audit mode". Build
  artifacts never go to `/tmp` (RAM-backed `tmpfs` on Linux): use the project's gitignored target
  directory or `$HOME/.cache/`.
- **Driven by**: `TEST_MODULE` (full mode, `testModulePrompt`), which appends `auditStatusContract()`
  so the role verdicts itself. The full-mode task already carries the operational guardrails: run the
  existing suite **once**, non-interactively; build in the project (never `/tmp`); scope searches to
  the project tree.

### `security` (`ROLE_SECURITY`)
- **Purpose**: Application security audit — hardcoded secrets/credentials, auth & authorization
  flaws, injection, dependency CVEs (`npm audit`, Maven dependency-check), data exposure, insecure
  config, weak crypto. Stack-aware (Java / Node / polyglot). Read-only: never modifies the codebase.
- **Driven by**: `SECURE_CHECK` (fast pre-push scan, `secureCheckPrompt`, ending on its own
  `### Audit status:` line), whose task body scopes the diff and **excludes test files** (they contain
  mock credentials and produce false positives).

### `doc-writer` (`ROLE_DOC_WRITER`)
- **Purpose**: Senior technical writer. Creates/updates README.md, ADR.md, SPEC.md, DESIGN.md,
  AGENTS.md, API docs, and inline comments — updates only what is stale.
- **Driven by**: `DOC_SYNC` (`docSyncPrompt`, informative — it can never block).
- **Note**: this role's text is the same documentation policy the huginn docs were written against;
  a change to that policy belongs in `src/engine/steps/instructions.ts`, not in a template.

### `reviewing` (`ROLE_REVIEWING`)
- **Purpose**: Expert code reviewer — Clean Architecture, DDD, SOLID, FSD (Feature-Sliced Design),
  performance, patterns. Reports only, never edits.
- **Guardrails**: searches are scoped to the project's own source tree; recursive globs over
  package-manager/build-cache directories (`node_modules`, `build/`, `dist/`, `.git/`, `Pods/`,
  `.build/`, `~/.gradle`, `~/.m2`, `~/.npm`) are banned — a `**` glob there can hang for tens of
  minutes and stall the pipeline. Use bounded patterns (`find <path> -maxdepth N ... | head`) and
  grep scoped to project paths.
- **Driven by**: `REVIEW` (`reviewPrompt`, pre-PR review of `main...HEAD`).

> The task bodies were snapshotted verbatim from the opencode command templates that hugged the roles
> in the previous design, so some of them still *read* as delegation instructions ("Delegate to the
> `qa` subagent", `$ARGUMENTS`, `!`git …`` placeholders). The wording is preserved deliberately —
> the gates depend on those literals — while the orchestration is huginn's: each body is sent as its
> own prompt, and the `!`git …`` interpolations are resolved by huginn through a subcommand allowlist
> (`resolveShellInterpolations`, `src/engine/steps/context.ts`).

## 2. The step prompts (there are no installed commands)

| Phase | Composer (`src/engine/steps/prompts.ts`) | What it carries | Verdict |
|---|---|---|---|
| `SPEC_AUDIT` | `specAuditPrompt` | spec-auditor role + spec/adr/plan + iteration + git status | `### Overall fidelity:` parsed by `parseSpecAuditVerdict`; runs once per cycle (hash-memoized) |
| `EXECUTE` | `executePrompt` | the iteration's prompt verbatim (+ the profile preamble) | non-blocking, but an empty report still fails closed |
| `VALIDATE_STEP` | `validateStepPrompt` | one increment audit: acceptance coverage + spec fidelity against the diff | `computeValidateVerdict(report)` merges both mandatory markers (§4) |
| `TEST_MODULE` | `testModulePrompt` | qa role + module scope + increment criteria/verification | own `### Audit status:`; judge only when non-pass (§4) |
| `VERIFY` | `verifyIteration` (`src/engine/verify.ts`) | the iteration's `Verification:` commands, run deterministically in the sandbox | `authoritativeVerdict` from the real exit codes (+ `crash` when one died from a signal: no fix round is attempted, the run escalates — ADR-57) |
| `SECURE_CHECK` | `secureCheckPrompt` | security role + scoped diff | own `### Audit status:`; judge only when non-pass |
| `REVIEW` | `reviewPrompt` | reviewing role + pre-PR diff | own `### Audit status:`; judge only when non-pass |
| `DOC_SYNC` | `docSyncPrompt` | doc-writer role + recent history | informative (never blocks) |
| `COMMIT_ALL` | `commitAllDeterministic` (default) or `commitAllPrompt` (`commit: "agent"`) | deterministic commit from the iteration; no model turn | informative (never blocks) |
| `DIAGNOSE` (before a `FIX_*`) | `diagnoseFindingsPrompt` | architect role in **READ-ONLY MODE** + goal/AC/verification + the judge's action items + a bounded report and `git diff --stat` | emits a `Remediation Plan` the executor applies; persisted to `II-FIX_*-N-diagnosis.md` |
| `FIX_SPEC` / `FIX_VALIDATE` / `FIX_TEST` / `FIX_VERIFY` / `FIX_SECURITY` / `FIX_REVIEW` (`APPLY_FIX`) | `fixFindingsPrompt` (+ the speculative/security extras) | the finding report, the architect's plan and the structured action items | re-runs the gate |

**Escalating fix rounds.** A blocked gate is not always diagnosed. Attempt 1 of a *tactical* gate
(`FIX_VERIFY` / `FIX_TEST`) goes straight to the executor with the console output and the judge's
`actionItems` — zero thinker tokens. Anything architectural (`FIX_SPEC`, `FIX_VALIDATE`,
`FIX_SECURITY`, `FIX_REVIEW`), or any repeat failure, first runs `DIAGNOSE` on the thinker (never
with `agent: "build"`, and guarded by the same `treeHash` read-only check as the auditors), then the
executor applies that plan.

**Increments, not layers.** `planPrompt` / `remainingPlanPrompt` (`src/engine/planMode.ts`) carry the
shared `INCREMENT_CONTRACT`: every iteration is a vertical, runnable slice with no forward dependency,
and the first one includes the smallest runnable hello-world. The plan format also requires
`**Goal:**`, `**Acceptance criteria:**` and a fenced `**Verification:**` command block; `parsePlan`
(`src/plan/parser.ts`) extracts them into `Iteration.goal`/`acceptanceCriteria`/`verification`, and
`executePrompt`, `testModulePrompt` and the QA audit receive them. Old plans without the sections
still run (the `VERIFY` phase passes with a note).

`runCommand` still exists on the legacy `IAgentSession` (the opencode and generic adapters implement
it) but **no step uses it**, and `RuntimeSession` has no command surface at all: a huginn step is
always a prompt, so a runtime with no command support runs the same pipeline.

## 3. Which model runs what

The `--thinker` / `--executor` split is enforced in `src/engine/phases.ts` + `src/engine/cycle.ts`
(run) and `src/engine/liveMode.ts` (live):

| Work | Model | How |
|---|---|---|
| `SPEC_AUDIT` (spec-auditor prompt) | **executor** | `promptWithContext({ text: specAuditPrompt(ctx), model: executor })` — skipped on greenfield (`hasImplementationCode`) and when the spec/adr/plan hash is unchanged since the last non-blocking audit |
| `EXECUTE` (build agent) | **executor** | `promptWithContext({ text: executePrompt(ctx), agent: "build", model: executor })` |
| `VALIDATE_STEP` (one increment audit) | **executor** | one `promptWithContext` call with `model: executor` |
| `VERIFY` (deterministic) | **no model** | `verifyIteration` runs the plan's commands in the sandbox and gates on their exit codes |
| Judge pass for `TEST_MODULE` / `SECURE_CHECK` / `REVIEW` | **executor** | `judgePhase(..., executor, ...)` — only when the role's `### Audit status:` is warning/blocked or missing; zero turns on green |
| `COMMIT_ALL` | **no model** | `commitAllDeterministic` (or `commitAllPrompt` under `commit: "agent"`) |
| `DIAGNOSE` (architectural gate, or any repeat failure) | **thinker** | `diagnoseFindingsPrompt` → `promptWithContext({ model: thinker })` — **no** `agent: "build"`; its `treeHash` guard discards the plan if the tree moved |
| `APPLY_FIX` (`FIX_SPEC` / `FIX_VALIDATE` / `FIX_TEST` / `FIX_VERIFY` / `FIX_SECURITY` / `FIX_REVIEW`) | **executor** | `fixFindingsPrompt` → `promptWithContext({ agent: "build", model: executor })`, fed the architect's plan and/or the judge's `actionItems` |
| `huginn plan` drafts (spec → adr → plan) | **thinker** | `prompt({ model: thinker })`, 20-min timeout each |
| `huginn live` chat refinement / scope extraction / doc drafts (`LiveEngine`) | **thinker** | `prompt({ model: thinker })` via `liveMode.ts`, 20-min timeout each; after handoff the resulting `CycleEngine` uses the executor per the rows above |

## 4. Orchestration, verdicts and the read-only guard

`/validate-step` used to work only because the installed `reviewing` agent could delegate to `qa`,
`spec-auditor` and `security` through opencode's Task tool. That allowlist is gone with the templates:
**huginn runs ONE increment audit and decides the outcome itself**:

- `computeValidateVerdict(report)` requires both mandatory conclusion lines (`### Overall fidelity:`
  and `### Audit status:`): an empty report, or one missing either line, is `blocked`; any blocked →
  `blocked`; any warning → `warning`; two green lines → `pass`. The whole-body fidelity fallback is
  only consulted when the report actually talks about fidelity, so the audit-status line cannot
  masquerade as a green fidelity verdict.
- `enforceValidateVerdict` strips every pre-existing `### Overall gate:`/handoff line and appends
  huginn's own, so `parseValidateStepVerdict` reads back exactly what huginn computed. The verdict
  also travels structurally as `authoritativeVerdict`, which `runPhase` prefers over parsing the
  report text.
- The auditor phases (`SPEC_AUDIT`, `VALIDATE_STEP`, `SECURE_CHECK`, `REVIEW`) are marked `readOnly`:
  the engine hashes the working tree before and after the step (`treeHash`) and forces `blocked` when
  the signature is **missing or changed** (`readOnlyTreeViolation`) — a phase that wrote to the
  repository cannot pass its own gate.
- Repository-derived material is untrusted data: it is bounded (60 000 characters), sanitized,
  fence-neutralised and wrapped in a `<<<BEGIN/END UNTRUSTED-<nonce> …>>>` block whose nonce the
  content cannot guess (`embedUntrusted`), document paths are symlink-screened and contained
  (`src/util/docPath.ts`), and every `git` call goes through the hardened seam in
  `src/engine/diff.ts` (no pager/fsmonitor/hooks, `--no-ext-diff --no-textconv`, a subcommand
  allowlist and a forbidden-argument screen).
- **Muninn is read, not just written.** `src/engine/memory/` turns the symbol
  graph into context: `EXECUTE`, `SPEC_AUDIT` and `VALIDATE_STEP` receive a bounded (~8 KB)
  untrusted block of recent decisions, prior increments and the symbols under the iteration's
  modules (`retrieveIncrementContext`). Retrieval requires an explicit `ctx.dbPath` and refuses a
  missing database, because opening one runs DDL and creates the project row — a write a read-only
  audit must not perform. `plan`/`live` persist every `## ADR-N` as a `decision` observation
  (`adr-<n>`, idempotent delete-then-insert), and each promoted increment becomes one `iter-<n>`
  observation. Every write is fail-open: memory can never fail an iteration, and `HUGINN_MEMORY=0`
  disables retrieval.
- **One clean session per phase.** `CycleEngine.withPhaseSession` opens a fresh, directory-scoped
  `RuntimeSession` for each pipeline step (and for the `DIAGNOSE` / `APPLY_FIX` turns) and closes it
  when the step ends (`RuntimeSession.close`). A role never inherits
  another role's accumulated tool loop, the prompt cache is not invalidated by an
  `executor`↔`thinker` switch inside one 150k–300k-token session, and the builder no longer grades
  its own work. The diagnosis turn gets the same `treeHash` guard as the auditors: a mutation
  discards its plan and the executor falls back to the report plus the judge's `actionItems`.
- **Subprocess memory containment.** Every agent prompt (`generic.ts`) and every `Verification:`
  command (`verify.ts`) is launched through `planScopedCommand`/`planScopedShellCommand`
  (`src/engine/sandbox.ts`) inside a transient `systemd-run --user --scope` with `MemoryMax`
  (70 % of RAM clamped to 2–12 GiB by default), `MemorySwapMax=4G` and `TasksMax=1024`. A runaway
  build is killed in its own cgroup instead of thrashing the host; the phase sees a crashed command.
  Payload arguments have `$` doubled (`escapeSystemdArgument`) because systemd expands `$VAR` in
  `ExecStart` and `$$` is its escape. The cap is opt-out (`HUGINN_MEMORY_MAX=off`) and degrades to a
  plain spawn off Linux, without a user manager, or when the manager socket exists but nothing answers
  on it: `userScopeAvailable` probes liveness with a bounded, process-cached
  `systemctl --user is-system-running` instead of trusting the socket file — so no test or platform
  depends on it existing.
- **Atomic increments.** Every profile runs `VERIFY` (the plan's commands, real exit codes) before
  its commit. After the phase loop, `WorktreeManager.commitPendingChanges` creates a deterministic
  `chore(iter-N): checkpoint — …` commit for anything `COMMIT_ALL` left uncommitted, and only then is
  the sandbox promoted. A dirty sandbox with no commits is a failed promotion, never a silent delete.
  The checkpoint commit uses the `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env (the hardened `git()` seam
  refuses `-c`) and `--no-gpg-sign`.
- **Promotion parks both collision classes.** `parkCollisions` moves untracked files **and** tracked
  files with staged/unstaged local changes into `.huginn/promotion-backup/<stamp>/` (plus a
  `manifest.json`), resetting tracked paths to `HEAD` so the merge/cherry-pick can proceed. On a
  failed integration every entry is restored, including its staged/unstaged index state. A partially
  staged file or a staged *new* file fails closed (the branch is preserved) because its exact index
  state cannot be reproduced without copying index blobs. An integration range that contains a merge
  commit (a repair merge) is integrated with `git merge --no-ff`, never cherry-picked: git cannot
  replay a merge commit and reports "the previous cherry-pick is now empty" for an already-present
  change.
- **A failed promotion is recoverable (ADR-62).** `CycleEngine.retryPromotion()` reopens the preserved
  branch (`openSandboxFromBranch`, base = `integrationBase()` or `state.iterationBaseCommit` — never
  the branch tip) and re-attempts the integration with no model turn; it then indexes the symbols,
  records the iteration and advances `currentIteration`, so the next run continues after the increment.
  `repairPromotion()` is offered **only** for a `conflict`: huginn merges the primary HEAD into the
  branch without committing, `DIAGNOSE` runs on the thinker (read-only), the executor resolves the
  files, huginn commits the merge (refusing leftover markers) and `verifyIteration` runs in the
  worktree before the fast-forward. It re-reads the primary HEAD after verification and, if a commit
  landed meanwhile, merges the new HEAD on top of the verified merge and verifies again (bounded to
  three attempts), because the tree it proved is the tree that must be promoted. A `failed` promotion
  is never given to a model — it names the index conflict and points at `huginn promote --retry`.
  Neither routine is a `PipelineStep` and `REPAIR_PROMOTION` is in no profile; `huginn promote` is a
  CLI subcommand, not a phase.

## 5. Runtime requirements

1. **Bun** (the bin is `#!/usr/bin/env bun`; the bundle is Bun-target).
2. **An agent CLI on `$PATH`** — huginn has 13 **provisioning targets** but only 5 **runtimes**
   (`pi`, `codex`, `claude`, `opencode`, `generic`). `opencode` is the default and the only runtime
   with a native permission channel (`--permissions ask|deny`), server-side session history, and an
   incremental output channel (`RuntimeCapabilities.streaming`, true only there — every subprocess
   CLI buffers stdout and resolves once, so a surface shows the phase report instead of pretending to
   stream); when it is used, huginn starts it itself via
   `opencode serve --port <n> --hostname 127.0.0.1` in the project dir (logs to
   `.harness/logs/server.log`). `getAgentRuntime()` still builds the CLI-shaped adapter for every
   provisioning target; the nine without a dedicated driver (`cursor`, `agy`, `commandcode`, `devin`,
   `kimi`, `mcode`, `mimo`, `omp`, `qwen`) are one configured
   `GenericSubprocessRuntimeAdapter` from `src/engine/agent/genericTargets.ts`.
3. **`git` on `$PATH`** — used for module inference, diffs, base commits, doc staging and worktree
   sandboxing. The project directory does **not** have to be a repository: `run`/`plan`/`live`
   bootstrap one (`git init -b main` + `.gitignore` + a bootstrap commit) unless `--no-git-init` is
   passed. `plan.md`/`spec.md`/`adr.md` must exist for `run` (but not for `plan`/`live`, which create
   or update them).
4. **Nothing to install** — the roles and task bodies are embedded in the binary (§1). There is no
   `templates/` directory, no `postinstall` hook and no warning about missing pieces.

### The runtime port

`src/engine/agent/port.ts` is the driver-neutral contract the cycle is moving onto: a `RuntimeId`
(defined in `src/agents/integrator.ts` next to the provisioning targets), a `RuntimeCapabilities`
record, `isAvailable()`, `listModels()`, `resolveModel()` and `createSession()` →
`RuntimeSession` (typed `text`/`tool`/`permission`/`usage`/`error`/`done` events,
`interrupt()`, idempotent `close()`).

M4b split the two concepts. `ProvisioningTarget` (`AgentTarget`) is where `setup`/`doctor`
register Muninn — 13 values, unchanged. `RuntimeId` is what executes the cycle — five values
(`pi`, `opencode`, `codex`, `claude`, `generic`), mapped by `runtimeIdForTarget()`. The engines no
longer touch `IAgentRuntime`; that interface survives as the CLI-shaped adapter contract behind
`getAgentRuntime` and as the input `asRuntimePort` bridges.

`getRuntimePort()` returns the native driver for `pi`, `codex`, `claude` and `opencode`, or a
bridged configured generic adapter for every other target.
`getGenericRuntimePort()` is the `generic` catalog entry used by `huginn runtime list` (it probes
whether any generic-target CLI is installed; `createSession` there says it needs a concrete target).
`pi` is the first driver implemented natively (`drivers/pi-sdk.ts`): it runs `createAgentSession()`
in huginn's own process, resolves `provider/model` through the SDK's `ModelRuntime`, lists the real
catalog and keeps a real session history. It also enumerates MCP: `listMcpServers` runs
`pi mcp list --json` (bounded, 30 s, `cwd = project`) and then **merges** in every server read from
`~/.pi/agent/mcp.json` + `<project>/.pi/mcp.json` that the listing did not mention (project wins a
name collision), as `unknown`/`unverified` — a config declaration is never liveness, but it is not
nothing either. `mcpStatus` reads those same files as the honest probe, so a failed or empty listing
reports `⚪ n configured` (and a listing row in `error` keeps its peers and names the failure)
instead of `none`. The default session
uses pi's `DefaultResourceLoader`, so pi's own MCP servers, skills (`~/.agents/skills`, `.pi/skills`)
and `AGENTS.md` are already available to the phase prompt; huginn only reports them. Its events,
permissions and resume are **not** wired yet, so it declares `streaming`, `structuredEvents` and
`sessionResume` false.

**The engines speak only the port.** `CycleEngine` and `LiveEngine` call
`createSession({ sink, onPermission, onQuestion })` and `session.prompt(...)`;
`getEnginePort()` is what `run` and `live` build, and `getAgentRuntime()` remains the
CLI-shaped adapter for provisioning, model discovery and the argv-level tests. The reverse
`toLegacyRuntime` bridge and `getEngineRuntime` are gone; `asRuntimePort()` lets a test or an
embedder hand the engine either shape (a legacy fake is bridged at construction).

`opencode` is the native driver (`drivers/opencode.ts`): it owns one SSE subscription and fans
typed events out to its sessions, answers permissions through the session's `onPermission`
(deny when absent) and questions through `onQuestion`, and exposes `start`/`endpoint`/
`resumeSession`/`probeSession`/`abortSession`. `src/engine/runtimeEvents.ts` is the single
`RuntimeEvent → engine bus` mapper: text/reasoning deltas only when the driver streams, tools to
the stream and the log, `usage` to the new event (and `state.usage`), and nothing for `done`.
`permissionHandlerFor()` is the one mapping from `--permissions` to a handler.

The eight CLI-only targets retired as **runtimes** (`agy`, `commandcode`, `devin`, `kimi`,
`mcode`, `mimo`, `omp`, `qwen`) remain **provisioning targets**: `huginn setup --status` still
lists all 13, their MCP paths/rules rows are unchanged, and `--agent <target>` still runs them
through `generic`. Only a *stored* config value warns and falls back to auto-detection (M4b
migration); model/MCP listing is no longer wired for them, so discovery honestly returns an explained
empty catalog and the MCP panel falls back to config discovery.

`codex` is the second native driver (`drivers/codex-sdk.ts`): a persisted `Thread` from
`@openai/codex-sdk`, so `sessionHistory` is real, while `sessionResume`, streaming and approvals
are declared false — the SDK exposes no abort and huginn does not feed its approval options yet.

`claude` is the third native driver (`drivers/claude-sdk.ts`) and the only one whose SDK is **not
open source**: it lives in `optionalDependencies` (an install failure is tolerated), is never bundled,
and is imported only by its own adapter. `interrupt` is real (an AbortController cancels the query);
approvals need `canUseTool`, which huginn does not feed yet, so `ask|deny` keeps failing closed, and
streaming, resume and the catalog are declared false.

**The model is requested per prompt, not per session.** The engine asks for the thinker on a fix
and the executor on everything else, and a driver that drops that request runs whatever the tool has
configured — which is how the TUI came to show one model while the API billed another. `pi` switches
with `session.setModel(model, { persist: false })` (session-only: it never rewrites the model the user
configured in pi), `claude` passes it to each turn's query, and `codex` cannot: its SDK fixes the model
when the thread starts, so it ignores the request and the thread keeps its own. That last one is a
known gap, recorded next to the code.

All three SDKs are `--external` in the build, so pi, codex and claude stay out of the bundle.

A driver *declares* its capabilities instead of implying them (and
`permissions: "none"` for every legacy adapter because none of them has a channel back mid-turn), and
the conformance suite (`conformance.ts`, run for every target in
`test/engine/agent/conformance.test.ts`) fails a driver that claims more than it delivers:
`sessionResume` without `sessionHistory`, `interactive` permissions without `interrupt`,
`streaming` without `structuredEvents`, a permission event from a driver whose mode is `none`, a
`done` event that is not last, or a failed prompt that does not emit `error`.

## 6. Developer workflow (working on huginn itself)

```sh
bun install            # dependencies only — there is no postinstall hook any more
bun link               # exposes the global `huginn` bin → dist/cli.js
bun test src           # unit tests under src/**/*.test.ts (bun:test) — plain `bun test` also picks up test/**
vitest run             # integration suite under test/**/*.test.ts (engine, tui, commands, state)
bun run typecheck      # tsc --noEmit (strict)
bun run dev -- ...     # run from source, e.g.
                       #   bun run dev -- run --project ../repo --thinker a/b --executor c/d
bun run build          # bun build src/cli.ts --target=bun --outdir=dist --minify
```

### Releasing

A tag **is** the release: `publish.yml` publishes to npm, then builds the GitHub release from the
version's `CHANGELOG.md` section. So the changelog entry must exist before the tag, and the tag message
is written from that same section — never typed by hand, or `git show` and the release page end up
telling different stories:

```sh
# 1. the changelog entry is the release notes
$EDITOR CHANGELOG.md
git commit -am "chore(release): X.Y.Z"

# 2. the tag carries the same text
git tag -a vX.Y.Z -F <(awk -v v=X.Y.Z '$0=="## "v{p=1;next} p&&/^## /{exit} p' CHANGELOG.md)
git push origin vX.Y.Z
```

Re-tagging to fix a message is safe: the publish step **skips** when the version is already on npm,
and the release job **updates** the existing page instead of failing or skipping. Republishing a
version stays impossible, on purpose.

**Muninn lives in its own repository** ([dahch/muninn](https://github.com/dahch/muninn)) and is
consumed as `@dahch/muninn` — the database, service, AST indexer, MCP server and TypeScript
contract verifier are all there, with their own test suite (`test/muninn/**` and
`test/contracts/**` moved with them). `huginn memory`, `huginn check` and `huginn mcp run`
remain as wrappers, so the CLI surface and the `.huginn/muninn.db` data location are unchanged.
The package is published on npm as `0.1.0`, and huginn depends on `^0.1.0` (it was briefly
installed from the `v0.1.0` release tarball before that first manual publish).

The suites that matter for the step pipeline and its state: `src/engine/gate.test.ts` (the verdict
parsers), `src/engine/cycle.test.ts` (retry/escalation, the read-only guard, structural verdicts,
the pre-promotion checkpoint), `src/engine/verify.test.ts` (the deterministic `VERIFY` phase and its
command runner), `src/plan/parser.test.ts` (increment metadata), `src/engine/steps/prompts.test.ts` +
`src/engine/steps/context.test.ts` (composition, bounding, nonce delimitation, the git-interpolation
allowlist, doc containment), `test/engine/phases.test.ts` (the single-report `VALIDATE_STEP`, the
deterministic verdict, the imposed gate/handoff line and the deterministic commit),
`src/engine/agent/drivers/opencode.test.ts` (the native driver's SSE fan-out, permissions and
resume), `src/engine/runtimeEvents.test.ts` + `src/engine/permissionPolicy.test.ts` (the event
mapper and the `--permissions` mapping), `src/engine/steps/retrieval.test.ts` +
`src/engine/memory/adr.test.ts` +
`src/engine/memory/curation.test.ts` (bounded retrieval, read-only refusal, idempotent ADR/curation
writes), `test/engine/phasesContractGuard.test.ts` (a compiler-contract verification that throws fails closed),
`test/engine/agent/piMcp.test.ts` (the `pi mcp list --json` parser and the native driver's MCP bridge),
`test/engine/gitRepo.test.ts` + `test/engine/docPath.test.ts` (bootstrap and path containment),
`test/tui/glyphs.test.ts` + `test/tui/decisionModal.test.ts` (the glyph tables, the decision
title drift guard and the modal's row contract, including the ASCII/one-column rule),
`test/tui/ravenHeader.test.ts` + `src/brand.test.ts` (the four-rung header plan, the raven moods
and their shared grid, the display-column truncation with `…`, and a scan of both frames for a
pictograph or a double-width row), `test/tui/sessionContext.test.ts` (the `mcpBadgeText` mapping,
the budgeted `gitStat` that keeps `clean`/`dirty`, and `formatCount`; REQ-76 / REQ-77),
`test/tui/liveStageAccent.test.ts` (the busy stage accent),
`test/tui/card.test.ts` + `test/tui/cardColors.test.ts` (the `CARD_CHROME` cost table, the painted
height per tone, the borderless log tail and the emitted border colours),
`test/tui/markdown.test.ts` + `test/tui/markdownTable.test.ts` + `test/tui/liveMarkdownTable.test.ts`
(width-aware rules and links, one aligned row per table row, truncation, the real dashboard frame and
the live chat's painted table),
`test/tui/modalContract.test.ts` + `src/tui/footer.test.ts` (the six-modals-plus-decision frame
contract, the `Esc`/`q`/`Enter`/`Tab`/`k`/`j` grammar, the one-title/one-footer rows, the focused-
surface footer hints, the 100-column clamp and the no-inline-literals guard),
`test/tui/liveLayout.test.ts` + `test/tui/dashboard.test.ts` (a tall decision never pushes the
composer or footer off an 18-/24-row frame, the live layout keys — `z`, `Ctrl+↑`/`Ctrl+↓`, `L` —
with the idle log tail and its advertised hidden count on 100×30 frames, the closed/open header budget
and the `iter n/m` pipeline rail), `test/tui/smokeMatrix.test.ts` (both surfaces at 80×24, 100×30,
120×40 and 160×50, with colour on, `NO_COLOR=1` and `HUGINN_THEME=dark`: display-column width, row
count, no double-width pictograph and no colour SGR — plus all seven modal surfaces at 80×24, 100×30
and 120×40, each with a one-row title; and the inspector's own failure branches, including the
empty frame, a double-width glyph and terminal-size restoration after a render throws),
`test/tui/inkRender.test.ts` (the render seam writes to the injected stream, accepts a plain
`PassThrough` stdin and unmounts idempotently),
`test/tui/transcriptNavigation.test.ts` + `test/tui/transcriptSearchColors.test.ts` (the transcript
keys, search/draft restoration, message jump, Esc/search interaction, OSC 52 copy and the warning
border), `src/tui/search.test.ts` + `src/tui/clipboard.test.ts` (the pure match/label and clipboard
helpers),
`test/tui/infoPanel.test.ts` (the side panel's geometry, its `SESSION`/`REPO`/`MEMORY` sections, the
bottom-anchored tip, the `stage` row it no longer draws and the rows it must not invent), and
`test/state/liveSession.test.ts` + `test/engine/liveSessionPersistence.test.ts` +
`test/commands/liveSessions.test.ts` (the persisted live store, resume flags and reattach).

### Env overrides (all optional)

| Variable | Effect |
|---|---|
| `HUGINN_OPENCODE_CONFIG_DIR` | Where opencode's own config lives (default `~/.config/opencode`); also where the update-check cache (`huginn-update-cache.json`) is written. No longer an install destination (`getOpencodeConfigDir`, `src/setup/opencodeConfig.ts`). |
| `HUGINN_NO_UPDATE_CHECK` | Any non-empty value disables the background npm version check (`src/update.ts`). |
| `HUGINN_DEBUG` | Print full error stack traces on fatal errors, plus non-fatal notes (e.g. why Muninn indexing, curation or contract verification was skipped). |
| `HUGINN_MEMORY` | `0` disables the bounded Muninn retrieval block injected into `EXECUTE`, `SPEC_AUDIT` and `VALIDATE_STEP` (`src/engine/steps/retrieval.ts`). Writers (indexing, ADR decisions, curation) are unaffected. |
| `HUGINN_THEME` | `light` \| `dark` \| `auto` (default) — pins the TUI palette (`src/tui/theme.ts`). |
| `NO_COLOR` | Any non-empty value clears every theme token and `dimColor` (per no-color.org). |
| `CI` | Every prompt (`promptLine`/`promptYesNo`, `src/util/prompt.ts`) returns its fallback instead of reading stdin; nothing blocks on a human. |
| `HUGINN_MEMORY_MAX` | `MemoryMax` for the systemd scope around agent/verification subprocesses (`src/engine/sandbox.ts`); default 70 % of RAM clamped to 2–12 GiB, `off` disables the scope. |
| `HUGINN_MEMORY_SWAP_MAX` | `MemorySwapMax` inside that scope (default `4G`, `off` for none). |
| `HUGINN_TASKS_MAX` | `TasksMax` inside that scope (default `1024`). |

### Testing the step prompts and the verdict contract

- The verdict markers are a **three-way contract**: the literals in
  `src/engine/steps/instructions.ts` / `src/engine/steps/context.ts` (`AUDIT_STATUS_*`,
  `SPEC_FIDELITY_*`, the `VALIDATE_STEP_GATE_LOGIC` and handoff lines), huginn's own enforcement
  (`computeValidateVerdict` / `enforceValidateVerdict` in `src/engine/phases.ts`), and the parsers in
  `src/engine/gate.ts` (`parseValidateStepVerdict`, `parseSpecAuditVerdict`, `parseAuditStatus`,
  `parseGateVocabularyVerdict`, `parseAuditGateVerdict`). A
  wording change must update all three plus their tests (`src/engine/gate.test.ts`,
  `test/engine/phases.test.ts`) in the **same commit** — nothing else keeps the embedded literal and
  its parser from drifting, since both now live in this repository.
- Consequence of ADR-40: a huginn-computed verdict wins over the report text. If you make a phase emit
  `authoritativeVerdict`, its prose no longer decides the gate.

## 7. Running a single step and inspecting what huginn sent

There is no manual invocation inside an opencode session any more — `spec-auditor`, `qa`,
`/validate-step` … exist only as prompt text. To exercise one step in isolation:

```sh
# Run a single phase per iteration (debugging), e.g. just the gate
bun run dev -- run --project . --only-phase VALIDATE_STEP

# ...or with the built bin
huginn run --project /path/to/repo --only-phase SPEC_AUDIT
```

`--only-phase` accepts any phase name in the union over every profile
(`validatePhase`, `src/cli.ts`), and it leaves the state resumable. The composed
prompt is not printed, but every phase attempt's raw report is written to
`<project>/.harness/reports/II-PHASE-N.md`, and `.harness/logs/server.log` holds the opencode server's
own output.

## 8. In-app Live console commands & project skills

The `huginn` / `huginn live` console has its own slash-command surface, unrelated to the step prompts
above. `submit()` in `src/tui/LiveDashboard.tsx` intercepts any `/<…>` input **before** it reaches
`LiveEngine.chat()`; an unrecognised `/…` command is answered with a system message and never
forwarded to the model.

| Command | Behaviour | Backing code |
|---|---|---|
| `/help` | Opens the cheat-sheet modal (`HelpModal`) with commands, shortcuts and the active agent/model/project banner. | `src/tui/HelpModal.tsx` |
| `/agent` | Opens the interactive runtime picker (`AgentPickerModal`): availability, active marker, detected path. | `src/tui/AgentPickerModal.tsx` |
| `/agent <id>` | Hot-switches the runtime; fails closed if `isAvailable()` is false. | `LiveEngine.switchRuntime()` |
| `/models`, `/model` | Opens `ModelPickerModal`. | `src/tui/ModelPickerModal.tsx` |
| `/model <thinker> [executor]` | Validates `provider/model` and updates models for the session. | `LiveEngine.updateModels()` |
| `/profile` | Opens the methodology-profile picker (`ProfilePickerModal`): name, description, active marker; `↑`/`↓`/`j`/`k` move, `Enter` = session, `p` = project, `g` = global, `Esc` cancels. | `src/tui/ProfilePickerModal.tsx` |
| `/profile <id>` | Validates against `PROFILE_NAMES` and **fails closed** on an unknown id; the change applies to the next cycle and the console says so. | `LiveEngine.updateProfile()` |
| `/mcp [id]` | Opens the MCP inspector, optionally preselecting a server id. | `src/tui/McpInspectorModal.tsx` |
| `/skills`, `/skill` | Opens the skills browser (`SkillsModal`). | `src/tui/SkillsModal.tsx` |
| `/skill <name>` | Resolves a skill by id/name/trigger and runs its `body` as the prompt. | `findSkill()` |
| `/status` | Renders branch, dirty state, worktree sandbox, runtime, models, the resume point of an interrupted run and Muninn counts. | `LiveEngine.getDiagnostics()` + `getResumePoint()` |
| `/clear` | Clears chat + stream viewports. | — |
| `/draft` / `/go` | Runs scope extraction and drafting. | `LiveEngine.draft()` |
| `/resume` | Continues the saved run from the step it was interrupted on, without re-planning. Refuses (and points at `/draft`) unless `.harness/state.json` holds a resume point whose `planHash` matches the documents on disk. | `LiveEngine.getResumePoint()` → `execute()` |
| `/quit` / `/abort` | Two-step confirmation, then aborts. | `LiveEngine.requestAbort()` |

**Focus is a three-state union** (`"composer" | "chat" | "stream"`, `FocusTarget` in
`LiveDashboard.tsx`): `Tab`/`Shift+Tab` cycle it through `nextFocus()` — skipping the agent-stream
card while it is collapsed, and the conversation while a maximized stream card has hidden it — and
it, **not the draft's emptiness**, decides where `↑`/`↓`/`PgUp`/`PgDn` go (composer: history recall
+ caret; card: scroll). Any editing key claims the composer back. A focus move never writes to the
chat: a key with nothing to do must not append a line.

**The layout keys belong to the focused card, never to the composer.** From a card, `z` maximizes it
(`z` again restores the remembered split), `Ctrl+↑`/`Ctrl+↓` move the conversation/stream split by
`SPLIT_RATIO_STEP` (0.08, clamped to 0.30–0.80 around `DEFAULT_SPLIT_RATIO` 0.58 through the pure
`adjustSplitRatio`), and `L` pins or reopens the log tail. In the composer `z` and `L` are ordinary
draft text and the chord stays out of the terminal, which is the whole reason the guard is the focus
state rather than the draft's emptiness. The split itself is the pure `liveCardHeights` (a maximized
card takes every row, the other is not rendered), so the three layouts are testable without a frame.

**The transcript keys follow the same focus contract (REQ-72 / ADR-68).** From the conversation or
the agent stream, `g`/`G` jump to the start/end of the focused transcript; `y` copies the newest
assistant message through OSC 52, but only from the conversation (the stream has nothing to copy,
and the composer keeps `y` as draft text). `Ctrl+F` opens transcript search from any focus —
including while a turn is busy — and swaps the composer to `find ❯ ` with a warning border:
`↑`/`↓` walk the message hits, Enter jumps to the selected message and closes, and Esc or `Ctrl+F`
restores the exact draft. Search consumes every key it sees and cancels any armed two-step Esc, so
an abort confirmation can never survive into search mode. The helpers stay pure:
`findMatches`/`matchLabel` live in `src/tui/search.ts`, OSC 52 lives in `src/tui/clipboard.ts`, and
`copyToTerminal` writes to the render stream passed by the call site, not a global `process.stdout`.

**The log tail is ephemeral.** `LOG_AUTO_COLLAPSE_MS` (60 s) without a new event collapses it and
returns the rows to the conversation; a new log reopens it, an `error` still present in the visible
tail keeps it open, and an error that has scrolled out does not disable the timer forever. `L` pins
it (disabling the timer); releasing the pin starts a fresh minute. A collapsed tail is advertised in
the footer as `[L] logs · N (card focus)`, where `N` counts every hidden entry — a log that vanishes
silently is indistinguishable from a log that never arrived.

Session resume is a CLI-flag surface rather than a command: `--continue`/`-c`, `--session <id>` and
`--list-sessions`/`-sl` read `<project>/.huginn/live/sessions.json` (`src/state/liveSession.ts`). The
store and the resume precedence are documented for users too, in the `usage()` section *Sessions
(live)* (`src/cli.ts`, REQ-53).

Ten display conventions a TUI change must follow:

- **One logical line is one terminal row in the conversation card.** Message lines are pre-wrapped to
  the card's column budget with `wrapSegments` (`src/tui/markdown.tsx`) and rendered `wrap="truncate"`;
  never hand the card a `wrap="wrap"` line. Ink lets such a text node claim one row while it paints
  several, which draws the extra rows over the following line and over the card's bottom border.
  `markdownSegments` carries the block prefix (heading marker, bullet, quote bar) so the width math
  counts it, and splitting happens between segments so a styled span is never cut mid-markup.
  The run dashboard's `PipelineCard` likewise lists `phasesForProfile(cfg.profile)`: the profile owns
  the order, so `VERIFY` sits right after `EXECUTE` in the Huginn Cycle. It names the increment in its
  title row (`iter n/m`) and hangs the phases off one rail (`├─`, the last `└─`, a `FIX_*` round
  `   └─`), which is still one row per phase — a connector is drawn inside the row it already
  occupies.
- **A table needs the whole block, and every rule needs the card's real width.** `MarkdownBlock`
  (`src/tui/markdown.tsx`) is the only caller that may format a report or a stream buffer: it hands
  each contiguous table block (header + `|---|` + rows, detected by `isTableHeader`/`tableBlockEnd`)
  to the pure `tableBlock`, which returns exactly one styled row per source row — padded columns,
  dim ` │ ` separators, bold header, `…`-truncated cells — and every other line to `MarkdownLine`.
  `MarkdownLine`/`markdownSegments` take the body width the frame already paid for
  (`cardChrome(...).columns`) and draw `---`/`***`/`___` and the code-fence header at exactly that
  width (fallback 80, clamped to ≥1); a fixed-width rule is the old bug that wrapped into a second
  row. Links render as an underlined label plus a dim ` ‹url›`, and a malformed link stays literal.
  Table cells keep their inline markup: each cell is parsed with `inlineSegments`, while its
  column width is measured on the *visible* text (`segmentsWidth`), so `**bold**` and `code` paint
  styled without moving a separator. A cell that does not fit is truncated on its visible text
  (the cut drops every segment past it) and still occupies exactly one row;
  `test/tui/markdownTable.test.ts` asserts the styles and the alignment.
- **Display glyphs come from `src/tui/glyphs.ts`** — single-width status/phase marks shared by
  the dashboard and `.harness/PROGRESS.md` (`·` pending, the braille spinner while running, `✓` pass,
  `!` warning, `✕` blocked, `–` skipped; phase kinds `?` SPEC_AUDIT, `>` EXECUTE, `=` VALIDATE_STEP,
  `%` TEST_MODULE, `V` VERIFY, `#` SECURE_CHECK, `@` REVIEW, `~` DOC_SYNC, `.` COMMIT_ALL, `&`
  REPAIR_PROMOTION, `+` for any other). The same module owns the decision alphabet
  (`DECISION_GLYPHS`: `+` approve, `?` question, `!` warning, `*` finished): every mark is ASCII, one
  column wide and a non-letter, so it can never read as one of the modal's `[a]`/`[d]` key hints, and
  the title text is composed by the pure `decisionTitle(req)` in `src/tui/decision.ts` (an exhaustive
  `switch`, so a new `DecisionKind` fails to compile until it gets a title). The feedback voice is
  `✓` / `!` / `…`.
  Never add an emoji display glyph. The gate marker literals (`### Overall gate: 🟢/🟡/🔴`,
  `### Overall fidelity: …`), the engine's `⚠️ REVIEW REQUESTED` handoff line and the runtime stream
  prefixes (`⚡ ✓ ✗ 💭`) are excluded: the first are a three-way contract, the last are producer
  output. Changing the decision alphabet is a TUI change; changing the gate/handoff literals is not.
- **The decision modal buys only the rows it can pay for.** `decisionModalHeight(req?, maxRows?)`
  (`src/tui/decision.ts`) is the single source of truth: `decisionBodyRowSpecs`/`decisionKeyRowSpecs`
  model one entry per terminal row and the React builders in `src/tui/DecisionModal.tsx` render the
  same specs, the planner pays the double border, the title and the key footer first, buys the
  `… +N · ↑/↓` indicator only while a body row still fits, and windows the rest; a capped budget
  below `DECISION_MIN_ROWS` draws nothing rather than a title without its key footer. Both dashboards
  derive `decisionMaxRows` from the rows their own chrome leaves and pass it in — never a height
  literal. `test/tui/decisionModal.test.ts` asserts the height equals the rows Ink paints, and
  `test/tui/liveLayout.test.ts` + `test/tui/dashboard.test.ts` hold 18- and 24-row frames.
- **A card declares its chrome; it never guesses its height.** `src/tui/Card.tsx` owns the one
  `CARD_CHROME`/`cardChrome(tone)` table: `primary` (round, two border rows, one title row, four
  columns), `secondary` (single, the same cost) and `tertiary` (no border, one title row, two columns
  for the `│ ` rule). The conversation is `primary`; the stream, `InfoPanel`, `PipelineCard` and
  `StreamCard` are `secondary`; `LogsCard` is `tertiary`. `rows` includes the title row, so a
  titleless card (`InfoPanel`) reserves `borderRows` instead. Both dashboards compute the log tail
  as `visibleLogs.length + cardChrome("tertiary").rows` — the old `+ 3` literal and its five-row
  expectations are gone, and a five-entry tail now costs six rows. `Card` draws only chrome (border,
  one clipped title row, clipped body); it never scrolls, measures children or computes a height.
  `test/tui/card.test.ts` guards the table, painted heights, log cost and surface→tone map;
  `test/tui/cardColors.test.ts` guards the emitted border colours. Both dashboards now also derive
  their card scroll windows from `cardChrome(...).rows`, so no `- 3` chrome literal remains. The
  composer, palette and header keep their own labelled border constants, and the decision modal's
  double border is the shared frame's `alert` tone — never describe `CARD_CHROME` as the cost source
  for the whole TUI.
- **Every console modal shares one frame and one key grammar; the footer names the focused surface.**
  `src/tui/Modal.tsx` is the only frame: `tone="alert"` is the single double/warn box (the decision
  surface), everything else is round/accent; it owns one clipped bold title row, an optional muted
  subtitle, one muted key footer (or the decision surface's `ReactNode` row specs), and the fixed
  `paddingX={1}`/`flexShrink={0}`/`overflow="hidden"`. It never calls `useInput`; each surface keeps
  its keys. `MODAL_KEY_CONTRACT` states the grammar every handler follows: `Esc` closes all six,
  `q` only `HelpModal`/`SkillsModal`, `Enter` only the three selectors (Skills' own execute action
  excepted), `Tab` only the Skills/MCP panes, `p`/`g` only the profile picker, and `k`/`j` only where
  they already were. The footer is the pure `footerHints` (`src/tui/footer.ts`; `footerHints.ts` is a
  re-export): the left cell is the **focused** surface's keys, the right keeps `usage` (the run
  dashboard adds its decision notice there), and the
  palette/search/busy/maximized/hidden-log states replace the left where they own the keyboard. The
  live stage is **not** a footer value: it lives in the header badge (ADR-73). With
  `columns`, the right cell is clamped first through `headerValue`, so the footer never exceeds the
  terminal; neither dashboard may re-inline those literals. `test/tui/modalContract.test.ts` and
  `src/tui/footer.test.ts` are the drift guards (REQ-75 / ADR-71).
- **An output panel only claims what the runtime can deliver**: the run dashboard's `StreamCard` shows
  the last finished phase's report, or the two-raven idle state, and keeps the `LIVE AGENT OUTPUT`
  title and waiting placeholder **only** for a runtime whose `RuntimeCapabilities.streaming` is `true`
  (`opencode`); everything else is titled `AGENT OUTPUT` and names itself (REQ-51).
- **An output panel wraps before it scrolls (ADR-74).** `markdownBlockRows(lines, width, colorFor?)`
  (`src/tui/markdown.tsx`) is the one formatter for a report, the run stream and the live stream: it
  expands table blocks with `tableBlock` and wraps every other line with `wrapSegments`, returning
  one `MdSegment[]` per terminal row. `MarkdownBlock` renders those rows unchanged, so no surface
  relies on Ink's wrapping. Both dashboards `useMemo` the rows on `[text, bodyWidth]` only, derive
  `maxScroll` from `rows.length - visibleRows`, slice **rows**, and clip the stream buffer to
  `MAX_STREAM_ROWS` (2 000). In `huginn run`, `z` hides `PIPELINE` and gives the panel the full
  content width (`z` again restores it), and `y` copies the original markdown through OSC 52 with
  `copyToTerminal` — never the wrapped rows. The panel title carries the same `▲ +N` / `▼ bottom`
  indicator as the conversation.
- **The raven's presence follows the run, and chrome is paid for only while it is on screen.**
  `RAVEN_MOODS`/`ravenMark(mood)` (`src/brand.ts`) are the three moods (`idle` `o`, `thinking` `O`,
  `sleeping` `-`) and differ from `RAVEN_MARK` by one beak cell: never add a mood that changes the
  row/column grid, and never draw art that has to be re-measured. `ravenHeaderPlan`/`heroPlan` have
  four rungs — mark + wordmark, wordmark, the one-row `<(o  HUGINN` (`COMPACT_BRAND`), plain text —
  and the live console spends `VIEWPORT_RESERVED_ROWS_CLOSED`/`_OPEN` (plus
  `MODAL_COMPACT_RESERVE_ROWS` for a full-screen modal) so the header only pays for the palette or
  modal while it is open. While a turn is in flight the conversation's `primary` border uses the
  stage's `STAGE_LABEL` token (`accent`/`warn`/`thinker`/`executor`); a focused card still wins with
  `borderFocus` (REQ-73 / ADR-69).
- **One fact has one home: the header is identity and ephemeral state, the panel is the
  environment, the footer is the keys.** The live `LiveHeader` row 1 is `[<spinner> <STAGE>]` plus
  the project path, and row 2 is the two active models; the panel owns `agent`, the mapped MCP badge,
  `git`, `sandbox`, `muninn`, `ctx` and the bottom-anchored `TIP`; `footerHints` owns the keys and
  `usage`. Do not re-add the runtime name, the MCP badge, git, the sandbox or the context counter to
  the header, the `stage` row to `PanelData`/`panelLines`, or `stage:` to the footer — that is the
  duplication ADR-73 removed. `LIVE_HEADER_CONTEXT_ROWS` stays `2` so the header's height and every
  budget derived from it (`VIEWPORT_RESERVED_ROWS_CLOSED`/`_OPEN`, card heights, the decision modal)
  do not move. `gitStat(git, maxWidth?)` reserves the `clean`/`dirty` suffix before clamping the
  branch, because the panel is the only surface that reports the working-tree state. Guards:
  `test/tui/liveLayout.test.ts` (one `⎇` in the panel, none on the header's models row; the
  conversation counter appears once; a long path is whole at 100×30), `test/tui/infoPanel.test.ts`
  (`stage` is not a row) and `src/tui/footer.test.ts` (the right cell never carries the stage).
- **A clamped value announces its cut, and the console's measured surfaces paint no pictograph.** `headerValue`
  (`src/tui/RavenHeader.tsx`) sanitizes, collapses whitespace and clamps in **display columns**
  (`stringWidth`), never code units: a fitting value is returned intact, a larger one keeps its head
  plus `TRUNCATION_ELLIPSIS` (`…`) in the last column, a cut in one column is the mark alone, and
  zero/negative/sub-one/`NaN` budgets are `""` (`Infinity` keeps the value whole). A double-width
  glyph is never split, so the result cannot paint wider than the budget the caller laid out; the footer
  inherits the same contract, so a clamped footer cell ends in `…`. The engine's MCP badge still
  ships `🟢`/`🟡`/`⚪`; the console maps it through `mcpBadgeText` (`src/tui/sessionContext.ts`) and
  `MCP_STATUS_GLYPHS` (`healthy` ✓, `degraded` !, `unknown` ·) before painting, so the row reads
  `MCP: ✓ 2 connected · pi` in the run dashboard header and in `InfoPanel` (the live header no
  longer carries it, ADR-73). Never change `formatMcpBadge` to
  fix a TUI width bug, and never add a pictograph to console chrome (REQ-76 / ADR-72). The modal
  titles compose their leading mark from `MODAL_TITLE_GLYPHS` (`>`, `?`, `·`) in
  `src/tui/glyphs.ts` — `AgentPickerModal`, `HelpModal` and `McpInspectorModal` no longer embed a
  pictograph in their JSX, and the smoke matrix now covers all seven modal surfaces so the gap that
  let one through cannot reopen.
  `SIDE_PANEL_WIDTH` is 36 columns so the value column is 23 columns, and `memoryStat` formats its
  counters with `formatCount`; the 100-column threshold still leaves 44 columns for the
  conversation. Guards: `test/tui/sessionContext.test.ts`, `test/tui/ravenHeader.test.ts`,
  `test/tui/infoPanel.test.ts`, `test/tui/liveLayout.test.ts` and `src/tui/footer.test.ts`.

**Project skills** (`src/engine/skills/loader.ts`): `loadSkills()` discovers `*.md` skills in
`<project>/.huginn/skills/` then `<project>/.opencode/skills/` (`.huginn` wins on id collision),
parses a flat frontmatter subset (`name`/`title`, `description`/`desc`, `triggers`) plus a prompt
`body`, falls back to basename + first paragraph without frontmatter, and appends the built-in
`audit`, `refactor` and `explain` skills unless shadowed (`includeBuiltins`). The loader is
security-hardened: symlinked scan roots are rejected (`lstat` + `realpath` containment), files are
read through an `O_NOFOLLOW` fd capped at 1 MB, prototype-pollution keys are skipped, and every
field is sanitized via the shared `sanitizeTerminalText` (`src/util/text.ts` — relocated out of
`src/engine/agent/mcpConfig.ts`). A skill file is exactly what the README's
[Project skills](README.md#project-skills-huginnskills) section shows: YAML frontmatter, then the
prompt body.

These skills belong to the **live console** (`/skills`, `/skill <name>`); they are not injected into
the pipeline's phase prompts. The runtime's own resources are a separate matter: the in-process `pi`
driver uses pi's `DefaultResourceLoader`, so pi's MCP servers, skills (`~/.agents/skills`,
`.pi/skills`, `~/.pi/agent/skills`) and `AGENTS.md` are available to the phase prompt, and every
subprocess CLI loads its own resources the same way it does outside huginn.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

<!-- huginn:muninn-rules:start -->
## Muninn memory directives

This project is indexed by Muninn. Before designing any change, call
`muninn_context` and `muninn_inspect_symbol` to load the relevant symbols and
dependency paths. Before emitting any final code, call `muninn_verify_contract`.

Do not emit final code that has not been contract-verified.

If you need a decision from the user to proceed, ask with a marked block:
`<<<HUGINN_QUESTION>>>` + a JSON array of
`{"question", "options":[{"label","description"}]}` + `<<<END_HUGINN_QUESTION>>>`
on their own lines, and Huginn will present the choices.
<!-- huginn:muninn-rules:end -->
