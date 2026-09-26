# Huginn — Functional Specification

> `huginn` is a CLI/TUI orchestrator that drives the opencode
> spec → execute → validate → test → secure → review → doc → commit cycle.
> It executes iterations from `plan.md` against a git repository through
> opencode subagents and slash commands, gates every step with a verdict,
> routes fixes to a "thinker" model, and persists full state so runs can be
> resumed after an interruption.

This document describes what huginn *does*, as evidenced by the source in
`src/`. Requirement IDs are traceable: each REQ lists the module(s) that
implement it, and most are covered by the unit tests under `src/**/*.test.ts`.

## 1. Purpose

Huginn is a **build-cycle orchestrator for a single git repository**. It does
not write code itself; it drives the opencode agent runtime, which must be
installed, configured, and authenticated separately. The orchestrator's job is
to run each iteration of a plan through a fixed pipeline of eight phases, gate
each phase on a machine-parseable verdict, fix blocking findings by re-running
the build agent on a designated "thinker" model, and never lose progress: every
state change is persisted under `<project>/.harness/`.

## 2. Personas

| Persona | What they do with huginn |
|---|---|
| **Developer running builds** | Runs `huginn run --project <repo> --thinker <m> --executor <m>` to execute the cycle. Watches the TUI dashboard (or stdout in headless mode), answers gate/permission decisions, pauses, aborts, and resumes. |
| **Developer bootstrapping a project** | Runs `huginn plan --project <repo> --thinker <m> "<idea>"` to have the thinker draft `spec.md`, `adr.md`, and `plan.md` from one idea. |
| **Developer refining an idea interactively** | Runs `huginn live --project <repo> --thinker <m> --executor <m> "<idea>"` to chat-refine the idea with the thinker, approve the drafted/updated documents, and then execute the plan in the same dashboard. |
| **CI / automation** | Runs `huginn install --yes` (non-interactive install) and `huginn run --headless` with piped stdin. Unattended runs abort at gate decisions instead of hanging, preserving state for a later interactive `--resume`. |
| **huginn maintainer** | Reads `SPEC.md` / `DESIGN.md` / `ADR.md` / `AGENTS.md` and the unit tests; runs `bun test`, `bun run typecheck`, `bun run build`. |

## 3. System boundaries and integrations

- **Input documents**: `plan.md`, `spec.md`, `adr.md` (paths overridable via `--plan/--spec/--adr`). The `run` cycle and `plan` mode never edit them; `live` mode *does* write them (drafting updated spec/adr/plan and committing them only after explicit human approval).
- **opencode runtime**: huginn spawns `opencode serve --port <n> --hostname 127.0.0.1` (`src/server/lifecycle.ts`) and talks to it over HTTP using the `@opencode-ai/sdk` (`src/server/client.ts`). Agents/commands it invokes are installed into the opencode config dir by `huginn install` (`src/setup/install.ts`).
- **git**: required. The project must be a git repo; git is used for module inference, session bookkeeping, and context (`src/engine/diff.ts`).
- **Two models**: `--thinker` (fixes + plan drafting) and `--executor` (all gates, execution, docs, commits), both in `provider/model` form.
- **Persistence**: everything the harness writes lives under `<project>/.harness/` (`state.json`, `PROGRESS.md`, `reports/`, `logs/server.log`).

## 4. Functional requirements

### 4.1 CLI and entry point — `src/cli.ts`

- **REQ-1** — The CLI exposes exactly five commands: `run` (default), `live`, `plan`, `install`, and `help`. A positional `help` or `-h` prints the banner + usage and exits 0; a bare `--help` flag is *not* intercepted (it parses as a run-mode flag) and falls through to run-mode argument validation, exiting 1 with an error plus usage (`huginn live --help` *is* intercepted and exits 0). Unknown commands exit 1 with usage.
- **REQ-2** — `huginn run` requires `--project <path>` (a directory containing `.git` and, by default, `plan.md`, `spec.md`, `adr.md`), plus `--thinker <provider/model>` and `--executor <provider/model>`. Missing required values exit 1 before any server is started.
- **REQ-3** — Model strings are validated to the `provider/model` shape: a string with no `/`, an empty provider, or an empty model is rejected (`resolveModel` in `src/engine/modelRouter.ts`). The provider portion is additionally checked against the opencode server's configured provider list at startup, but the check is advisory: mismatches print a warning and the run continues (`validateModels`, `src/cli.ts`).
- **REQ-4** — Numeric flag values are parsed by `num()` which falls back to a default for non-numeric input and **clamps to ≥ 0**, so negative values (e.g. `--max-retries -1`) can never invert a loop or skip a phase.
- **REQ-5** — Paths are canonicalized (`canonicalize`, `src/cli.ts`): symlinks are resolved via `realpathSync` so paths embedded in agent prompts match what the opencode server resolves; non-existent paths fall back to `resolve()` (needed by `plan` mode before documents exist).
- **REQ-6** — Flags `--mode auto|supervised` (default `auto`), `--permissions auto|ask|deny` (default `auto`), `--max-retries <n>` (default 3), `--from-iteration <n>`, `--only-phase <name>` (validated against the 8 main phases), `--phase-timeout <ms>` (default 1 200 000 = 20 min; 0 disables), `--server-timeout <ms>` (default 60 000), `--port <n>` (default: an ephemeral free port on 127.0.0.1), `--tui`/`--headless` (default: TUI when stdout is a TTY), `--resume`, `--force-restart`, `--ignore-plan-changes` are honored exactly as documented in `usage()`.
- **REQ-7** — `SIGINT`/`SIGTERM` trigger a graceful abort: the engine's abort flag is set and the in-flight agent session is interrupted (`abortSession`), so the loop stops promptly rather than waiting out a phase timeout; the process force-exits after 3 s if the engine has not finished persisting state.
- **REQ-8** — On exit, the outcome is reported: `✨ [huginn] Plan completed successfully!`, `🛑 [huginn] Run aborted. State saved for --resume.`, or `✗ [huginn] Run failed: <error>`. A thrown/fatal error exits non-zero; completed and aborted outcomes are reported on the normal path.

### 4.2 Plan parsing — `src/plan/parser.ts`

- **REQ-9** — `plan.md` is parsed into iterations: any `#`–`####` heading matching `iteration <n>` with `—`, `-`, or `:` separators (case-insensitive) starts an iteration; everything up to the next such heading is that iteration's verbatim prompt. Headings in other languages (e.g. Spanish `Iteración`) are ignored.
- **REQ-10** — An optional `modules:` line immediately below the heading is parsed into a list of comma-separated paths; otherwise the iteration has no explicit modules.
- **REQ-11** — Iterations are executed in ascending numeric order regardless of their order in the file. A plan with zero iterations is an error at load time.

### 4.3 The cycle — `src/engine/cycle.ts`, `src/engine/phases.ts`

- **REQ-12** — Each iteration runs the eight main phases in this fixed order: `SPEC_AUDIT`, `EXECUTE`, `VALIDATE_STEP`, `TEST_MODULE`, `SECURE_CHECK`, `REVIEW`, `DOC_SYNC`, `COMMIT_ALL` (the `PIPELINE` table; `MAIN_PHASES` in `src/engine/types.ts`).
- **REQ-13** — `SPEC_AUDIT` invokes the `spec-auditor` subagent directly with the spec, ADR, plan, the current iteration, and `git status`, asking for the `Overall fidelity: 🟢/🟡/🔴` verdict line. **Greenfield skip**: if the repo contains no implementation code (`hasImplementationCode`, `src/engine/diff.ts` — git-tracked or untracked files with a source extension, excluding config/scaffolding/docs), the audit is *skipped* instead: a `skipped`-verdict history entry is recorded and the agent is never invoked, because there is nothing to audit until the iteration produces code.
- **REQ-14** — `EXECUTE` sends the iteration's prompt verbatim to the built-in `build` agent (model: executor). It is non-blocking (never gated), but it still fails closed: an empty `EXECUTE` report (the build agent returned no output — possible when `session.prompt` resolves on a step boundary such as a reasoning-only turn) is treated as a phase failure and retried/escalated, never counted as a pass.
- **REQ-15** — `VALIDATE_STEP`, `TEST_MODULE`, `SECURE_CHECK`, `REVIEW`, `DOC_SYNC`, `COMMIT_ALL` are run as opencode slash commands (`/validate-step <modules> <spec>`, `/test-module <modules>`, `/secure-check`, `/review`, `/doc-sync`, `/commit-all`) via `runCommand`.
- **REQ-16** — The module list for `VALIDATE_STEP`/`TEST_MODULE` comes from the iteration's `modules:` line when present; otherwise it is inferred from git changes since the iteration's base commit (`inferModules`, `src/engine/diff.ts`).
- **REQ-17** — `DOC_SYNC` and `COMMIT_ALL` are informative: their verdicts are recorded but they can never block the run (`blocking: false` in the pipeline).
- **REQ-18** — Blocked, blocking gates trigger a fix pass: the relevant finding report is given to the `build` agent running on the **thinker** model (`fixFindings`/`fixSpec`/`fixSecurity`), up to `--max-retries` fix attempts per gate. `FIX_SPEC` carries spec-specific instructions (implement as written; align the spec only if objectively wrong); `FIX_SECURITY` carries an absolute no-advance-past-breach instruction.
- **REQ-19** — After the retry budget is exhausted the run escalates: it requests a human decision (retry with a reset budget, force-continue past the gate, or abort). In `supervised` mode the same decision is requested at every blocked gate; in `auto` mode only when the budget is exhausted.
- **REQ-20** — A phase that fails with an exception (provider stall, timeout, API error) is retried up to `maxRetries` times, then escalated to the same three-way decision — one failed phase must not kill the whole run.
- **REQ-21** — `--only-phase <name>` runs a single phase per iteration for debugging and leaves the state resumable (no completion marker is written); `--from-iteration <n>` skips earlier iterations.

### 4.4 Verdicts and gates — `src/engine/gate.ts`

- **REQ-22** — A verdict is one of `pass | warning | blocked | skipped`. The three gate styles produce only `pass`/`warning`/`blocked` (see REQ-23/REQ-24); `skipped` is produced solely by the greenfield `SPEC_AUDIT` skip (REQ-13) and never by a parser or the judge. `VALIDATE_STEP` verdicts come from `parseValidateStepVerdict`, which merges every signal it finds by severity (`blocked > warning > pass`): the `### Overall gate: 🟢/🟡/🔴` line, the trailing human-handoff markers `✅ AUTO-APPROVED`/`⚠️ REVIEW REQUESTED`/`🛑 BLOCKED`, and near-miss prose the reviewing agent occasionally emits (e.g. `🟡 PASS WITH WARNINGS — REVIEW REQUESTED` without the emoji markers). Severity merging means a contradiction (e.g. `🟢 PASS` overall plus a `🛑 BLOCKED` handoff) can never downgrade the report, and the prose signals are negation-aware (`no 🔴`, `not blocked`, `not yet auto-approved` are not read as verdicts); a report with no explicit verdict still fails closed (`null`). `SPEC_AUDIT` verdicts come from `parseSpecAuditVerdict`: `Overall fidelity: 🟢/🟡/🔴` or the words `ALIGNED`/`MINOR DRIFT`/`MAJOR DEVIATION`.
- **REQ-23** — **Gates fail closed.** A report with no parseable verdict marker (empty, truncated, or hallucinated output) yields `null` from the parsers, which the engine converts to `BLOCKED` with a warning log entry — never to a silent pass (`gatedVerdict`, `src/engine/cycle.ts`).
- **REQ-24** — `TEST_MODULE`, `SECURE_CHECK`, and `REVIEW` are gated by a "judge": a separate executor-model pass that classifies the phase report into strict JSON `{"status","summary","actionItems"}` (`judgePhase`). Structured output is preferred; if the judge's output is unparseable, text heuristics apply, and if those fail the gate fails closed to `blocked` with `parsed: false` (logged).

### 4.5 Decisions — `src/engine/decisionBroker.ts`, `src/engine/types.ts`

- **REQ-25** — Decisions are answered with one of `retry | continue | abort | allow | deny`. Five request kinds are actually emitted at runtime: `gate-blocked` (engine escalations), `permission` (permission subscriber), and — from live mode (REQ-48–51) — `approve-draft`, `scope-extraction`, and `draft-format` (all with `phase: "LIVE"`); a sixth kind, `spec-deviation`, exists in the `DecisionKind` type but is not currently requested by any code path. Multiple requests may be in flight concurrently (e.g. a blocked gate while a permission request arrives).
- **REQ-26** — Pending decisions are presented and resolved strictly in arrival order (FIFO). Only the head of the queue is surfaced to the UI at a time, and resolving it surfaces the next. A pending decision can never be silently overwritten.
- **REQ-27** — On abort (or any error path), all pending decisions are resolved with `abort` so no promise is left orphaned (which previously hung the run).
- **REQ-28** — Headless + TTY: one-key answers (`r`/`c`/`a` for gates, `a`/`o`/`d` for permissions). Headless + non-TTY (CI, piped stdin): permission requests are denied, gate decisions abort the run so state is preserved for a later `--resume`.

### 4.6 State and resumability — `src/state/store.ts`, `src/state/schema.ts`

- **REQ-29** — The harness writes only under `<project>/.harness/`: `state.json` (source of truth, zod-validated schema `version: 1`), `PROGRESS.md` (regenerated after every phase), `reports/II-PHASE-N.md` (one file per attempt), and `logs/server.log` (the opencode server's output).
- **REQ-30** — State is persisted atomically: `saveState` writes `state.json.tmp` then renames over `state.json`, so an interrupted write cannot corrupt the previous state. Corrupt state fails loudly at load rather than being silently reset.
- **REQ-31** — `state.json` records `currentIteration`, `currentPhase`, per-`iteration:phase` attempt counts, the full history of phase attempts (verdict, model, session, message, summary, report path, timestamps), the iteration's session id and base commit, and the models/mode in use.
- **REQ-32** — `computePlanHash` is a SHA-256 over the basename + contents of `plan.md`/`spec.md`/`adr.md`. Hashing by basename makes the hash survive the repo being moved or re-cloned to a different directory.
- **REQ-33** — On a plain re-run, existing state is resumed automatically. `--resume` additionally *requires* saved state (error otherwise); `--force-restart` discards it; if the saved plan hash differs from the current documents, the run refuses to start unless `--ignore-plan-changes` is passed.
- **REQ-34** — `PROGRESS.md` shows per-iteration phase progress as `done/8`, counting only the 8 main phases with `pass`/`warning`/`skipped` verdicts (fix-phase entries never inflate the count), plus status (▶ RUNNING / ✅ COMPLETED / 🛑 ABORTED).
- **REQ-35** — On resume, the opencode session for the current iteration is reused if it still exists; a new session (`iter N: <title>`) is created otherwise. The model and mode are always taken from the current CLI flags on resume.

### 4.7 Plan mode — `src/engine/planMode.ts`

- **REQ-36** — `huginn plan --project <repo> --thinker <m> "<idea>"` drafts the three input documents in sequence, all on the thinker model in one opencode session: `spec.md` (numbered, traceable requirements), then `adr.md` given the spec (ADR entries with alternatives/tradeoffs), then `plan.md` given spec + ADR (strict `## Iteration N — Title` format, optional `modules:` lines, 3–8 iterations).
- **REQ-37** — A long prompt may be supplied via `--prompt-file <file>` instead of a positional argument; the positional idea is otherwise required.
- **REQ-38** — Plan mode refuses to overwrite any existing `spec.md`/`adr.md`/`plan.md`; `--force` is required to overwrite (checked in both `src/cli.ts` and `runPlanMode`).
- **REQ-39** — Each drafting prompt has a hard 20-minute timeout (`PLAN_PROMPT_TIMEOUT_MS`); the thinker's streamed text and reasoning deltas are printed live to stdout alongside a colorized `STEP n/3` badge and a `Drafting …`/`✓ Wrote …` (bytes, elapsed) line per document; on completion the exact `huginn run ...` command is printed, with the configured thinker model filled in.
- **REQ-40** — `huginn run`/`huginn plan`/`huginn live` all warn (but do not block) when required opencode agents/commands are missing, pointing at `huginn install`.

### 4.8 Installer — `src/setup/install.ts`, `scripts/postinstall.ts`

- **REQ-41** — The installer ships exactly 11 templates: 5 agents (`spec-auditor`, `qa`, `security`, `doc-writer`, `reviewing`) and 6 commands (`validate-step`, `test-module`, `secure-check`, `review`, `doc-sync`, `commit-all`), copied from `templates/{agents,commands}/*.md` into `~/.config/opencode/{agents,commands}/`.
- **REQ-42** — Installation never overwrites an existing destination file unless `--force` is passed (personalized config is left alone); it is idempotent without `--force`. `--only agents|commands` restricts the operation.
- **REQ-43** — `huginn install` lists what is missing, asks for confirmation (skipped with `--yes` or in CI), installs, and reports installed/overwritten/skipped/still-missing. The `postinstall` hook runs on `bun install`: silent when everything is present, prompts when interactive, prints a hint to `huginn install --yes` when unattended.
- **REQ-44** — Paths are overridable: `HUGINN_TEMPLATES_DIR` (templates source, also auto-detected by walking up from the module location so it works from `src/`, `dist/`, and `scripts/`) and `HUGINN_OPENCODE_CONFIG_DIR` (install destination).

### 4.9 TUI / headless — `src/tui/*`, `src/headless.ts`

- **REQ-45** — The TUI is an Ink/React dashboard with native Markdown token rendering (`MarkdownLine` for bold, code, headings, lists, and quotes). In cycle mode it shows the 8-phase checklist with verdict icons and attempt counts (fix phases as indented children of their gate), live agent-stream tail — text/reasoning deltas plus tool-execution (`⚡`/`✓`/`✗`) and file-edit (`📝`) marker lines (last 10 lines; 22 in verbose mode), log tail, the last report summary, and the pending decision box. Keyboard: `space`/`p` pause–resume, `v` toggle verbose stream, `q`/`Esc` abort, and the decision keys `r`/`c`/`a` (gates) or `a`/`o`/`d` (permissions). In live mode (`LiveDashboard`), dual cards (Refinement Conversation & Thinking Stream) support `[Tab]` focus switching and independent line scrolling (`[PageUp]`/`[PageDown]` and `[↑]`/`[↓]`).
- **REQ-46** — Headless mode renders the same events as stdout text lines (iteration banners, phase start lines with model + attempt, verdict badges with durations, timestamped log lines) and answers decisions via stdin, with the non-TTY behavior from REQ-28. On exit it prints a final execution summary box counting `pass`/`warning`/`blocked`/`skipped` verdicts plus total elapsed time. Pausing is engine-level (`pause()`/`resume()` poll every 200 ms) and works identically in both frontends.

### 4.10 Permissions and questions — `src/engine/permissions.ts`

- **REQ-47** — Permission and question requests from the opencode event stream (`permission.updated`, `permission.asked`, `question.asked`) are handled per `--permissions`: `auto` approves permissions (`always`) and auto-answers questions with their recommended/first option, logging every action; `deny` rejects permissions and questions; `ask` routes the request through the decision flow (`DecisionBroker`, answers map to `always`/`once`/`reject` for permissions and accept/reject for questions).

### 4.11 Live mode — `src/engine/liveMode.ts`, `src/engine/liveRepo.ts`

- **REQ-48** — `huginn live --project <repo> --thinker <m> --executor <m> ["<idea>"]` runs an interactive refine → draft → approve → execute flow in one opencode session (`LiveEngine`). In the **refine** stage the thinker answers chat messages grounded in the current repo state (`repoContext`: last 30 git log entries, `git status --short`, source tree) and any existing `spec.md`/`adr.md`/`plan.md`; the first user message carries a system prompt, later turns carry session history. In headless mode the chat stage is skipped and the CLI idea is used as-is.
- **REQ-49** — Typing `/draft` triggers scope extraction: the thinker must reply with a `SCOPE:` line followed by a fenced markdown block (`extractScopeBlock`). An unparseable reply is **fail-closed**: the run requests a `scope-extraction` decision (retry / proceed with the user's last message as scope / abort) instead of inventing a scope.
- **REQ-50** — Drafts are format-contract-enforced: `spec.md` is written via `updateSpecPrompt` (rewritten or created from scratch), `adr.md` gets new `## ADR-N:` entries *appended* to the existing file (`appendAdrPrompt`, `NONE` means "no new entries needed"), and `plan.md` is (re)drafted from the remaining work (`remainingPlanPrompt`). `validateDraftFormat` checks each document against `OUTPUT_FORMAT_CONTRACT` (spec starts with `# ` and contains `REQ-`; adr entries are `## ADR-<N>:` or exactly `NONE`; plan parses to ≥ 1 iteration). A violating draft is retried once with the violation as feedback, then a `draft-format` decision is requested (retry / accept as-is / abort).
- **REQ-51** — Drafted docs are staged as intent-to-add (`git add -N`) so `git diff HEAD -- <docs>` shows them for the human; the `approve-draft` decision offers re-draft (regenerates from the latest chat), OK — commit & execute, or abort. On approval the docs are committed (`docs(scope): <first line of scope>`, `commitDocs`), any stale `.harness/` state is cleared (`resetHarnessState`), the plan is re-parsed, and a fresh `CycleEngine` runs the cycle with the same client/session; after handoff, `ask`/`resolveDecision`/`requestAbort` route to the cycle engine. On completion of all iterations in live mode, a `post-cycle-live` decision modal prompts the user to either exit cleanly or return to the live refinement loop (`RefineView`) for ongoing iterations. On abort the intent-to-add staging is dropped (`unstageDocs`) so nothing review-only lingers in the index.

### 4.12 Background update check — `src/update.ts`

- **REQ-52** — `huginn run`/`plan`/`live` fire a non-blocking npm registry check (`maybePrintUpdateReminder`, never awaited) against `https://registry.npmjs.org/<pkg>/latest` with a 3-second fetch timeout (unref'd timer). It never delays or fails the run: a newer version only prints a yellow stderr reminder with the update command. Results are cached in `<opencode-config-dir>/huginn-update-cache.json` for 24 h (`UPDATE_CHECK_TTL_MS`); a stale cache is used as fallback when the registry is unreachable; any non-empty `HUGINN_NO_UPDATE_CHECK` disables the check entirely. Version comparison is a lightweight semver (`compareVersions`, `src/update.ts`).

## 5. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-1 | Failure handling | No single phase failure or provider stall may hang the run: phase exceptions are retried up to `maxRetries`, then escalated to a human decision (REQ-20). Every phase step has a hard deadline (`--phase-timeout`, default 20 min) enforced with `AbortController` + `session.abort`; the deadline being 0 disables it. |
| NFR-2 | Fail-closed | A gate with no parseable verdict is treated as BLOCKED and logged, never silently passed (REQ-23, REQ-24). The judge fails closed to `blocked` on unreadable output. |
| NFR-3 | Auditability | Every phase attempt, verdict, fix, error, and permission auto-approval/denial is recorded: in `state.json` history, in `reports/`, in `PROGRESS.md`, and/or in the event log. Model and attempt number accompany each entry. |
| NFR-4 | Resumability | Full execution state is persisted after every phase via atomic writes; interrupted runs resume from the exact phase on re-run; the resume hash is path-independent (REQ-29–35). |
| NFR-5 | Portability | Runtime is Bun only; the target repo must have `git` and a working `opencode` CLI with authenticated providers. No state is stored outside `<project>/.harness/` and the opencode config dir. Paths are canonicalized to resolve symlink mismatch; env overrides cover templates source/destination for unusual layouts. |
| NFR-6 | Determinism of parsing | Plan parsing, verdict parsing, and plan hashing are pure functions covered by unit tests (`src/plan/parser.test.ts`, `src/engine/gate.test.ts`, `src/state/store.test.ts`). |
| NFR-7 | Non-interference | The `run` cycle never modifies `plan.md`/`spec.md`/`adr.md` or source code; all fixes are produced by the opencode agents, and `.harness/` is excluded from git-change detection (`.gitignore`, `src/engine/diff.ts`). The only writers of the documents are `plan` mode (creation time) and `live` mode (explicitly human-approved drafts, committed as a `docs(scope)` commit). |

## 6. Out of scope

- Writing application code, tests, or commits itself — all build actions are performed by opencode agents/commands.
- Multi-repository or multi-project orchestration, scheduling, and CI/CD orchestration (though it is *usable* from CI).
- Editing the plan/spec/adr documents during `run` (only `plan` mode writes them at creation time, and `live` mode writes/commits them after explicit human approval).
- Model/provider authentication or credential management — that is opencode's domain.
- Anything beyond the single local `opencode serve` process for server orchestration (no TLS, no remote endpoints).
- Support for non-git workspaces — a git repo is a hard prerequisite for `run`.
