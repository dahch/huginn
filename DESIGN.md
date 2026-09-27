# Huginn — Technical Design

This document describes how huginn is built, from the source in `src/`. It is
the implementation counterpart to [`SPEC.md`](./SPEC.md) and the decisions are
rationalized in [`ADR.md`](./ADR.md).

## 1. Runtime and dependencies

- **Runtime**: [Bun](https://bun.sh). The `bin` entry `huginn` → `dist/cli.js`,
  produced by `bun build src/cli.ts --target=bun --outdir=dist --minify`.
- **Dependencies actually imported in `src/`**:
  - `@opencode-ai/sdk` — typed HTTP client for the opencode server.
  - `@modelcontextprotocol/sdk` — Model Context Protocol SDK for agent tooling.
  - `better-sqlite3` — embedded SQLite database driver with WAL mode and FTS5 for the Muninn memory engine (`src/muninn/db/client.ts`).
  - `typescript` — TypeScript Compiler API for static AST analysis, contract verification, and symbol indexing (`src/contracts/compiler.ts`, `src/muninn/indexer/ast-indexer.ts`).
  - `ink` + `react` — the TUI dashboard.
  - `zod` — `HarnessState` schema validation.
  - `chalk` — ANSI colors in the banner (`src/banner.ts`), headless frontend
    (`src/headless.ts`), CLI output (`src/cli.ts`), plan mode
    (`src/engine/planMode.ts`), shared formatting (`src/format.ts`), and the
    update reminder (`src/update.ts`).
- `react-devtools-core` is declared in `package.json` but not imported
  anywhere in `src/` (declared, unused — do not rely on it).
- **External executables**: `opencode` (spawned as a local server), `git`
  (spawned for diffs and module inference). Nothing else.

## 2. Module map

```
src/
├── cli.ts                  entry point; arg parsing (run/live/plan/install/memory/mcp/check), config, banner, lifecycle wiring
├── commands/
│   ├── check.ts            CLI commands: handleCheckCommand (verify TypeScript contracts), printCheckUsage
│   └── memory.ts           CLI commands: handleMemoryCommand (init, search, sync, index), handleMcpCommand (run), usage formatters
├── config.ts               RunConfig type (all run-mode knobs)
├── contracts/
│   ├── compiler.ts         TypeScript Compiler API contract verification, pre-emit diagnostics, visual error snippets
│   └── index.ts            re-exports verifyTypeScriptContracts, formatDiagnosticsReport, TypeValidator, types
├── banner.ts               ASCII banner + path shortening
├── format.ts               shared formatting: durations, verdict badges/icons/colors
├── headless.ts             stdout frontend; stdin decision answering; runLiveHeadless
├── update.ts               background npm version check (cache + semver compare + reminder)
├── engine/
│   ├── cycle.ts            CycleEngine: pipeline-as-data, retry/fix/escalate loop, state machine
│   ├── phases.ts           the 8 phase functions + 3 fix functions; builds prompts/commands
│   ├── gate.ts             verdict parsers, JSON judge, fail-closed logic
│   ├── decisionBroker.ts   FIFO queue of pending human/permission decisions
│   ├── permissions.ts      opencode event subscription: permission handling + stream forwarding
│   ├── planMode.ts         `huginn plan`: drafts spec/adr/plan via the thinker; exported prompt
│   │                       builders + draft-format contract reused by live mode
│   ├── liveMode.ts         LiveEngine: chat-refine → scope → draft → approve → handoff to CycleEngine
│   ├── liveRepo.ts         live-mode git helpers: repo context, intent-to-add staging, docs commit
│   ├── modelRouter.ts      "provider/model" → {providerID, modelID} + back
│   ├── diff.ts             git helpers, inferModules, hasImplementationCode (greenfield detection)
│   ├── engineEvents.ts     global typed event emitter
│   └── types.ts            shared types (Verdict, PhaseName, DecisionRequest, …)
├── muninn/
│   ├── db/
│   │   ├── client.ts       better-sqlite3 initialization, pragmas, path resolution, ensureProject, sanitizeGitRemote
│   │   └── schema.sql      DDL for projects, observations, observations_fts, entities, observation_entities, entity_dependencies
│   ├── indexer/
│   │   ├── ast-indexer.ts  AST symbol/dependency extraction, batch indexing into Muninn, zombie entity pruning
│   │   └── index.ts        re-exports extractAstData, extractSymbolsFromSource, indexFilesIntoMuninn, types
│   ├── mcp/
│   │   ├── index.ts        re-exports createMcpServer, startMcpServer, TOOL_REGISTRY, schemas, and types
│   │   └── server.ts       MCP server implementation: JSON-RPC over stdio, Zod schemas, normalizeArgs, error handling
│   └── service/
│       ├── index.ts        re-exports MemoryService, IMemoryService, and types
│       └── memory-service.ts MemoryService core + IMemoryService interface: saveObservation, search, getContext, linkSymbol, inspectSymbol, getStats, syncToDisk, importFromDisk
├── server/
│   ├── lifecycle.ts        spawn/kill `opencode serve`, health polling, server.log
│   └── client.ts           SDK wrapper: createClient, prompt/runCommand, withTimeout
├── setup/
│   └── install.ts          template discovery, install/uninstall bookkeeping
├── state/
│   ├── store.ts            .harness/ layout, atomic state persistence, progress markdown
│   └── schema.ts           zod schema for HarnessState/HistoryEntry
├── plan/
│   ├── parser.ts           plan.md → Iteration[]
│   └── types.ts            Iteration type
└── tui/
    ├── app.tsx             runTui entry
    ├── render.tsx          ink render + engine.run() error bridge; renderLiveTui
    ├── Dashboard.tsx       the run-cycle dashboard component
    └── LiveDashboard.tsx   the live-mode dashboard (chat, stage, approval box)
scripts/postinstall.ts       bun install hook → installer prompt
templates/{agents,commands}/ opencode agent/command definitions bundled as markdown
```

### Runtime wiring (`src/cli.ts` → engine → frontends)

```mermaid
flowchart TD
    CLI["cli.ts main()"] --> CMD{"command?"}
    CMD -- "run" --> RUN["startServer() → CycleEngine"]
    CMD -- "plan" --> PLAN["runPlan()"]
    CMD -- "live" --> LIVE["LiveEngine"]
    CMD -- "install" --> INST["runInstall()"]
    CMD -- "memory" --> MEM["handleMemoryCommand()"]
    CMD -- "mcp" --> MCP["handleMcpCommand()"]
    CMD -- "check" --> CHK["handleCheckCommand()"]

    MEM --> MS["MemoryService"]
    MCP --> SRV["startMcpServer() (stdio)"]
    CHK --> TC["verifyTypeScriptContracts()"]

    RUN --> SEV["subscribeToEvents()"]
    SEV -- permission / stream events --> CE["CycleEngine"]
    CE -- decision requests --> DB["DecisionBroker FIFO"]
    DB -- head surfaced --> FE{"TUI or headless"}
    FE -- choices --> DB
    CE -- events --> EE["engineEvents global emitter"]
    EE --> FE
    CE -- persist --> HAR[".harness/ state + PROGRESS.md + reports"]
```

`CycleEngine` is transport-agnostic: it never touches the terminal. Both
frontends (Ink TUI, stdin headless) are thin adapters over the global `events`
emitter plus `engine.resolveDecision()`. Memory persistence, AST indexing,
contract verification, and MCP operations route cleanly through
`handleMemoryCommand`, `handleCheckCommand`, and `handleMcpCommand` without
spawning harness server instances.

## 3. The cycle: pipeline-as-data

The core structure is a **data table** instead of hardcoded phase code
(`src/engine/cycle.ts`):

```ts
interface PipelineStep {
  phase: PhaseName;          // SPEC_AUDIT | EXECUTE | ... | COMMIT_ALL
  fn: PhaseFn;               // the phase function from phases.ts
  gate: "spec-audit" | "validate-step" | "judge" | "none";
  fixPhase: PhaseName | null; // FIX_* phase to run when blocked
  fixLabel: string;
  blocking: boolean;
}
```

| phase | fn | gate | fixPhase | blocking |
|---|---|---|---|---|
| SPEC_AUDIT | `specAudit` | spec-audit | FIX_SPEC | ✅ |
| EXECUTE | `execute` | none | — | — |
| VALIDATE_STEP | `validateStep` | validate-step | FIX_VALIDATE | ✅ |
| TEST_MODULE | `testModule` | judge | FIX_TEST | ✅ |
| SECURE_CHECK | `secureCheck` | judge | FIX_SECURITY | ✅ |
| REVIEW | `review` | judge | FIX_REVIEW | ✅ |
| DOC_SYNC | `docSync` | none | — | — |
| COMMIT_ALL | `commitAll` | none | — | — |

The retry/fix/escalation loop (`runPhase`) is the same for every step:

```mermaid
flowchart TD
    A[runPhase step] --> B[attempt = 0]
    B --> C[runOnce: step.fn]
    C -- throws --> D{retries left?}
    D -- yes --> B2[attempt++]
    D -- no --> E[decision: retry / continue / abort]
    B2 --> C
    C --> F{gate type}
    F -- none --> G[pass - done]
    F -- spec-audit/validate-step --> H[parse verdict or BLOCKED if null]
    F -- judge --> I[judgePhase on executor → status + parsed flag]
    H --> J{verdict}
    I --> J
    J -- pass/warning or non-blocking --> G
    J -- blocked --> K{fix budget left?}
    K -- yes --> L[FIX_* on thinker model] --> B2
    K -- no --> M{supervised?}
    M -- yes --> E
    M -- no --> E
```

Key behaviors:

- **Greenfield skip**: `SPEC_AUDIT` never runs against a repo with no
  implementation code. `hasImplementationCode` (`src/engine/diff.ts`)
  classifies the repo from `git ls-files --cached --others --exclude-standard`
  — a file counts when it has a source extension from `SOURCE_EXTENSIONS`, is
  not in an ignored dir, and is not a hidden or doc file (config/scaffolding/
  docs don't count). When false, the phase is recorded with verdict `skipped`
  (`recordSkippedSpecAudit`): a history entry and verdict event, but no agent
  call and **no attempt counted** (`phaseAttempts` untouched, so a later real
  audit on resume still starts at attempt 1).
- **Attempt counting** is per `iteration:phase` and persisted in
  `state.phaseAttempts`, so resume continues the numbering (`state.phaseAttempts[key]`).
- **Phase exceptions** (provider stall, timeout, API error) are treated like a
  blocked gate for retry purposes but *never* trigger a thinker fix — they retry
  then escalate (`recordError` writes a `blocked` history entry with a report).
- **Empty `EXECUTE` reports fail closed**: `session.prompt` can resolve on a
  step boundary (e.g. a reasoning-only turn) while the build agent is still
  working, yielding a report with no output. An empty `EXECUTE` result is
  thrown as a phase failure — retried, then escalated — never counted as a pass.
- **Fix phases close their UI row**: `recordFix` emits a `pass` verdict and a
  `phaseEnd` for the `FIX_*` phase (after `runPhase` already emitted its
  `phaseStart`), so the dashboard's fix row terminates with a verdict instead
  of hanging in a spinner state.
- **`retry` from a decision resets the whole budget** (`attemptRun = -1`), so a
  human can keep fixing manually and re-running.
- **`--only-phase`** runs just one step per iteration and leaves state
  resumable: no `finishedAt` is written and `done` is set after the single phase.

## 4. The decision flow (DecisionBroker)

Decisions come from multiple producers:

1. The **engine** — `gate-blocked` escalations, `approve-draft`, `scope-extraction`, and `draft-format` decisions (`requestDecision`).
2. The **event subscription** — `permission` and `question` requests in
   `--permissions ask` mode (`subscribeToEvents` in `src/engine/permissions.ts`).

Both funnel into one FIFO broker (`src/engine/decisionBroker.ts`):

```mermaid
sequenceDiagram
    participant E as CycleEngine
    participant P as permissions.ts
    participant B as DecisionBroker
    participant U as TUI / headless

    E->>B: request(gate-blocked)      (queued, head → emits decision)
    P->>B: request(permission)        (queued behind, silent)
    U->>B: resolve(choice)            (shifts head, emits decisionResolved)
    B-->>E: promise resolves "retry"  (engine continues its loop)
    B->>U: emits decision (permission) — next head surfaced
    U->>B: resolve(choice)
    E->>B: requestAbort()             (abort path)
    B-->>E: resolveAll("abort")       (drains queue, no orphaned promises)
```

Why FIFO matters: both request kinds can be in flight at once. If the UI
rendered only "the latest" request and resolved that one, the earlier promise
would never settle and the engine's `await` would hang forever. Surfacing only
the head and resolving in arrival order guarantees every request gets exactly
one answer. `resolveAll` on abort/error is the safety net that guarantees no
pending `await` outlives the run.

Frontend mapping of choices:

- Headless TTY: `r`/`c`/`a` (gate), `a`/`o`/`d` (permission).
- Headless non-TTY: permission → `deny`, gate → `abort` (state preserved for resume).
- TUI: same keys; `space`/`p` toggles engine pause (polled every 200 ms), `q`/`Esc` aborts.
- Permission `ask` answers map to opencode responses: `deny`→`reject`,
  `continue`→`always`, `retry`→`once`.

## 5. Gate model

```mermaid
flowchart LR
    A[phase report] --> B{gate type}
    B -- spec-audit --> C[parseSpecAuditVerdict]
    B -- validate-step --> D[parseValidateStepVerdict]
    B -- judge --> E[judgePhase]
    C --> F{Verdict or null}
    D --> F
    F -- null --> G[gatedVerdict → BLOCKED + warn log]
    F -- verdict --> H[record + proceed]
    E --> I{parsed?}
    I -- yes --> H
    I -- no --> J[heuristics → else blocked, parsed:false + warn]
```

- The two parser functions return `Verdict | null`. `null` means "no parseable
  marker" and the engine's `gatedVerdict()` maps it to `blocked` with a warning
  — **fail closed**.
- `validate-step` verdicts merge every signal by severity (`blocked > warning >
  pass`): the `### Overall gate:` line, the trailing handoff markers from
  `templates/commands/validate-step.md`, and near-miss prose. Severity merging
  means a contradiction (e.g. a 🟢 overall gate plus a `🛑 BLOCKED` handoff)
  can never downgrade the report; the prose signals are negation-aware so a
  clean report listing what it does NOT contain (`no 🔴`, `not blocked`) is not
  misread.
- `spec-audit` verdicts come from the `Overall fidelity:` line or the bare
  keywords `MAJOR DEVIATION` / `MINOR DRIFT` / `ALIGNED`.
- `judgePhase` asks the **executor** model to classify a report as strict JSON
  (`extractJson` does brace-matching extraction; `normalizeJudgeOutput`
  validates the shape). Reports are truncated to 24 000 chars before judging.
  If the judge's own output can't be parsed, keyword heuristics run, and if
  those also fail the gate fails closed to `blocked` (`parsed: false` is logged
  so unreadable-judge events are distinguishable).
- Non-blocking steps (`EXECUTE`, `DOC_SYNC`, `COMMIT_ALL`) record their verdict
  but never stop the pipeline.
- `skipped` is a fourth `Verdict` value that lives *outside* the gate model: it
  is never returned by the two parsers or the judge — only by the greenfield
  `SPEC_AUDIT` skip — and it neither passes nor blocks the pipeline. The
  progress renderer and both frontends treat it as a pass-equivalent
  (`⏭️` icon) for display.

## 6. Timeout model

Every model interaction goes through `withTimeout` (`src/server/client.ts`):

```mermaid
sequenceDiagram
    participant E as engine/phase
    participant W as withTimeout
    participant S as opencode server

    E->>W: prompt/runCommand(timeoutMs)
    W->>S: fetch with AbortSignal
    Note over W: timer armed (default 20 min)
    S-->>W: never responds (stall)
    W->>W: fire onTimeout → session.abort (best effort)
    W->>W: ac.abort(signal) + reject PhaseTimeoutError
    W-->>E: PhaseTimeoutError → engine retries/escalates
    Note over W: late settlement logged ("settled after its timeout")
```

- `timeoutMs <= 0` disables the deadline entirely (no `AbortController`).
- On timeout the **local fetch is aborted** *and* the **server-side agent is
  interrupted** via `client.session.abort` (best effort), so the provider isn't
  left churning.
- Settlements that race the timeout are logged (`request settled after its
  timeout; the provider may still be processing`) instead of corrupting results.
- The same mechanism backs `huginn plan`'s and `huginn live`'s 20-minute
  drafting/chat prompts (`PLAN_PROMPT_TIMEOUT_MS` / `LIVE_PROMPT_TIMEOUT_MS`).

## 7. State machine and resume

State is one zod-validated document, `HarnessState` (`src/state/schema.ts`):

```mermaid
stateDiagram-v2
    [*] --> RUNNING: run() starts
    RUNNING --> RUNNING: per phase → persist()
    RUNNING --> COMPLETED: all iterations done
    RUNNING --> ABORTED: abort/error → resolveAll + persist(aborted=true)
    RUNNING --> [*]: SIGINT/SIGTERM → requestAbort (interrupts agent + sets flag)
    COMPLETED --> [*]
    ABORTED --> RUNNING: re-run (auto-resume) or --resume
    ABORTED --> [*]: --force-restart wipes .harness/
```

- **Checkpoints**: `persist()` (write `state.json` atomically via tmp+rename,
  regenerate `PROGRESS.md`, emit `stateUpdated`) runs after every phase, after
  fixes, after session creation, and at iteration boundaries. The engine only
  checks the abort flag between steps, so an abort always lands on a consistent
  checkpoint. Requesting an abort (`requestAbort`) additionally interrupts the
  in-flight agent session (`abortSession`, `src/server/client.ts`) so the loop
  observes the abort immediately instead of waiting out a long phase timeout;
  the run's catch path then reports the outcome as *aborted*, not *error*.
- **Resume hash**: `computePlanHash([plan, spec, adr])` is SHA-256 over
  `basename \0 contents \0` per file. Because it uses basenames, the hash is
  identical after the repo is moved/cloned elsewhere (verified by
  `src/state/store.test.ts`). `run` refuses to resume a run whose documents
  changed, unless `--ignore-plan-changes`; `--force-restart` wipes everything.
- **Resume point**: `currentIteration`/`currentPhase` select the exact step.
  `runIteration` captures the resume phase once, then skips steps until it is
  reached (`pastResume` flag); `phaseAttempts` carries over so attempt numbers
  stay monotonic.
- **Session reuse**: `iterationSessionId` is reused when it still exists on the
  server; otherwise a fresh session `iter N: <title>` is created. `--only-phase`
  keeps state resumable (no `finishedAt` written), matching `PROGRESS.md`'s
  RUNNING status.
- **Models on resume**: the saved models/mode are *replaced* by the current
  flags (`state = { ...existing, models, mode }`), so re-running with different
  models is intentional and allowed.
- **Progress counting**: `renderProgressMarkdown` counts only `MAIN_PHASES`
  entries with `pass`/`warning`/`skipped` — the `done/8` gauge can never
  exceed 8 no matter how many `FIX_*` attempts happened.

## 8. Live mode

`huginn live` is a second frontend-agnostic engine, `LiveEngine`
(`src/engine/liveMode.ts`), that deliberately reuses the pieces `run` already
has instead of inventing new ones:

- **One opencode session** per live session (`huginn live: <project>`), exactly
  like the cycle's per-iteration session; every model call is `prompt` with the
  **thinker** model and the same 20-minute `withTimeout` budget.
- **The DecisionBroker** (`src/engine/decisionBroker.ts`) answers the three
  live decision kinds (`approve-draft`, `scope-extraction`, `draft-format`).
  After handoff to the cycle, `ask`/`resolveDecision`/`requestAbort` delegate
  to the `CycleEngine` instance, so the FIFO queue is shared, not doubled.
- **The plan-mode prompt builders** (`updateSpecPrompt`, `appendAdrPrompt`,
  `remainingPlanPrompt`, `validateDraftFormat`, `OUTPUT_FORMAT_CONTRACT`,
  `unwrapFences` — all exported from `src/engine/planMode.ts`) do the actual
  drafting; live mode adds the format-contract loop around them (validate →
  retry once with feedback → `draft-format` human decision).
- **git as the review surface**: drafted docs are staged as intent-to-add
  (`git add -N`, `stageDocsForReview`) so `git diff HEAD -- spec.md adr.md
  plan.md` shows the drafts; abort drops the staging (`unstageDocs`); approval
  commits them (`commitDocs`, subject `docs(scope): <first line of scope>`)
  and clears stale `.harness/` state before a fresh `CycleEngine` takes over.

```mermaid
sequenceDiagram
    participant U as User (TUI chat / headless idea)
    participant L as LiveEngine
    participant B as DecisionBroker
    participant P as planMode builders
    participant C as CycleEngine

    U->>L: chat(msg) ×N (refine stage)
    U->>L: /draft
    L->>L: extractScope (SCOPE: block, fail-closed)
    L->>P: updateSpecPrompt / appendAdrPrompt / remainingPlanPrompt
    P-->>L: drafted docs (format-contract validated)
    L->>U: stageDocsForReview → git diff HEAD review
    L->>B: approve-draft decision
    B-->>U: head surfaced; choice → L
    U-->>B: continue
    L->>C: commitDocs + resetHarnessState → new CycleEngine
    C-->>U: full 8-phase cycle (same dashboard/session)
```

Scope extraction is the one genuinely new contract: the thinker must answer
with a `SCOPE:` line + fenced markdown block; a missing/unparseable block is
treated like any other gate — fail closed to a human decision
(`scope-extraction`: retry, or fall back to the user's last message).

- **Interactive TUI & Markdown Rendering** (`src/tui/LiveDashboard.tsx`, `src/tui/markdown.tsx`):
  - Two parallel scrollable cards (`ScrollableChatCard` for human-thinker dialogue, `ScrollableStreamCard` for real-time thinking and reasoning tokens) rendered concurrently.
  - `[Tab]` toggles active card focus with visual border highlighting (`cyanBright` on the active panel).
  - `[PageUp]` / `[PageDown]` scrolls the focused card by 4 lines at any time without losing in-flight input; arrow keys `[↑]` / `[↓]` scroll line-by-line when input is empty or stream is focused.
  - Native terminal Markdown token rendering via `MarkdownLine` formats inline bold, italic, code backticks, headers, bullet points, numbered lists, and code blocks natively in Ink.
  - Post-execution continuous loop: upon completing all plan iterations in `live` mode, a `post-cycle-live` decision modal prompts the user to either exit cleanly (`[c]` / `[a]`) or return to the live refinement loop (`[r]`) with state and thinker context preserved for the next set of tasks.

## 9. Concurrency and event model

The engine is single-threaded and awaits everything, but three sources of
asynchrony interleave:

1. **The opencode event stream** (`subscribeToEvents`) — a long-lived SSE loop
   that can fire a `permission.updated` request *while* the engine awaits a
   gate decision → this is exactly why the DecisionBroker exists. It also
   forwards agent activity to the frontends: text/reasoning deltas and
   tool-execution status into `phaseStream` (as synthetic marker lines such as
   `⚡ [tool: …] running` / `✓ … completed` / `✗ … error` and `📝 Edited file:
   …`), and file-edit / todo-update events into `log`.
2. **The engine's own retry/escalation loop** — driven by the same await chain.
3. **Frontends** — subscribe to `events` and resolve decisions independently.
   Live mode adds two more subscribers (`LiveDashboard.tsx` in the TUI,
   `runLiveHeadless` in headless) consuming `liveStage`/`liveChat`, which hand
   off to the same run-cycle rendering once the docs are approved.

Communication is via a single **global typed emitter**
(`src/engine/engineEvents.ts`):

| event | payload | consumers |
|---|---|---|
| `iterationStart` | iteration, totalIterations, title, modules | TUI header, headless iteration banner |
| `iterationEnd` | iteration, title | (currently no subscriber — reserved) |
| `phaseStart` | iteration, totalIterations, iterationTitle, phase, attempt, model, startedAt | TUI header, headless |
| `phaseStream` | text/reasoning deltas + tool-execution & file-edit marker lines | live output tail |
| `phaseEnd` | full PhaseResult + durationMs | report bar |
| `decision` / `decisionResolved` | request / id+choice | decision box |
| `verdict` | iteration, phase, verdict, attempt, durationMs | phase checklist |
| `log` | level + message + timestamp | log tail |
| `stateUpdated` | HarnessState | emitted after every `persist()`; currently no subscriber (reserved for future state UI) |
| `liveStage` | stage (`refine`/`draft`/`approve`/`execute`) + optional message | LiveDashboard stage header |
| `liveChat` | role (`user`/`assistant`/`system`) + text | LiveDashboard chat panel, headless live chat lines |
| `done` | reason + optional error | TUI exit, run summary |

Listener exceptions are caught and logged per-listener, so a broken subscriber
can't kill the engine. All frontends subscribe and unsubscribe in `finally`
blocks. The only cross-cutting wiring done outside the engines is
`subscribeToEvents`, which is handed the engine's `ask()` as its decision
callback — one line in `cli.ts` (`(req) => engine.ask(req)` / `(req) => live.ask(req)`).

## 10. Installer design

```mermaid
flowchart LR
    A[bun install] --> B[scripts/postinstall.ts]
    B --> C{all 11 present?}
    C -- yes --> Z[silent exit 0]
    C -- no --> D[promptYesNo]
    D -- no --> Z
    D -- yes --> E[installTemplates]
    F[huginn install] --> E
    E --> G[copy templates/{agents,commands}/*.md → ~/.config/opencode/...]
    G --> H{file exists?}
    H -- yes, no force --> I[skip]
    H -- no --> J[copy + chmod 0644]
    H -- yes, force --> J
```

- `REQUIRED_TEMPLATES` is a fixed list of 11 entries (5 agents + 6 commands)
  and doubles as the runtime contract: `huginn run`/`plan` warn when any is
  missing.
- `findTemplatesRoot()` walks up at most 8 directory levels from
  `import.meta.dir` looking for `templates/{agents,commands}`, which makes the
  same code work from `src/` (dev), `dist/` (bundled bin) and `scripts/`
  (postinstall). `HUGINN_TEMPLATES_DIR` short-circuits the walk.
- The destination defaults to `~/.config/opencode` and is overridable via
  `HUGINN_OPENCODE_CONFIG_DIR` — this is how the installer tests isolate
  themselves from the real config dir.
- No-overwrite is deliberate: opencode config may be personalized, and the
  agent/command files are the user's, not huginn's. `--force` exists for
  re-bundling.

## 11. Key invariants

1. **Fail closed**: no path exists where an unparseable gate report becomes a
   pass. (`gatedVerdict`, judge fallback, both tests.)
2. **Every decision gets exactly one answer**: FIFO + `resolveAll` on abort.
3. **No state loss**: `state.json` is only ever replaced atomically; the `run`
   cycle never touches plan/spec/adr — the only writers are `plan` mode (at
   creation time) and live mode (human-approved drafts, committed via git).
4. **`.harness/` never participates in the build**: excluded in `.gitignore`
   and filtered out of every git-diff-based helper.
5. **The pipeline table is the only place phase wiring lives**: adding a phase
   is adding one row (plus its `phases.ts` function and template command).
   The phase-name lists that mirror the pipeline — `MAIN_PHASES`
   (`src/engine/types.ts`), the TUI's `BASE_PHASES` (`src/tui/Dashboard.tsx`)
   and `PHASE_LABEL` (`src/state/store.ts`) — are duplicated by hand and must
   be updated in the same change.
6. **The engine never blocks on a human forever in unattended mode**: non-TTY
   headless aborts gate decisions rather than hanging.
7. **Memory database integrity & privacy**: `muninn.db` runs in WAL mode with foreign keys enabled (`ON DELETE CASCADE`) and `recursive_triggers = ON`; FTS5 indexes are automatically synchronized via database triggers (`obs_ai`, `obs_ad`, `obs_au`); and git remote URLs are sanitized of basic auth credentials before persistence. Non-memory database directories are created with `0o700` (`rwx------`) permissions.
8. **`.huginn/` storage isolation**: Project-local SQLite database files (`muninn.db`, `muninn.db-wal`, `muninn.db-shm`) reside under `<git_root>/.huginn/` and are excluded in `.gitignore`.
9. **FTS5 Query Sanitization**: User-supplied search queries are never passed raw to SQLite FTS5 `MATCH`; `sanitizeFtsQuery` tokenizes input, wraps terms in double quotes, safely handles prefix `*` wildcards, and strips punctuation-only syntax operators to prevent FTS5 syntax errors.
10. **Atomic JSONL Disk Writes with `0o600` Permissions**: `syncToDisk` writes to `.tmp` files with owner-only `0o600` permissions (`rw-------`) before atomic rename, preventing permission leakage and corrupted partial exports.
11. **Chunked In-Memory Join Queries**: Entity hydration queries for observations are capped at 500 parameters per chunk to ensure queries never breach SQLite host parameter boundaries (`SQLITE_LIMIT_VARIABLE_NUMBER`).
12. **MCP Error Isolation**: Tool execution and validation failures caught within `CallToolRequestSchema` return standard `{ isError: true }` responses and never terminate the JSON-RPC stdio transport. Fatal SQLite storage failures (corruption, I/O errors) are logged and rethrown.
13. **Prototype Pollution and Nullish Normalization**: All external MCP arguments pass through `normalizeArgs`, which prunes `__proto__`, `constructor`, and `prototype` keys, strips `null`/`undefined` values, and maps `snake_case` aliases before schema validation.
14. **Bounded MCP Payloads**: Strict Zod length constraints on titles (1,000), content (1,000,000), topic keys (256), symbols (500), queries (2,000), and limits (500) prevent resource exhaustion from model-generated payloads.
15. **Port Decoupling via `IMemoryService`**: The MCP server and its tool handlers depend exclusively on the `IMemoryService` port interface, keeping the transport protocol decoupled from concrete database handles or filesystem implementations.
16. **Stdio Transport Stream Hygiene**: `huginn mcp run` maintains absolute silence on `stdout` (no banners, no startup logging, no ANSI color sequences) to ensure standard JSON-RPC 2.0 frames over stdio are never corrupted.
17. **Disambiguated Keyword Positionals**: The CLI parser separates subcommand names from subsequent positional arguments (`_positionals[0]` vs `_positionals.slice(1)`), preventing argument shadowing when keywords like `"search"` or `"sync"` are searched or referenced.
18. **Boolean Flag Ingestion Safety**: `BOOLEAN_FLAGS` enforcement in `parseArgs` guarantees that standalone flags (e.g. `--import`, `--yes`, `--force`) never consume subsequent positional tokens or flags.

## 12. Key tradeoffs (summary; full rationale in ADR.md)

- Pipeline-as-data buys uniform retry/escalation logic at the cost of
  phase-specific control flow living inside the table's `fixPhase`/`fixLabel`
  indirection.
- A single global emitter is simple and decouples the engine from the UI, but
  means any state the dashboard keeps must be re-derived from events (it cannot
  reach into the engine beyond `getState`).
- Bundled markdown templates are transparent and user-editable but can drift
  from what the engine's parsers expect — the parser regexes are the contract,
  and the templates are the other side of it.
- All model traffic is synchronous request/response through one opencode
  session per iteration; parallelism (multiple agents at once) is deliberately
  not attempted, which keeps verdict ordering and state trivial.

## 13. Muninn Memory Engine — Database Layer & SQLite FTS5 Schema

The `src/muninn/db/` package provides embedded, local-first persistence for project memories, code symbol entity linkages, and BM25 full-text search without external network calls or vector API keys.

### Path Resolution Architecture

`resolveDatabasePath(customPath?, startDir?)` determines the SQLite database location based on repository context:

```mermaid
flowchart TD
    A["resolveDatabasePath(customPath, startDir)"] --> B{"customPath provided and non-empty?"}
    B -- Yes --> C["Return customPath (:memory: or explicit file)"]
    B -- No --> D["findGitRoot(startDir)"]
    D -- Git repository found --> E["Return <git_root>/.huginn/muninn.db"]
    D -- Not inside git repo --> F["Return ~/.huginn/muninn.db"]
```

- When `customPath` is passed and not empty (`""`), it is returned directly (enabling `:memory:` for isolated unit tests or explicit file paths).
- `findGitRoot(startDir)` searches upward through parent directories until it encounters a `.git` folder or file.
- If a git root is discovered, the database path resolves to `<git_root>/.huginn/muninn.db`.
- If no git repository is present, it falls back to the user's home profile at `~/.huginn/muninn.db`.
- If the resolved path is not `:memory:`, `getDatabase` ensures the target directory exists by calling `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`, restricting filesystem permissions to the owner.

### SQLite Connection & PRAGMA Configuration

Every connection initialized via `getDatabase(dbPath?)` instantiates a `better-sqlite3` instance with a 5000ms connection timeout and configures four essential pragmas before executing migrations:

```ts
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("recursive_triggers = ON");
```

| PRAGMA | Purpose & Operational Impact |
|---|---|
| `foreign_keys = ON` | Enforces referential integrity with `ON DELETE CASCADE`. Deleting a project cascades to its observations, entities, observation_entities join rows, and entity_dependencies links. |
| `journal_mode = WAL` | Enables Write-Ahead Logging. Permits concurrent readers alongside a writer, avoids table locks during read spikes, and protects against crash corruption. |
| `busy_timeout = 5000` | Sets a 5-second wait queue when SQLite encounters database contention rather than throwing an immediate `SQLITE_BUSY` error. |
| `recursive_triggers = ON` | Enables cascading deletes to activate triggers on child tables. **Crucial for FTS5 consistency**: when a project is deleted, cascade deletion removes rows in `observations`; `recursive_triggers = ON` ensures the `obs_ad` trigger fires and deletes the corresponding records from `observations_fts`. |

If pragma initialization or DDL execution throws an exception, `getDatabase` immediately closes the database handle before re-throwing, ensuring no leaked file descriptors or locks.

### Schema & Entity-Relationship Design

The database DDL is defined in `src/muninn/db/schema.sql` and mirrored in `src/muninn/db/client.ts` (`SCHEMA_SQL` fallback):

```mermaid
erDiagram
    PROJECTS ||--o{ OBSERVATIONS : "contains (CASCADE)"
    PROJECTS ||--o{ ENTITIES : "contains (CASCADE)"
    OBSERVATIONS ||--o{ OBSERVATION_ENTITIES : "links (CASCADE)"
    ENTITIES ||--o{ OBSERVATION_ENTITIES : "links (CASCADE)"
    ENTITIES ||--o{ ENTITY_DEPENDENCIES : "source (CASCADE)"
    ENTITIES ||--o{ ENTITY_DEPENDENCIES : "target (CASCADE)"
    OBSERVATIONS ||--|| OBSERVATIONS_FTS : "triggers sync"

    PROJECTS {
        text id PK
        text name
        text git_remote
        text root_path UK
        datetime created_at
    }
    OBSERVATIONS {
        text id PK
        text project_id FK
        text category
        text title
        text content
        text topic_key
        datetime created_at
        datetime updated_at
    }
    ENTITIES {
        text id PK
        text project_id FK
        text entity_type
        text identifier
        text file_path
    }
    OBSERVATION_ENTITIES {
        text observation_id PK_FK
        text entity_id PK_FK
    }
    ENTITY_DEPENDENCIES {
        text source_entity_id PK_FK
        text target_entity_id PK_FK
        text relation_type PK
    }
    OBSERVATIONS_FTS {
        text title
        text content
        text topic_key
    }
```

#### Table Specifications

1. **`projects`**:
   - Primary key: `id TEXT PRIMARY KEY`.
   - `root_path TEXT NOT NULL UNIQUE` indexed by `idx_projects_root_path`.
   - `git_remote TEXT`: sanitized origin URL.
   - `name TEXT NOT NULL`, `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`.

2. **`observations`**:
   - Primary key: `id TEXT PRIMARY KEY`.
   - `project_id TEXT NOT NULL` with `FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE`.
   - `category TEXT NOT NULL` constrained by `CHECK(category IN ('decision', 'convention', 'discovery', 'bugfix', 'architecture'))`.
   - `title TEXT NOT NULL`, `content TEXT NOT NULL`, `topic_key TEXT`.
   - Timestamps `created_at` and `updated_at`.
   - Indexes: `idx_observations_project_id`, `idx_observations_updated_at`, and `idx_observations_project_updated ON observations(project_id, updated_at DESC, created_at DESC)`.

3. **`observations_fts` (SQLite FTS5 Virtual Table)**:
   - External-content FTS5 table indexing `title`, `content`, and `topic_key` referencing `observations` via `content='observations', content_rowid='rowid'`.
   - Synchronized by three database triggers:
     - `obs_ai`: `AFTER INSERT ON observations` inserts `new.rowid`, `new.title`, `new.content`, `new.topic_key`.
     - `obs_ad`: `AFTER DELETE ON observations` deletes `old.rowid` entry.
     - `obs_au`: `AFTER UPDATE ON observations` deletes `old.rowid` and inserts updated fields for `new.rowid`.

4. **`entities`**:
   - Represents code symbols (AST functions, classes, interfaces, modules) or files.
   - Primary key: `id TEXT PRIMARY KEY`.
   - `project_id TEXT NOT NULL` with `FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE`.
   - `entity_type TEXT NOT NULL` constrained by `CHECK(entity_type IN ('file', 'function', 'class', 'interface', 'module'))`.
   - `identifier TEXT NOT NULL` (e.g. `src/auth.ts::login`), `file_path TEXT NOT NULL`.
   - Unique index `idx_entities_project_identifier ON entities(project_id, identifier)` prevents duplicate symbols per project.

5. **`observation_entities`**:
   - Join table linking observations to code entities.
   - Composite primary key: `PRIMARY KEY(observation_id, entity_id)`.
   - Cascading foreign keys: `FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE`, `FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE`.
   - Index: `idx_observation_entities_entity_id ON observation_entities(entity_id)`.

6. **`entity_dependencies`**:
   - Represents topological dependency and structural relationships between code entities (e.g. imports, function/method calls, interface implementations, class extensions, file-to-symbol references).
   - Composite primary key: `PRIMARY KEY(source_entity_id, target_entity_id, relation_type)`.
   - Cascading foreign keys:
     - `FOREIGN KEY(source_entity_id) REFERENCES entities(id) ON DELETE CASCADE`
     - `FOREIGN KEY(target_entity_id) REFERENCES entities(id) ON DELETE CASCADE`
   - `relation_type TEXT NOT NULL` constrained by `CHECK(relation_type IN ('imports', 'calls', 'implements', 'extends', 'references'))`.
   - Indexes:
     - `idx_entity_deps_source ON entity_dependencies(source_entity_id)` for outgoing dependency traversals.
     - `idx_entity_deps_target ON entity_dependencies(target_entity_id)` for incoming impact / caller lookups.

### Project Bootstrapping & Credential Sanitization

- **`ensureProject(db, options?)`**:
  - Resolves `rootPath` from options, nearest `.git` root, or `process.cwd()`.
  - Performs an idempotent query `SELECT ... FROM projects WHERE root_path = ?`. If found, returns the existing record.
  - If not found, generates a UUID, extracts project name (from directory basename or fallback `"project"`), reads origin URL from `.git/config` using `tryGetGitRemote`, and inserts the new project record.
- **`sanitizeGitRemote(rawUrl)`**:
  - Detects and strips user and password authentication tokens embedded in URLs (e.g. `https://oauth2:token@github.com/...` -> `https://github.com/...`).
  - Supports standard HTTP(S) URLs as well as SSH and SCP-like syntax.
  - Guarantees sensitive personal access tokens or credentials are never leaked into the database.

## 14. Muninn Memory Engine — MemoryService Core & Persistence API

The `MemoryService` (`src/muninn/service/memory-service.ts`) sits at the application core of the Muninn subsystem. It encapsulates business rules, SQLite transactions, symbol normalization, FTS5 query sanitization, and portable disk synchronization.

### Architecture & Component Interaction

```mermaid
flowchart TD
    subgraph Consumers["Driving Adapters"]
        CLI["Huginn CLI (huginn memory ...)"]
        MCP["MCP Server (stdio JSON-RPC)"]
        Agent["AI Coding Agents"]
    end

    subgraph ServiceCore["MemoryService (src/muninn/service/)"]
        MS["MemoryService"]
        Norm["normalizeSymbol()"]
        Sanitize["sanitizeFtsQuery()"]
        Chunk["_fetchEntitiesForObservations()"]
    end

    subgraph Storage["Persistence Layer (src/muninn/db/)"]
        DB[("better-sqlite3 (WAL Mode)")]
        FTS[("observations_fts (FTS5)")]
        Disk[(".huginn/memories.jsonl (0o600)")]
    end

    Consumers --> MS
    MS --> Norm
    MS --> Sanitize
    MS --> Chunk
    MS --> DB
    DB -. "Triggers (obs_ai/ad/au)" .-> FTS
    MS <--> Disk
```

### Detailed Method Specifications

#### 1. `saveObservation(input: SaveObservationInput): ObservationWithEntities`

Creates a new observation and links code symbols in a single atomic transaction (`db.transaction`):

```mermaid
sequenceDiagram
    participant C as Consumer
    participant S as MemoryService
    participant DB as SQLite DB
    participant T as FTS5 Triggers

    C->>S: saveObservation(category, title, content, symbols)
    Note over S: Validate category against VALID_CATEGORIES
    Note over S: Verify title & content are non-empty strings
    S->>DB: BEGIN TRANSACTION
    S->>DB: INSERT INTO observations (id, project_id, category, title, content, topic_key)
    DB-->>T: obs_ai trigger fires to update observations_fts
    loop For each symbol
        Note over S: normalizeSymbol(symbol)
        S->>DB: SELECT id FROM entities WHERE project_id AND identifier
        alt Entity exists
            Note over S: Reuse existing entity ID
        else Entity does not exist
            S->>DB: INSERT INTO entities (id, project_id, entity_type, identifier, file_path)
        end
        S->>DB: INSERT OR IGNORE INTO observation_entities (observation_id, entity_id)
    end
    S->>DB: COMMIT TRANSACTION
    S-->>C: ObservationWithEntities
```

- **Category Validation**: Must match one of `VALID_CATEGORIES` (`"decision"`, `"convention"`, `"discovery"`, `"bugfix"`, `"architecture"`). Throws an error for invalid categories.
- **Symbol Normalization (`normalizeSymbol`)**: Accepts string shorthand (`"src/db.ts::connect"`, `"src/config.ts"`, `"myFunc"`) or structured objects (`{ name, filePath, type, identifier }`). Generates canonical identifiers, resolves file paths, and assigns entity types (`file`, `function`, `class`, `interface`, `module`).
- **Entity Deduplication**: Identical normalized symbols within the same observation input are deduplicated before insertion.
- **Transaction Safety**: Insertion of the observation row, creation of new entities, and linking in `observation_entities` are completely atomic.

#### 2. `search(options: SearchOptions): SearchResult[]`

Executes BM25 full-text keyword searches across observations:

- **Query Sanitization (`sanitizeFtsQuery`)**:
  - Regex tokenization extracts double-quoted phrases and individual words.
  - Alphanumeric words and phrases are wrapped in double quotes (e.g. `"MemoryService::saveObservation"`, `"src/client.ts"`) to treat punctuation, slashes, and colons as literal search terms rather than FTS5 syntax operators.
  - Trailing asterisks are preserved for prefix search (`"token"*`).
  - Standalone syntax operators (e.g. `*`, `///`, `:::`, `---`) and empty whitespace queries are stripped. If no valid terms remain, an empty array `[]` is returned safely without executing the query or throwing syntax errors.
- **Relevance Ranking**: Results are ordered by `bm25(observations_fts) ASC` (in SQLite FTS5 BM25, lower scores indicate higher relevance).
- **Project Scoping**: Searches default to `currentProject.id`. Scoping can be overridden with an explicit `projectId` / `project_id`, or expanded globally with `allProjects: true`.
- **Entity Attachment**: Hydrates linked entities for all matching observations via `_fetchEntitiesForObservations`.
- **Limit Clamping**: Limits are clamped between `1` and `500` (default: `10`).

#### 3. `getContext(options?: ContextOptions): ObservationWithEntities[]`

Retrieves recent observations for context window injection:

- **Chronological Ordering**: Ordered by `updated_at DESC, created_at DESC`.
- **Performance Optimization**: Accelerated by the compound index `idx_observations_project_updated ON observations(project_id, updated_at DESC, created_at DESC)`.
- **Filters**: Supports filtering by `category`, `topicKey` / `topic_key`, and `projectId` / `project_id` (or `allProjects: true`).
- **Chunked Entity Fetching (`_fetchEntitiesForObservations`)**:
  - Joins between observations and entities are loaded in batches of at most 500 observation IDs at a time (`WHERE oe.observation_id IN (?, ?, ...)`).
  - This avoids exceeding SQLite host parameter limits (`SQLITE_LIMIT_VARIABLE_NUMBER`) even when requesting up to 500 observations.
- **Limit Clamping**: Limits are clamped between `1` and `500` (default: `20`).

#### 4. `linkSymbol(inputOrObsId, symbolArg)`

Associates an entity with an existing observation:

- **Flexible Signatures**: Supports object input `{ observationId, symbol, projectId? }` (with `observation_id` alias) or positional arguments `(observationId: string, symbol: SymbolInput | string)`.
- **Existence Verification**: Verifies the observation exists; throws if not found.
- **Idempotency**: Executes inside `db.transaction()` using `INSERT OR IGNORE INTO observation_entities`, ensuring duplicate calls do not throw or duplicate join records.

#### 5. `getStats(projectId?: string): MemoryStats`

Returns aggregate system metrics:

- Returns `{ projects: number, observations: number, entities: number, links: number }`.
- When `projectId` is passed, metrics are scoped to that project; when omitted, counts are aggregated across all workspaces.

#### 6. `syncToDisk(targetPath?, options?): { path: string; count: number }`

Exports observations and linked entities to a portable JSON Lines (`.jsonl`) file:

- **Path Resolution**: Defaults to `<project_root>/.huginn/memories.jsonl`. Relative paths resolve against `currentProject.root_path` (with fallback to git root or `process.cwd()`).
- **Atomic File Writing**:
  - Content is formatted as newline-delimited JSON (`.jsonl`).
  - Writes to a temporary file `<resolvedPath>.tmp` with mode `0o600` (`rw-------`).
  - Enforces `0o600` file permissions via `fs.chmodSync`.
  - Atomically replaces the target file via `fs.renameSync(tmpPath, resolvedPath)`.
  - In the event of an error, cleans up the `.tmp` file to prevent lingering temporary files.
- **Project Filtering**: Exports the current project by default (or explicit `options.projectId`), or all projects when `allProjects: true`.

#### 7. `importFromDisk(sourcePath?): { imported: number; skipped: number }`

Idempotently imports observations and entities from `.jsonl` files into the database:

- **Path Resolution**: Defaults to `<project_root>/.huginn/memories.jsonl` (or custom path).
- **Line-by-Line Streaming**: Parses each JSON line independently; malformed lines or non-object entries are skipped without aborting valid lines.
- **Type Integrity**: Strictly verifies that `id`, `title`, and `content` are non-empty strings.
- **Idempotency**: Checks `SELECT id FROM observations WHERE id = ?`. If an observation with the given UUID already exists, it is counted as `skipped` and not re-inserted.
- **Project & Category Fallbacks**:
  - If the record's `project_id` does not exist in `projects`, falls back to `currentProject.id`.
  - If the record's `category` is not in `VALID_CATEGORIES`, defaults to `'decision'`.
- **Entity Resolution**:
  - Reuses existing entities matching `(project_id, identifier)` or creates new entities, preserving custom entity IDs from the file when present.
  - Links observations and entities via `INSERT OR IGNORE`.
- **Automatic FTS Synchronization**: As records are inserted, SQLite triggers (`obs_ai`) automatically index each observation in `observations_fts`.
- **Single Transaction**: The entire import executes within a single `db.transaction()` block for speed and all-or-nothing consistency.

## 15. Muninn Memory Engine — Model Context Protocol (MCP) Server Architecture

The `src/muninn/mcp/` module implements a Model Context Protocol (MCP) server exposing Muninn memory operations directly to AI coding agents (Claude Code, Cursor, OpenCode, Windsurf) over standard input/output (`stdio`) using standard JSON-RPC 2.0.

### Architectural Component Diagram & Request Flow

```mermaid
flowchart TD
    subgraph AgentClient["AI Coding Agent (Claude Code / Cursor / OpenCode)"]
        Agent["Agent Process"]
    end

    subgraph MCPTransport["MCP Transport Layer"]
        Stdio["StdioServerTransport (JSON-RPC 2.0 over stdio)"]
    end

    subgraph MCPServerCore["Muninn MCP Server (src/muninn/mcp/server.ts)"]
        Server["Server (@modelcontextprotocol/sdk)"]
        Registry["TOOL_REGISTRY (Declarative Tool Map)"]
        Norm["normalizeArgs() (Security & Alias Filter)"]
        Zod["Zod Validation (Muninn*Schema)"]
        ErrFormat["formatZodErrors()"]
    end

    subgraph ServiceLayer["Service Core (src/muninn/service/)"]
        Port["IMemoryService (Port Interface)"]
        ConcreteService["MemoryService"]
    end

    subgraph DatabaseLayer["Persistence Layer (src/muninn/db/)"]
        SQLite[("better-sqlite3 (WAL Mode)")]
        FTS[("observations_fts (BM25)")]
    end

    Agent <-->|"stdin / stdout (JSON-RPC)"| Stdio
    Stdio <--> Server
    Server --> Registry
    Server --> Norm
    Norm --> Zod
    Zod -- "Invalid Args" --> ErrFormat --> Server
    Zod -- "Valid (parsed.data)" --> Registry
    Registry -->|"handler(service, data)"| Port
    Port -. "implements" .-> ConcreteService
    ConcreteService --> SQLite
    SQLite -. "triggers" .-> FTS
```

### Request Lifecycle & Sequence

Every tool invocation follows a strict, defensive pipeline ensuring the stdio connection never crashes:

```mermaid
sequenceDiagram
    participant A as Agent (Client)
    participant T as StdioServerTransport
    participant S as MuninnServer
    participant R as TOOL_REGISTRY
    participant V as Zod Validator
    participant M as IMemoryService

    A->>T: JSON-RPC CallToolRequest (name, arguments)
    T->>S: requestHandler(CallToolRequestSchema)
    alt Unknown Tool Name
        S-->>T: { isError: true, content: ["Error: Unknown tool ..."] }
    else Known Tool
        Note over S: normalizeArgs(arguments)
        Note over S: Strip __proto__, constructor, prototype
        Note over S: Prune null / undefined
        Note over S: Map snake_case aliases
        S->>V: tool.schema.safeParse(normalizedArgs)
        alt Validation Failed
            Note over S: formatZodErrors(error)
            S-->>T: { isError: true, content: ["Validation error: ..."] }
        else Validation Passed
            S->>R: tool.handler(service, parsed.data)
            R->>M: service[method](data)
            alt Handler Throws
                M-->>S: exception
                S-->>T: { isError: true, content: ["Error: <message>"] }
            else Handler Succeeds
                M-->>S: result
                S-->>T: { content: [{ type: "text", text: JSON.stringify(result) }] }
            end
        end
    end
    T-->>A: JSON-RPC Response
```

### Port Decoupling (`IMemoryService`)

To maintain clean architectural boundaries and facilitate unit testing with mock implementations, the MCP server depends on the `IMemoryService` port interface rather than the concrete `MemoryService` class:

```ts
export interface IMemoryService {
  readonly currentProject: Project;
  readonly db: Database.Database;
  saveObservation(input: SaveObservationInput): ObservationWithEntities;
  search(options: SearchOptions): SearchResult[];
  getContext(options?: ContextOptions): ObservationWithEntities[];
  linkSymbol(
    inputOrObsId: LinkSymbolInput | string,
    symbol?: SymbolInput | string
  ): { observation: Observation; entity: Entity };
  getStats(projectId?: string): MemoryStats;
  syncToDisk(
    targetPath?: string,
    options?: { projectId?: string; allProjects?: boolean }
  ): { path: string; count: number };
  importFromDisk(sourcePath?: string): { imported: number; skipped: number };
  close?(force?: boolean): void;
}
```

- `isMemoryService(obj)`: Runtime type guard verifying that an object satisfies the service interface.
- `createMcpServer(serviceOrOptions?)`: Accepts an instance of `IMemoryService` directly or options to instantiate a default `MemoryService`.
- Attaches the service reference as both `server.service` and `server.memoryService` on the returned `MuninnServer`.

### Declarative Tool Registry (`TOOL_REGISTRY`)

Instead of imperative `switch/case` routing, tools are declared in a centralized dictionary adhering to `ToolDefinition`:

```ts
export interface ToolDefinition<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput = unknown
> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (
    service: IMemoryService,
    input: z.infer<TSchema>
  ) => TOutput | Promise<TOutput>;
}
```

The exported `MUNINN_TOOLS: Tool[]` array is dynamically generated from `TOOL_REGISTRY` using `z.toJSONSchema(tool.schema)`.

### Tool Inventory & Payload Bound Specifications

| Tool | Schema | Bounds & Validation Constraints | Handler Action |
|---|---|---|---|
| `muninn_save` | `MuninnSaveSchema` | - `category`: Enum (`decision`, `convention`, `discovery`, `bugfix`, `architecture`)<br>- `title`: Trimmed string, 1–1,000 chars<br>- `content`: Trimmed string, 1–1,000,000 chars<br>- `topicKey`: Optional trimmed string, max 256 chars<br>- `symbols`: Optional array, max 500 items (string or `SymbolSchema`) | `service.saveObservation(input)` |
| `muninn_search` | `MuninnSearchSchema` | - `query`: Trimmed string, 1–2,000 chars<br>- `category`: Optional category enum<br>- `limit`: Optional integer, 1–500, default: 10<br>- `allProjects`: Optional boolean | `service.search(input)` |
| `muninn_context` | `MuninnContextSchema` | - `limit`: Optional integer, 1–500, default: 20<br>- `category`: Optional category enum<br>- `topicKey`: Optional trimmed string, max 256 chars<br>- `allProjects`: Optional boolean | `service.getContext(input)` |
| `muninn_link_symbol` | `MuninnLinkSymbolSchema` | - `observationId`: Trimmed string, min 1 char<br>- `symbol`: String (min 1 char) or `SymbolSchema` object | `service.linkSymbol(input.observationId, input.symbol)` |
| `muninn_stats` | `MuninnStatsSchema` | - `allProjects`: Optional boolean (default: false) | `service.getStats(allProjects ? undefined : currentProject.id)` |
| `muninn_inspect_symbol` | `MuninnInspectSymbolSchema` | - `symbol`: Trimmed string, 1–2,000 chars<br>- `projectId` / `project_id`: Optional trimmed string | `service.inspectSymbol(symbol, projectId)` returning symbol definition, file location, incoming/outgoing dependencies, and linked observations |
| `muninn_verify_contract` | `MuninnVerifyContractSchema` | - `files`: Optional array of strings or single string (transformed to array), max 500 items, 1–1,000 chars per path<br>- `projectRoot` / `project_root`: Optional trimmed string (enforced inside permitted project root) | `verifyTypeScriptContracts(targetRoot, files)` returning `{ valid, errorsCount, diagnostics }` with line/column locations and visual code snippets |

#### Symbol Schema Refinement (`SymbolSchema`)

Entity symbols accept string shorthands or structured objects. `SymbolSchema` enforces `.refine()`:

```ts
export const SymbolSchema = z
  .object({
    name: z.string().trim().nullish(),
    filePath: z.string().trim().nullish(),
    file_path: z.string().trim().nullish(),
    identifier: z.string().trim().nullish(),
    type: z.enum(["file", "function", "class", "interface", "module"]).nullish(),
    entity_type: z.enum(["file", "function", "class", "interface", "module"]).nullish(),
    id: z.string().trim().nullish(),
  })
  .passthrough()
  .refine(
    (s) => Boolean(s.name || s.identifier || s.filePath || s.file_path),
    { message: "Symbol must provide at least one of name, identifier, or filePath" }
  );
```

### Security Hardening & Robustness

1. **Prototype Pollution Hardening**:
   - `normalizeArgs` explicitly filters out `__proto__`, `constructor`, and `prototype` keys during object iteration.
   - Prevents untrusted model payloads from mutating JavaScript runtime prototypes.
2. **Nullish Argument Pruning & Serialization Normalization**:
   - LLMs frequently serialize optional omitted tool fields as explicit `null` or `undefined`.
   - `normalizeArgs` strips nullish entries before passing to Zod schemas, preventing unintended validation rejections.
3. **Snake_Case Alias Translation**:
   - Seamlessly remaps `topic_key` -> `topicKey`, `observation_id` -> `observationId`, and `all_projects` -> `allProjects`.
4. **Defensive Argument Extraction**:
   - Argument access and normalization are wrapped in `try...catch` within the tool call request handler, ensuring malformed non-object JSON payloads cannot throw unhandled exceptions.
5. **Human-Readable Error Formatting (`formatZodErrors`)**:
   - Recursively maps Zod validation issues to path-prefixed messages (`category: Invalid enum value`, `title: Observation title is required`).
6. **Graceful Transport Isolation**:
   - All tool errors return `{ isError: true, content: [{ type: "text", text: ... }] }` without dropping or terminating the JSON-RPC stdio transport stream.
7. **Fatal Error Safety Net**:
   - In `MemoryService.search()`, unexpected database disk I/O or corruption errors (`SQLITE_CORRUPT`, `SQLITE_IOERR`, `SQLITE_FULL`, `SQLITE_CANTOPEN`) are logged with `console.error` and rethrown, while non-fatal search query failures log warnings and return empty results.

### Server Lifecycle & Entrypoints

- **`createMcpServer(serviceOrOptions?)`**: Instantiates `@modelcontextprotocol/sdk` `Server`, registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers, and binds the `IMemoryService` instance.
- **`startMcpServer(options?)`**: Instantiates `StdioServerTransport`, creates the server, and establishes the stdio connection. Used by the CLI runner (`huginn mcp run`).

## 16. Muninn Memory Engine — CLI Commands & Stdio Runner Architecture

The CLI interface for Muninn memory (`src/commands/memory.ts`) connects human developers and terminal workflows to `MemoryService` and the `startMcpServer` runner without requiring agent tooling or MCP client configurations.

### Command Routing & CLI Parsing Architecture

CLI routing in `src/cli.ts` dispatches top-level commands to their respective subsystems:

```mermaid
flowchart TD
    CLI["cli.ts parseArgs(argv)"] --> DISPATCH{"_command"}
    DISPATCH -- "memory" --> MEM["handleMemoryCommand(subcommand, args, positionals)"]
    DISPATCH -- "mcp" --> MCP["handleMcpCommand(subcommand, args)"]
    DISPATCH -- "check" --> CHK["handleCheckCommand(files, args)"]
    DISPATCH -- "run / plan / live / install" --> CORE["Core Harness Engines"]

    MEM --> SUBCMD{"subcommand"}
    SUBCMD -- "init" --> INIT["MemoryService.init / ensureProject"]
    SUBCMD -- "search" --> SRCH["MemoryService.search() (BM25)"]
    SUBCMD -- "sync" --> SYNC["MemoryService.syncToDisk() / importFromDisk()"]
    SUBCMD -- "index" --> IDX["indexFilesIntoMuninn()"]
    SUBCMD -- "help / unknown" --> USAGE["printMemoryUsage()"]

    MCP --> MCPSUBCMD{"subcommand"}
    MCPSUBCMD -- "run" --> RUN["startMcpServer() + Stdio Keepalive"]
    MCPSUBCMD -- "help / unknown" --> MCPUSAGE["printMcpUsage()"]

    CHK --> CHKRUN["verifyTypeScriptContracts(projectRoot, files)"]
```

### Argument Parser Enhancements (`parseArgs`)

1. **Multi-Positional Capture (`_positionals`)**:
   - Rather than retaining only the first non-command token in `_positional`, `parseArgs` populates `_positionals: string[]`.
   - The first positional argument after the command name determines the subcommand (`init`, `search`, `sync`, `index`, `run`), while remaining entries (`positionals.slice(1)`) are forwarded as positional arguments (such as search queries or file paths).
2. **Boolean Flag Protection (`BOOLEAN_FLAGS`)**:
   - A dedicated `Set` flags boolean parameters (`--yes`, `--force`, `--resume`, `--force-restart`, `--ignore-plan-changes`, `--tui`, `--headless`, `--import`, `--help`, `-h`).
   - For any flag in `BOOLEAN_FLAGS`, the parser assigns `true` immediately without consuming the next token, preventing flags like `--import` from consuming subsequent positional file paths.
3. **Keyword Disambiguation & Anti-Shadowing**:
   - By partitioning command arguments through `_positionals`, user search queries matching subcommands (e.g. `huginn memory search search`) and filenames matching subcommands (e.g. `huginn memory sync sync`) are parsed without routing ambiguity or argument swallowing.
4. **Robust Value Conversions (`num`)**:
   - The `num(v, fallback)` helper handles non-string and non-finite argument types safely without throwing `TypeError`.

### Subcommand Implementations (`src/commands/memory.ts`)

#### 1. `huginn memory init`
- **Purpose**: Creates the SQLite database file and verifies that tables and triggers are ready.
- **Workflow**:
  - Accepts `--db <path>` and `--project <path>` (or `--root <path>`).
  - Instantiates `MemoryService({ dbPath, projectRoot })`.
  - Verifies project association via `service.currentProject`.
  - Outputs formatted green status badge and summary:
    ```
    ✔ Muninn memory database initialized
      Database: /path/to/.huginn/muninn.db
      Project:  huginn (/path/to/huginn)
      Status:   Tables ready
    ```
  - Calls `service.close?.()` in a mandatory `finally` block to release file locks.

#### 2. `huginn memory search <query>`
- **Purpose**: Searches stored observations using BM25 relevance ranking over FTS5.
- **Workflow**:
  - Resolves query from `positionals[0]` or `--query <text>`.
  - If query is absent or empty whitespace: prints `chalk.red("Error: Search query is required.")` and sets `process.exitCode = 1`.
  - Filters by `--category` and `--limit` (floors fractional numbers via `Math.floor`, falling back to `10` on negative or invalid limits).
  - Queries `service.search({ query, category, limit })`.
  - Formats output with ANSI styling:
    - Bold category badge: `[DECISION]`, `[CONVENTION]`, `[BUGFIX]`, `[ARCHITECTURE]`, `[DISCOVERY]`
    - Observation title and BM25 rank score: `(score: 0.123)`
    - Topic key (when present): `Topic: <key>`
    - Flattened content snippet clamped to 150 characters with trailing `...`
    - Code symbol linkages: `Symbols: <path1>, <path2>`
  - Guarantees database closure in `finally`.

#### 3. `huginn memory sync [--import]`
- **Purpose**: Exports observations to `.huginn/memories.jsonl` or imports them from an existing `.jsonl` file.
- **Workflow**:
  - Resolves target path from `--file <path>` or positional argument; defaults to `<project_root>/.huginn/memories.jsonl`.
  - **Export Mode** (default):
    - Invokes `service.syncToDisk(filePath)`.
    - Outputs `Synced N memories to <path>.`
  - **Import Mode** (`--import`):
    - Invokes `service.importFromDisk(filePath)`.
    - Outputs `Imported N memories (skipped M duplicates) from <path>.`
  - Guarantees database closure in `finally`.

#### 4. `huginn memory index [files...]`
- **Purpose**: Extracts AST symbols and topological dependencies from TypeScript/JavaScript files and indexes them into Muninn's `entities` and `entity_dependencies` database tables.
- **Workflow**:
  - Accepts optional list of target files or recursively discovers all source files in the project via `findSourceFiles(root)`.
  - Accepts `--project <path>` and `--db <path>` options.
  - Instantiates `MemoryService({ dbPath, projectRoot })`.
  - Invokes `indexFilesIntoMuninn(service, targetFiles, { projectRoot: root })`.
  - Validates paths against path traversal, checks supported extensions, enforces 2MB size limit, parses ASTs in-memory, and writes symbols and dependencies in a single atomic SQLite transaction with zombie entity pruning.
  - Outputs formatted green status badge and summary:
    ```
    ✔ Indexed N file(s) (X symbol(s), Y dependency link(s)) into Muninn memory.
    ```
  - Calls `service.close?.()` in a mandatory `finally` block to release file locks.

#### 5. `huginn mcp run`
- **Purpose**: Spawns and manages the long-running Model Context Protocol stdio server process.
- **Workflow**:
  - Accepts optional `--db <path>` and `--project <path>`.
  - Invokes `startMcpServer({ dbPath, projectRoot })`.
  - **Stdout Silence Guarantee**: Emits zero startup logs or banners to `stdout` to avoid corrupting MCP JSON-RPC frames.
  - **Lifecycle Management**:
    - Keeps the Node/Bun process alive via an unresolved `Promise<void>`.
    - Monitors `transport.onclose` to detect client disconnections.
    - Registers signal listeners for `SIGINT` and `SIGTERM`.
    - On termination, safely shuts down `MemoryService` and closes `MuninnServer` in a `finally` block before exiting.

### TypeScript Contract Verification Command (`src/commands/check.ts`)

#### `huginn check [files...] [--project <path>]`
- **Purpose**: Static verification of TypeScript execution contracts and type consistency via the TypeScript Compiler API without compiling or emitting JavaScript files.
- **Workflow**:
  - Parses target files from positionals or checks the entire project root.
  - Resolves project root via `--project <path>`, `--root <path>`, or `process.cwd()`.
  - Invokes `verifyTypeScriptContracts(projectRoot, targetFiles)`.
  - **Pass Path** (`result.valid === true`):
    - Prints green status: `✔ TypeScript contracts verified: 0 errors (N diagnostic(s)).`
    - If non-error diagnostics (warnings or suggestions) exist, prints formatted location details and visual code snippets.
  - **Fail Path** (`result.valid === false`):
    - Prints bold red header: `✖ TypeScript contracts check failed with N error(s):`
    - Prints each diagnostic with file path, line, character, error code (e.g. `[TS2322]`), category, message, and visual caret underline snippet.
    - Sets `process.exitCode = 1` for terminal automation and CI pipelines.

### Error Handling & Process Exit Protocol

To guarantee that asynchronous output streams flush completely and child handles terminate cleanly:
- Validation errors and unknown subcommands set `process.exitCode = 1` rather than invoking immediate `process.exit(1)`.
- The CLI main execution wrapper in `src/cli.ts` terminates cleanly:
  ```ts
  if (import.meta.main) {
    main(process.argv.slice(2))
      .then(() => {
        process.exit(process.exitCode ?? 0);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(msg));
        process.exit(1);
      });
  }
  ```

## 17. Verified Execution Contracts via TypeScript Compiler API

Static verification of code contracts is implemented in `src/contracts/compiler.ts`. Instead of shelling out to `tsc` or `bun build` as a child process, Huginn embeds the TypeScript Compiler API directly within the runtime. This provides low-latency, in-process diagnostic extraction, structured error objects, and deterministic gate evaluation.

### Architectural Motivation & Core Principles

1. **Zero Subprocess Overhead**: Spawning external CLI processes introduces process startup latency, terminal stream parsing fragility, and IPC overhead. In-process compilation via `ts.createProgram` evaluates ASTs directly in Bun's address space.
2. **Deterministic Pre-Emit Diagnostics**: Uses `ts.getPreEmitDiagnostics(program, sourceFile)` to intercept semantic, syntactic, and structural errors before any emission stage.
3. **No Artifact Side-Effects**: Always enforces `noEmit: true` so that verifying contracts never touches the disk, generates build artifacts, or invalidates git working trees.
4. **Sandboxed & Fail-Closed**: Target files and configuration files are strictly bounded within `projectRoot`. Missing target files or invalid configuration files fail closed immediately.
5. **Gate Loop Integration**: Formats verification results into machine-parsable markdown diagnostics with verdict markers (`### Overall gate: 🔴\n🛑 BLOCKED: ...`), enabling Huginn's `CycleEngine` to automatically feed compiler errors directly into thinker fix phases (`FIX_VALIDATE`, `FIX_SPEC`).

### Configuration Discovery & Containment (`loadProjectConfig`)

Configuration discovery enforces strict directory isolation:

```ts
export function loadProjectConfig(projectRoot: string): {
  configPath: string | undefined;
  options: ts.CompilerOptions;
  fileNames: string[];
  errors: ts.Diagnostic[];
}
```

- **Strict Root Resolution (`REV-005`, `SEC-007`)**: Resolves `path.join(resolvedRoot, "tsconfig.json")`. The loader explicitly refrains from walking parent directories (`ts.findConfigFile` is deliberately avoided) to prevent path traversal outside the project repository.
- **Safe Fallback (`DEFAULT_COMPILER_OPTIONS`)**: If `tsconfig.json` does not exist, safe default compiler options are applied:
  - `target: ts.ScriptTarget.ES2022`
  - `module: ts.ModuleKind.NodeNext`
  - `moduleResolution: ts.ModuleResolutionKind.NodeNext`
  - `strict: true`
  - `esModuleInterop: true`
  - `skipLibCheck: true`
  - `allowJs: true`
  - `noEmit: true`
- **Fail-Closed Parse Errors (`REV-002`)**: If `tsconfig.json` exists but contains syntax or configuration errors, `loadProjectConfig` returns the diagnostic errors, causing `verifyTypeScriptContracts` to fail immediately and report the configuration flaw.

### Target File Resolution & Traversal Containment (`resolveTargetFiles`)

Path validation protects against directory traversal and non-existent targets:

```ts
export function resolveTargetFiles(
  projectRoot: string,
  filePaths?: string[]
): ResolveTargetFilesResult
```

- **Path Traversal Guard (`SEC-001`)**: Computes `path.relative(projectRoot, resolved)`. If the relative path starts with `..` or is absolute, validation fails immediately with error code `TS6054` (`File '<path>' is outside project root.`).
- **File Existence Guard (`REV-003`)**: Validates that each target file exists on disk and is a regular file (`fs.statSync(resolved).isFile()`). Missing files trigger `TS6053` (`File '<path>' not found.`).

### Targeted Compilation & Diagnostics Pipeline (`verifyTypeScriptContracts`)

The verification pipeline executes in seven distinct phases:

```mermaid
flowchart TD
    A["verifyTypeScriptContracts(projectRoot, filePaths)"] --> B["resolveTargetFiles() (SEC-001, REV-003)"]
    B -- invalid path / missing file --> ERR1["Return failure ContractVerificationResult"]
    B -- valid --> C["loadProjectConfig() (REV-005, SEC-007)"]
    C -- config parse errors --> ERR2["Return configuration diagnostics"]
    C -- valid config --> D{"Determine rootNames"}
    D -- filePaths provided --> E["rootNames = targetFiles (REV-004)"]
    D -- tsconfig fileNames --> F["rootNames = fileNames"]
    D -- fallback --> G["findSourceFilesInDir(src/)"]
    E & F & G --> H["ts.createProgram({ rootNames, options })"]
    H --> I["Collect optionsDiagnostics + globalDiagnostics"]
    H --> J["Iterate checkFiles → ts.getPreEmitDiagnostics(program, file)"]
    I & J --> K["Deduplicate diagnostics by file:pos:code:message"]
    K --> L["Filter diagnostics: skip node_modules & outside root (SEC-004)"]
    L --> M["Format diagnostics with visual snippets"]
    M --> N{"errorsCount === 0?"}
    N -- yes --> PASS["valid: true, errorsCount: 0"]
    N -- no --> FAIL["valid: false, errorsCount: N"]
```

1. **Targeted `rootNames` Optimization (`REV-004`, `SEC-005`)**: When verifying specific files, only those files are passed as `rootNames` to `ts.createProgram`, minimizing symbol resolution overhead.
2. **Pre-Emit Diagnostics Collection**: Gathers `program.getOptionsDiagnostics()`, `program.getGlobalDiagnostics()`, and for each target file, `ts.getPreEmitDiagnostics(program, sourceFile)`.
3. **Diagnostic Deduplication**: Eliminates duplicate diagnostics caused by multiple source file import graphs using a composite key: `${fileName}:${start}:${code}:${messageText}`.
4. **Project Boundary & `node_modules` Filtering (`SEC-004`)**: Excludes diagnostics originating within `node_modules` or outside `projectRoot` (using trailing path separators to prevent prefix collisions).
5. **Structured Return Shape**: Returns `ContractVerificationResult`:
   ```ts
   export interface ContractVerificationResult {
     valid: boolean;
     errorsCount: number;
     diagnostics: FormattedDiagnostic[];
   }
   ```

### Visual Caret Snippet Generation (`createVisualSnippet`)

To provide high-fidelity diagnostic feedback to LLMs and terminal users, `createVisualSnippet` formats source code snippets with aligned caret indicators (`^`):

```ts
export function createVisualSnippet(
  sourceFile: ts.SourceFile,
  start: number,
  length: number = 1
): string
```

- **Line Extraction**: Identifies line starts via `sourceFile.getLineStarts()` and extracts the exact source line containing the error.
- **Resource & Memory Bounds (`SEC-006`, `REV-008`)**:
  - Clamps source line length to a maximum of 300 characters to prevent memory exhaustion on minified or bundled single-line files.
  - Clamps character indentation to a maximum of 300 spaces.
  - Clamps caret underline span between 1 and 200 characters, bounded by the remaining line length.
- **Visual Gutter Output**:
  ```typescript
  12 | const count: number = "not-a-number";
     |                       ^^^^^^^^^^^^^^
  ```

### Markdown Gate Report Formatting (`formatDiagnosticsReport`)

`formatDiagnosticsReport(result)` converts `ContractVerificationResult` into a Markdown document ready for Huginn's gate evaluation and prompt injection:

- **Pass Output**:
  ```markdown
  ### TypeScript Compiler Contract: 🟢 PASSED

  No compilation type errors detected.
  ```
- **Fail Output**:
  ```markdown
  ### TypeScript Compiler Contract: 🔴 BLOCKED
  Found 1 type compilation error(s):

  - **src/app.ts:12:7** [TS2322] (ERROR): Type 'string' is not assignable to type 'number'.
  ```typescript
  12 | const count: number = "not-a-number";
     |       ^^^^^
  ```

  ### Overall gate: 🔴
  🛑 BLOCKED: TypeScript compilation contract errors found (1 error(s)).
  ```

### Exported Namespace (`TypeValidator`)

`src/contracts/compiler.ts` exports the unified `TypeValidator` object:
```ts
export const TypeValidator = {
  check: verifyTypeScriptContracts,
  formatReport: formatDiagnosticsReport,
  DEFAULT_COMPILER_OPTIONS,
};
```

---

## 18. Topological AST Symbol & Dependency Indexer

Codebase intelligence and semantic memory in Muninn are powered by the AST indexer in `src/muninn/indexer/ast-indexer.ts`. It parses TypeScript and JavaScript source files into an entity-relationship graph representing code symbols (functions, classes, interfaces, methods) and their structural dependencies (imports, extends, implements, calls, references).

### Architectural Motivation & Knowledge Graph Role

LLM agents operating on source code often suffer from "context blindness" regarding symbol hierarchies, type implementations, and impact radius. The AST indexer builds an in-database dependency graph in SQLite (`entities` and `entity_dependencies` tables) that allows agents to:
- Instantly locate symbol declarations and their containing files.
- Inspect incoming and outgoing dependencies (who imports/calls/extends this symbol).
- Associate Muninn memory observations (architectural decisions, bug fixes, conventions) with exact code symbols via `observation_entities`.

### AST Parsing Engine & Memory Optimization (`extractAstData`)

```ts
export function extractAstData(
  filePath: string,
  sourceText: string
): AstExtractionResult
```

- **Lightweight Source Parser (`REV-010`)**: Calls `ts.createSourceFile(normalizedFilePath, sourceText, ts.ScriptTarget.Latest, false)`. Setting `setParentNodes = false` significantly reduces memory overhead and garbage collection pressure when processing large codebases.
- **Line & Column Resolution**: Uses `sourceFile.getLineAndCharacterOfPosition(pos).line + 1` for accurate 1-indexed line spans (`startLine`, `endLine`).
- **Export Modifier Detection**: Evaluates `ts.getCombinedModifierFlags(node)` and `ts.canHaveModifiers(node)` to classify public API symbols (`isExported: true`).

### Extracted Symbol Taxonomy & Canonical Identifiers

Symbols are uniquely identified across the project using canonical format `<relPath>::<symbolName>`:

| Entity Type | Source AST Node | Canonical Identifier Format | Scope & Access Rules |
|---|---|---|---|
| `file` | Source file itself | `src/app.ts` | Base container for all symbols |
| `function` | `ts.isFunctionDeclaration` | `src/utils/math.ts::add` | Top-level function declarations |
| `function` | `ts.isVariableStatement` | `src/api/client.ts::fetchData` | Arrow functions and function expressions |
| `class` | `ts.isClassDeclaration` | `src/auth/service.ts::AuthService` | Top-level class declarations |
| `function` | `ts.isMethodDeclaration` | `src/auth/service.ts::AuthService.login` | Public class methods (skips `private`, `protected`, `#`) |
| `interface` | `ts.isInterfaceDeclaration` | `src/types/user.ts::User` | Interface declarations |
| `interface` | `ts.isTypeAliasDeclaration` | `src/types/user.ts::UserID` | Type alias declarations |

### Dependency Extraction & Module Specifier Normalization

The indexer extracts five types of topological relationships:

```mermaid
flowchart LR
    FILE["File Entity (src/app.ts)"] -- references --> SYM["Symbol (AuthService)"]
    SYM -- extends --> BASE["BaseService"]
    SYM -- implements --> INTF["IAuth"]
    FILE -- imports --> MOD["Module (./utils.js → ./utils.ts)"]
    FILE -- imports --> NAMED["Named Symbol (./utils.ts::formatDate)"]
```

1. **`imports`**: Extracted from `ts.ImportDeclaration` and `ts.ExportDeclaration` (re-exports). Records both module-level dependencies and named imported symbols.
2. **`normalizeModuleSpecifier`**: Resolves relative imports (`./foo.js` -> `./foo.ts`, `.mjs`/`.cjs` -> `.ts`, `.jsx` -> `.tsx`) against the importing file's directory according to TypeScript ESM conventions, while preserving non-relative package specifiers (e.g. `chalk`, `@opencode-ai/sdk`).
3. **`extends`**: Extracted from class and interface `heritageClauses` (`clause.token === ts.SyntaxKind.ExtendsKeyword`).
4. **`implements`**: Extracted from class `heritageClauses` (`clause.token === ts.SyntaxKind.ImplementsKeyword`).
5. **`references`**: Created automatically between the file entity and every symbol declared within that file.

### Two-Stage Non-Blocking Batch Indexing Architecture (`indexFilesIntoMuninn`)

To ensure database concurrency, WAL performance, and stability, indexing separates file I/O from database transactions (`REV-001`):

```ts
export function indexFilesIntoMuninn(
  memoryService: IMemoryService,
  filePaths: string[],
  options?: { projectRoot?: string }
): IndexSummary
```

```mermaid
sequenceDiagram
    participant CLI as CLI / MCP Caller
    participant FS as File System (In-Memory)
    participant AST as TypeScript AST Parser
    participant DB as SQLite WAL Transaction

    Note over FS,AST: Stage 1: In-Memory File I/O & Parsing (Zero DB Lock)
    CLI->>FS: Check path traversal (SEC-001) & 2MB limit
    FS->>AST: Read content & extractAstData()
    AST-->>FS: Extracted symbols & dependencies

    Note over DB: Stage 2: Short-Lived Database Transaction
    CLI->>DB: db.transaction()
    DB->>DB: getOrCreateEntity(fileEntity)
    DB->>DB: Prune zombie/ghost entities for file (REV-003, SEC-003)
    DB->>DB: Batch upsert active symbol entities
    DB->>DB: Purge stale outgoing dependencies & insert new edges
    DB-->>CLI: Return IndexSummary
```

#### Stage 1: In-Memory Parsing (Outside DB Transaction)
- **Path Traversal Containment (`SEC-001`)**: Target paths must resolve strictly within `projectRoot`. Escaping paths are silently skipped.
- **Extension Filtering**: Only supported extensions (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) are processed.
- **Size Bounds**: Files exceeding `MAX_FILE_SIZE_BYTES = 2MB` are skipped to protect system memory.
- **Fault Tolerance (`REV-007`)**: Unreadable files or syntax errors in individual files do not abort the indexing of remaining files.

#### Stage 2: Short-Lived Atomic SQLite Transaction
- Executed inside `db.transaction(...)` for minimal WAL lock duration.
- **`getOrCreateEntity`**: Upserts entity records, authoritatively updating `entity_type` and `file_path` if already present.

### Zombie / Ghost Entity Pruning & Cascading Integrity (`REV-003`, `SEC-003`)

When a source file is edited, symbols may be renamed, removed, or moved. If stale entities remained in the database, agents would navigate to obsolete ghost symbols:

1. **Active Identifier Gathering**: During Stage 1 AST extraction, the indexer collects all currently valid identifiers in the file (`activeIdentifiers: Set<string>`).
2. **Zombie Detection**: Queries all existing entities for the file:
   ```sql
   SELECT id, identifier FROM entities WHERE project_id = ? AND file_path = ?;
   ```
3. **Cascading Pruning**: Any database entity for that file whose identifier is *not* in `activeIdentifiers` is deleted:
   ```sql
   DELETE FROM entities WHERE id = ?;
   ```
4. **Referential Cascade**: SQLite's `FOREIGN KEY ... ON DELETE CASCADE` automatically and atomically cleans up all associated records in `entity_dependencies` (both incoming and outgoing links) and `observation_entities`.

### Symbol Inspection API (`MemoryService.inspectSymbol`)

`MemoryService` exposes `inspectSymbol(symbol: string, projectId?: string): SymbolInspection | null` to serve both MCP agent queries (`muninn_inspect_symbol`) and developer inspection:

```ts
export interface SymbolInspection {
  entity: Entity;
  dependencies: {
    outgoing: SymbolInspectionDependency[];
    incoming: SymbolInspectionDependency[];
  };
  observations: Observation[];
}
```

- **Multi-Tier Matching Strategy**:
  1. **Exact Match**: Queries `WHERE project_id = ? AND identifier = ?`.
  2. **Suffix Match (`REV-005`, `REV-008`, `SEC-004`)**: If exact match fails, searches for symbol names or method names across files using suffix patterns:
     ```sql
     identifier LIKE '%::' || ? ESCAPE '\' OR identifier LIKE '%.' || ? ESCAPE '\'
     ```
     Enables queries like `"login"` to find `"src/auth.ts::AuthManager.login"`.
  3. **Prefix / Path Match**: Matches namespaces or file paths (`identifier LIKE ? || '%' ESCAPE '\' OR file_path = ?`).
- **SQL Injection Prevention (`_escapeLikePattern`)**: Escapes `%`, `_`, and `\` before binding to LIKE clauses.
- **Graph & Observation Aggregation**: Fetches outgoing dependencies, incoming dependents, and all linked memory observations, returning a complete 360-degree topological view of the symbol.

## 19. Phase 3 — Live-First Entrypoint, Universal Agent Integrator & Git Worktree Sandboxing

Phase 3 removes three friction points: the CLI required a subcommand plus hand-passed
`--thinker`/`--executor` flags and pre-existing documents; Muninn's MCP server and directives had
to be wired into each agent by hand; and iterations mutated the developer's live working tree
directly. The implementation lives in `src/config.ts`, `src/cli.ts`, `src/agents/integrator.ts`,
`src/commands/setup.ts`, `src/commands/doctor.ts`, and `src/engine/worktree.ts`.

### 19.1 Live-first entrypoint & persistent model configuration

`main()` (`src/cli.ts`) routes on `args._command`. `help`/`--help`/`-h` print usage; the
subcommands in `KNOWN_COMMANDS` (`run`, `plan`, `live`, `install`, `memory`, `mcp`, `check`,
`setup`, `doctor`) route to their handlers. **Anything else — no command at all, or a bare
free-text token such as `huginn "crear módulo de pagos"` — enters `runLive(args, command)`, and the
stray token is passed through as the initial idea (REQ-14.4).** `run` and `plan` remain explicit
subcommands for batch/CI use.

```mermaid
flowchart TD
    A["huginn <argv>"] --> P["parseArgs"]
    P --> H{"help / --help / -h?"}
    H -- yes --> USAGE["usage()"]
    H -- no --> K{"_command in KNOWN_COMMANDS?"}
    K -- "run/plan/live/install/memory/mcp/check/setup/doctor" --> EX["explicit handler"]
    K -- "otherwise (none, or free-text idea)" --> LIVE["runLive(args, idea)"]
```

Both `run` and `live` default `--project` to `canonicalize(process.cwd())` (realpath, so embedded
paths match what the opencode server resolves) and resolve models from configuration instead of
erroring on missing flags. A non-git project is still a fatal error. `--sandbox` / `--no-sandbox`
are boolean flags (`BOOLEAN_FLAGS`) stored in `RunConfig.sandbox` (default `true`).

#### Model resolution precedence

`resolveModelsFromConfig(sources)` is a pure, injectable function (`sources.env` defaults to
`process.env` only when omitted). First non-empty value wins, independently per role:

| Order | Source | Thinker key | Executor key |
|---|---|---|---|
| 1 | CLI flag | `--thinker <m>` | `--executor <m>` |
| 2 | project config | `<project>/.huginn/config.json` → `thinker` | `executor` |
| 3 | user config | `~/.huginn/config.json` → `thinker` | `executor` |
| 4 | environment | `HUGINN_THINKER_MODEL` | `HUGINN_EXECUTOR_MODEL` |
| 5 | documented default | `anthropic/claude-opus-4-5` | `opencode/gpt-5.1-codex` |

#### Config persistence (`src/config.ts`)

The config schema is `UserConfig = { thinker?: string; executor?: string; mode?: "auto" |
"supervised"; [key: string]: unknown }` — the three documented keys are typed, and every unknown
key is preserved verbatim so third-party configs survive a round-trip.

- **`loadUserConfig(projectPath, homeDir?)`**: reads the user file, then the project file
  overriding it key-by-key. A missing file yields `{}`; malformed JSON or a non-object warns and is
  ignored — **fail-open on reads, never throws**. `sanitizeConfig` builds the result on a
  null-prototype object and refuses the dangerous keys `__proto__`, `constructor`, and `prototype`
  (prototype-pollution defense).
- **`saveUserConfig(projectPath, config)`**: merges with the existing file (unknown keys
  preserved) and writes atomically, hardened against symlink swaps: `mkdirSync(.huginn, { mode:
  0o700 })`, `lstatSync` refuses a symlinked `.huginn` dir, then a temp file created with the
  exclusive `wx` flag, a random suffix and mode `0o600`, followed by `renameSync` into place. A
  pre-existing symlink at the temp name is never followed (`EEXIST` retries once with a new
  suffix). No CLI command currently calls `saveUserConfig` — it is exercised by
  `test/engine/config.test.ts`, so at runtime the config layer is read-only for now.

### 19.2 Universal Agent Integrator (`huginn setup`)

`huginn setup [--agent <id|all>] [--list] [--force] [--project <path>] [--home <path>]
[--opencode-config-dir <path>]` idempotently registers the `muninn` MCP server (command
`huginn mcp run --project <projectPath>`) and injects a marked rules block into every supported
agent. Everything agent-specific lives in the declarative `AGENT_REGISTRY`
(`src/agents/integrator.ts`), so a new agent is a one-row addition (REQ-15).

#### `AGENT_REGISTRY` (12 targets + `all`)

| id | label | MCP config path(s) | format | rules file |
|---|---|---|---|---|
| `cursor` | Cursor | `<project>/.cursor/mcp.json`, `<home>/.cursor/mcp.json` | `mcpServers` | `.cursorrules` |
| `claude` | Claude Code / Desktop | `<project>/.mcp.json`, `<home>/.claude.json`, `<home>/.claude/claude_desktop_config.json` | `mcpServers` | `CLAUDE.md` |
| `opencode` | OpenCode | `<home>/.config/opencode/opencode.json` (honors `HUGINN_OPENCODE_CONFIG_DIR`) | `opencode` (`mcp` key) | `AGENTS.md` |
| `windsurf` | Windsurf | `<home>/.codeium/windsurf/mcp_config.json` | `mcpServers` | `.windsurfrules` |
| `gemini` | Gemini CLI | `<home>/.gemini/settings.json` | `mcpServers` | `GEMINI.md` |
| `qwen` | Qwen Code | `<home>/.qwen/settings.json` | `mcpServers` | `QWEN.md` |
| `codex` | OpenAI Codex CLI | `<home>/.codex/config.toml` | `toml` (`[mcp_servers.muninn]`) | `AGENTS.md` |
| `agy` | Antigravity CLI | `<home>/.gemini/config/mcp_config.json`, `<project>/.agents/mcp_config.json` | `mcpServers` | `AGENTS.md` |
| `kimi` | Kimi Code CLI | `<home>/.kimi-code/mcp.json`, `<project>/.kimi/mcp.json` | `mcpServers` | `AGENTS.md` |
| `pi` | Pi coding agent | `<home>/.pi/mcp.json`, `<project>/.pi/mcp.json` | `mcpServers` | `AGENTS.md` |
| `commandcode` | Command Code | `<home>/.commandcode/mcp.json`, `<project>/.commandcode/mcp.json` | `mcpServers` | `AGENTS.md` |
| `omp` | Oh My Pi | `<home>/.omp/mcp.json`, `<project>/.omp/mcp.json` | `mcpServers` | `AGENTS.md` |

#### Three registration formats

| format | container | written entry |
|---|---|---|
| `mcpServers` | `mcpServers.muninn` | `{ "command": "huginn", "args": ["mcp","run","--project","<path>"] }` |
| `opencode` | `mcp.muninn` | `{ "type": "local", "command": ["huginn","mcp","run","--project","<path>"], "enabled": true }` |
| `toml` | `[mcp_servers.muninn]` | `command = "huginn"` / `args = ["mcp","run","--project","<path>"]` |

- **Portable fallback (AC-15.3)**: every run also writes a standard `mcpServers` file at
  `<home>/.huginn/mcp.json`, independent of the registry, for tools that consume an ad-hoc
  `--mcp-config-file`.
- **Idempotency & `--force` (AC-15.4)**: registration merges into existing config, preserving all
  unrelated keys and sibling servers. An identical existing `muninn` entry is a no-op; a differing
  one is left untouched and reported as `skipped` unless `--force` overwrites it. TOML is parsed
  structurally (the `[mcp_servers.muninn]` table only), never string-appended.
- **File safety (AC-15.6)**: missing parents are created (`0o755`); malformed existing JSON/TOML
  throws a descriptive per-target error and leaves the file untouched; writes are atomic and
  symlink-hardened (exclusive `wx` temp + random suffix + rename).
- **Rules injection (AC-15.5)**: a block delimited by `<!-- huginn:muninn-rules:start -->` /
  `<!-- huginn:muninn-rules:end -->` is inserted or replaced in the target's rules file, leaving
  surrounding user content intact. The block obligates the LLM to call `muninn_context` and
  `muninn_inspect_symbol` before designing changes and `muninn_verify_contract` before emitting
  final code.
- **Path overrides (AC-15.7)**: `homeDir`/`opencodeConfigDir` are injectable; each target's MCP
  paths are overridable via `HUGINN_AGENT_<ID>_MCP_PATH` (colon-separated list), and its rules
  file via `HUGINN_AGENT_<ID>_RULES_PATH` (falling back to a global `HUGINN_AGENT_RULES_PATH`).
  Tests inject temp dirs and never touch the real home.

`setup()` returns a `SetupReport` (`registrations[]`, `rules[]`, `portable`); `handleSetupCommand`
prints per-target paths with `✔`/`•`/`=` markers plus a summary, and sets `process.exitCode = 1`
for an unknown `--agent`. `--list` prints the registry without writing anything.

### 19.3 `huginn doctor`

`runDoctorChecks(opts)` (`src/commands/doctor.ts`) probes the environment with `spawnSync` (Bun
and Node/vitest identical) and returns a structured `DoctorReport` independent of console output:

```ts
interface DoctorCheck {
  id: string; label: string;
  status: "ok" | "warn" | "fail";
  detail: string; critical: boolean;
}
interface DoctorReport { checks: DoctorCheck[]; ok: boolean; }
```

| check | id | critical | fails as |
|---|---|---|---|
| current dir is a git repository | `git-repo` | ✅ | `fail` → exit 1 |
| a runtime (Bun **or** Node) is on `PATH` | `runtime` | ✅ | `fail` → exit 1 |
| Muninn DB opens and `getStats()` reads | `muninn` | ✅ | `fail` → exit 1 |
| `git` binary on `PATH` | `git-binary` | — | `warn` |
| Node runtime on `PATH` | `node` | — | `warn` |
| `opencode` CLI on `PATH` | `opencode` | — | `warn` |
| registry targets already register `muninn` | `integrations` | — | `warn` |

`ok` is `true` only when every **critical** check passed (`checks.every(c => !c.critical ||
c.status === "ok")`). The integration check iterates `listRegistry()` + `resolveMcpPaths()`
(read-only) and reports `N/total` registered. The Muninn check defaults its DB path to
`<projectPath>/.huginn/muninn.db` (never dependent on the process CWD) and always `close()`s the
service. `handleDoctorCommand` prints one colorized line per check (`✔`/`⚠`/`✖`) and sets
`process.exitCode = report.ok ? 0 : 1`.

### 19.4 Git worktree sandbox lifecycle

Each iteration can run in an isolated git worktree so the developer's editor stays on the primary
branch while the agent works (REQ-17). A `Sandbox` is
`{ iteration, path, branch, projectRoot, baseCommit }`; `sandboxBranch(N)` is `huginn/task-iter-<N>`
and `sandboxPath(root, N)` is `<root>/.huginn/worktrees/task-iter-<N>` (AC-17.1/17.2).

```mermaid
stateDiagram-v2
    [*] --> Created: createSandbox() git worktree add -b huginn/task-iter-N
    Created --> Running: phases run against sandbox.path
    Running --> Promoted: COMMIT_ALL ok → promoteSandbox()
    Running --> Discarded: abort / phase error → discardSandbox()
    Promoted --> [*]: merge --ff-only | cherry-pick; worktree+branch removed
    Discarded --> [*]: worktree+branch removed; primary tree untouched
    Running --> Conflict: promotion fails both strategies
    Conflict --> [*]: cherry-pick --abort (primary restored), worktree removed, branch KEPT
```

#### `WorktreeManager` API (`src/engine/worktree.ts`)

| method | behavior |
|---|---|
| `createSandbox(projectRoot, iteration)` | resolves HEAD, **fails closed** (throws, no mutation) if the branch or path already exists, then `git worktree add -b <branch> <path> HEAD`; symlinks shared deps |
| `promoteSandbox(sandbox)` | integrates via `git merge --ff-only <branch>`, else `git cherry-pick <baseCommit>..<branch>`; returns `{ promoted, method: "ff"\|"cherry-pick"\|"none", commits }` |
| `discardSandbox(sandbox)` | removes the worktree (`--force`, tolerant) and deletes the ephemeral branch; idempotent; never touches the primary tree |
| `listSandboxes()` | parses `git worktree list --porcelain`, keeping only entries under `<root>/.huginn/worktrees/` |
| `cleanupAll()` | discards every listed sandbox (safety net) |

- **Dependency symlinks (AC-17.3)**: if `node_modules` and/or `.env` exist at the project root and
  not already in the sandbox, a symlink is created pointing at the root copy (never overwriting a
  real file/dir). Symlink failures are non-fatal warnings.
- **Promotion & conflict policy (AC-17.4)**: on success the worktree and branch are removed. On a
  conflict (both strategies fail) the primary tree is restored with `git cherry-pick --abort`, the
  worktree is removed, but the `huginn/task-iter-<N>` branch is **kept** so the sandbox work stays
  recoverable by hand; `promoted: false` is returned with a warning naming the branch. A zero-commit
  sandbox is a `method: "none"` no-op that still cleans up.

#### CycleEngine wiring (AC-17.6)

`RunConfig.sandbox` (default `true`) gates the behavior; `CycleEngineOptions.worktrees?` allows an
injected manager (tests), otherwise one is created lazily against `cfg.projectPath`.

- At the start of `run()`, when sandboxing is enabled, a best-effort `cleanupAll()` reclaims
  worktrees left behind by a crashed prior run.
- In `runIteration`, `createSandbox(projectRoot, iteration.index)` is called, then
  `workPath = sandbox?.path ?? projectPath`. The `PhaseContext` is built with `projectPath = workPath`,
  `baseCommit = headCommit(workPath)`, and the `spec/adr/plan` doc paths mapped into the sandbox
  (`sandboxDocPath`). `EXECUTE`, `VALIDATE_STEP`, `TEST_MODULE` and all `FIX_*` phases read
  `ctx.projectPath`, so they all operate on the sandbox; module inference (`inferModules`) and the
  compiler/Muninn paths use `workPath` too.
- On iteration success (no abort, not `--only-phase`), `promoteSandbox` integrates the commit into
  the primary branch and logs the method/commit count. On abort or a thrown phase error a
  `finally` block `discardSandbox`s, exactly once (`settled` flag), never touching the primary tree.
- **Mid-iteration resume is disabled under sandboxing**: the resume phase is only honored when
  `!sandbox`, because a prior run's worktree was discarded at startup — an ephemeral sandbox cannot
  resume mid-iteration, so earlier phases re-run.
- `--no-sandbox` preserves the previous in-place behavior exactly. `cleanupSandboxes()` delegates to
  `cleanupAll()` and is registered on `SIGINT`/`SIGTERM` in `cli.ts` for both `run` and the live
  handoff path, so an unexpected exit never leaves `.huginn/worktrees/` behind.

