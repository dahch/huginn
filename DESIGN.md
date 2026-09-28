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
├── cli.ts                  entry point; arg parsing (run/live/plan/install/setup/doctor/memory/mcp/check/config), banner, lifecycle wiring
├── agents/
│   └── integrator.ts       AGENT_REGISTRY (11 targets) + setup(): Muninn MCP registration, per-target rules injection, and the installed × registered provisioning matrix (REQ-15/REQ-38)
├── commands/
│   ├── check.ts            CLI commands: handleCheckCommand (verify TypeScript contracts), printCheckUsage
│   ├── config.ts           CLI commands: handleConfigCommand (show/set thinker+executor), printConfigUsage
│   ├── doctor.ts           CLI commands: runDoctorChecks, handleDoctorCommand (environment/Muninn diagnostics)
│   ├── memory.ts           CLI commands: handleMemoryCommand (init, search, sync, index), handleMcpCommand (run), usage formatters
│   └── setup.ts            CLI commands: handleSetupCommand (run the universal agent integrator)
├── config.ts               RunConfig; UserConfig schema, model resolution + source attribution, atomic symlink-safe config persistence
├── contracts/
│   ├── compiler.ts         TypeScript Compiler API contract verification, pre-emit diagnostics, visual error snippets
│   └── index.ts            re-exports verifyTypeScriptContracts, formatDiagnosticsReport, TypeValidator, types
├── banner.ts               ASCII banner + path shortening (prints the shared HUGINN wordmark)
├── brand.ts                shared ASCII brand assets: HUGINN wordmark + raven mark, artWidth (REQ-29 / ADR-29)
├── format.ts               shared formatting: durations, verdict badges/icons/colors
├── headless.ts             stdout frontend; stdin decision answering; runLiveHeadless
├── update.ts               background npm version check (cache + semver compare + reminder)
├── engine/
│   ├── agent/
│   │   ├── types.ts            IAgentRuntime, IAgentSession, ModelInfo, ModelCatalog, McpStatusReport contracts
│   │   ├── registry.ts         Agent factory, PATH auto-detection, resolution precedence, isExecutableBinary
│   │   ├── mcpStatus.ts        fetchMcpStatusWithTimeout (bounded `Promise.race`, 60 s listing cache) + attributed, `undefined`-safe formatMcpBadge (REQ-30/REQ-32)
│   │   ├── index.ts            barrel export for runtime subsystem
│   │   └── adapters/
│   │       ├── opencode.ts     OpencodeRuntimeAdapter (wraps opencode serve daemon + SDK); connected-provider discovery + `opencode models` fallback
│   │       ├── claude.ts       ClaudeRuntimeAdapter (Claude Code CLI / stdio)
│   │       ├── codex.ts        CodexRuntimeAdapter (OpenAI Codex CLI)
│   │       ├── omp.ts          OmpRuntimeAdapter (Oh My Pi CLI) + `omp models` parser
│   │       ├── agy.ts          `agy models` parser (id<TAB>name TSV)
│   │       ├── commandcode.ts  CommandCodeRuntimeAdapter (Command Code CLI) + `--list-models` parser
│   │       ├── qwen.ts         QwenRuntimeAdapter (Qwen Code CLI)
│   │       ├── modelList.ts    runModelListCommand: bounded, sanitized spawn used by every listing CLI (REQ-27)
│   │       ├── mcpList.ts      per-CLI `mcp list` parsers (opencode/claude/qwen/agy/commandcode) + listMcpServersViaCommand (REQ-32)
│   │       ├── generic.ts      GenericSubprocessRuntimeAdapter & GenericSubprocessSession (safe stdio, native model flags)
│   │       └── index.ts        re-exports all adapters
│   ├── cycle.ts            CycleEngine: pipeline-as-data (per profile), retry/fix/escalate loop, state machine
│   ├── phases.ts           the 8 phase functions + 3 fix functions; builds prompts/commands
│   ├── gate.ts             verdict parsers, JSON judge, fail-closed logic
│   ├── profiles.ts         PROFILES: the named pipelines (huginn Cycle + sdd/odd/rdd/strict-tdd) over the phase vocabulary (REQ-36)
│   ├── receipts.ts         frozen iteration evidence under .huginn/receipts/ (tree hash + verdicts) for rdd/strict-tdd (REQ-36)
│   ├── questionBlock.ts    agent-agnostic `<<<HUGINN_QUESTION>>>` block parser + answer formatter (REQ-37)
│   ├── decisionBroker.ts   FIFO queue of pending human/permission decisions
│   ├── permissions.ts      opencode event subscription: permission handling + stream forwarding
│   ├── planMode.ts         `huginn plan`: drafts spec/adr/plan via the thinker; exported prompt
│   │                       builders + draft-format contract reused by live mode
│   ├── liveMode.ts         LiveEngine: chat-refine → scope → draft → approve → handoff to CycleEngine
│   ├── liveRepo.ts         live-mode git helpers: repo context, intent-to-add staging, docs commit
│   ├── modelRouter.ts      "provider/model" → {providerID, modelID} + back
│   ├── diff.ts             git helpers, inferModules, hasImplementationCode (greenfield detection)
│   ├── skills/
│   │   ├── loader.ts       skill discovery (.huginn/skills → .opencode/skills), flat-frontmatter parser, BUILTIN_SKILLS, containment + O_NOFOLLOW read
│   │   ├── types.ts        Skill contract (id, name, description, triggers, body, filePath, builtin)
│   │   └── index.ts        barrel export for the skills subsystem
│   ├── engineEvents.ts     global typed event emitter
│   ├── worktree.ts         git worktree sandbox manager (create/promote/discard/list/cleanup)
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
│   └── client.ts           SDK wrapper: createClient, session creation, prompt/runCommand (sandbox `directory` query), withTimeout
├── setup/
│   └── install.ts          template discovery, install/uninstall bookkeeping
├── state/
│   ├── store.ts            .harness/ layout, atomic state persistence, progress markdown
│   └── schema.ts           zod schema for HarnessState/HistoryEntry
├── util/
│   └── text.ts             sanitizeTerminalText (ANSI + C0/C1 control stripping) shared by TUI, agent adapters & skills (SEC-001)
├── plan/
│   ├── parser.ts           plan.md → Iteration[]
│   └── types.ts            Iteration type
└── tui/
    ├── app.tsx             runTui and runLiveTui entry points
    ├── render.tsx          alternate screen setup, console patching, ink render bridges
    ├── useTerminalSize.ts  responsive rows/columns hook listening to stdout resize
    ├── commandRegistry.ts  single slash-command registry (id, aliases, argHint, description) driving dispatch, the palette and /help (REQ-28 / ADR-28)
    ├── CommandSuggestions.tsx inline `/` autocomplete overlay + bounded row window
    ├── feedback.ts         the one feedback voice: ✓/⚠/… prefixes, next-step hints, empty-chat first-run hints (REQ-31)
    ├── RavenHeader.tsx     shared ASCII raven mark + HUGINN wordmark header with a size-derived plan (REQ-29 / ADR-29)
    ├── Dashboard.tsx       the run-cycle dashboard component (fullscreen, responsive)
    ├── LiveDashboard.tsx   the live-mode dashboard (chat, stage, approval box, fullscreen, slash-command dispatch, palette)
    ├── McpInspectorModal.tsx interactive two-pane MCP server/tool inspector (/mcp), attributed to the active agent
    ├── AgentPickerModal.tsx interactive runtime picker (/agent): availability, active marker, detected path (REQ-33)
    ├── HelpModal.tsx       live slash-command cheat sheet (generated from the registry), shortcuts & active config (/help)
    ├── SkillsModal.tsx     project/built-in skills browser & prompt-body preview (/skills)
    └── ModelPickerModal.tsx interactive 3-step modal for thinker/executor selection & persistence (honest discovery states)
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
    CMD -- "config" --> CFG["handleConfigCommand()"]
    CMD -- "setup" --> SET["handleSetupCommand()"]
    CMD -- "doctor" --> DOC["handleDoctorCommand()"]

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
spawning harness server instances. The same is true of the Phase 3 `setup`,
`doctor` and `config` handlers, which resolve from `src/agents/integrator.ts`,
`src/commands/setup.ts`, `src/commands/doctor.ts` and `src/commands/config.ts`
without an engine.

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

That table is the **Huginn Cycle** — `profile: "huginn"`, the default. Since REQ-36 the pipeline is
selected per run from `PROFILES` (`src/engine/profiles.ts`), a record of named `PhaseName[]`
pipelines; `sdd`/`odd`/`rdd` reorder or subset these same steps (each step keeps its own `gate`/`fix`
column), and `strict-tdd` adds a second `TEST_MODULE` that is *expected to fail* and never blocks
(REQ-36, § 27.4). `--only-phase` validates against the union of every profile's phases.

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
  - `[PageUp]` / `[PageDown]` scrolls the focused card by 4 lines at any time without losing in-flight input; `[↑]` / `[↓]` recall previous composer submissions while the draft is empty, and scroll the focused agent-output card when it is shown and focused.
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
- **`startMcpServer(options?)`**: Instantiates `BoundedStdioServerTransport` — a `StdioServerTransport` subclass whose `send()` races the SDK write against a 5 s deadline (`MCP_WRITE_TIMEOUT_MS`) and an output-stream error, so a broken pipe **rejects** the pending request instead of awaiting a `'drain'` that never arrives (REQ-30 / AC-30.3) — creates the server, and establishes the stdio connection. Used by the CLI runner (`huginn mcp run`).

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
  - **Lifecycle Management** (REQ-30 / AC-30.3):
    - Keeps the Node/Bun process alive via an unresolved `Promise<void>`.
    - Monitors `transport.onclose`, bridges `process.stdin` `'end'`/`'close'` to the same `done()` shutdown path — the SDK transport only observes `'data'`/`'error'`, so without this a parent disconnect is invisible and the server would run forever — and registers signal listeners for `SIGINT` and `SIGTERM`.
    - Installs a `process.stdout` `'error'` handler that logs the EPIPE to `stderr` and turns it into a clean shutdown instead of an unhandled crash mid-response, a no-op `process.stderr` `'error'` handler, and a `server.onerror` logger for protocol failures.
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
directly. The implementation lives in `src/config.ts`, `src/commands/config.ts`, `src/cli.ts`,
`src/agents/integrator.ts`, `src/commands/setup.ts`, `src/commands/doctor.ts`,
`src/engine/worktree.ts`, and `src/server/client.ts`.

### 19.1 Live-first entrypoint & persistent model configuration

`main()` (`src/cli.ts`) routes on `args._command`. Help is a two-tier hierarchy (Iteration 24,
§ 25.5): `help`/`--help`/`-h` print the banner plus the concise `usageCore()`, `--help --all`
(or `help --all`) print the full `usage()` reference instead, and `huginn init --help` prints the
wizard's own `printInitUsage()`. The subcommands in `KNOWN_COMMANDS` (`run`, `plan`, `live`, `init`,
`install`, `memory`, `mcp`, `check`, `setup`, `doctor`, `config`) route to their handlers.
**Anything else — no command at all, or a bare free-text token such as `huginn "crear módulo de
pagos"` — enters `runLive(args, command)`, and the stray token is passed through as the initial idea
(REQ-14.4)** — with one exception: a *bare* invocation in a repository that has never run huginn
(no `.huginn/`) is onboarded through `handleGreenfieldLaunch` instead (§ 25.4). `run` and `plan`
remain explicit subcommands for batch/CI use.

```mermaid
flowchart TD
    A["huginn <argv>"] --> P["parseArgs"]
    P --> H{"help / --help / -h?"}
    H -- "yes, --all" --> USAGE["usage() (full reference)"]
    H -- yes --> CORE["usageCore() (concise)"]
    H -- no --> K{"_command in KNOWN_COMMANDS?"}
    K -- "run/plan/live/init/install/memory/mcp/check/setup/doctor/config" --> EX["explicit handler"]
    K -- "otherwise (none, or free-text idea)" --> G{"bare greenfield launch?"}
    G -- yes --> INIT["handleGreenfieldLaunch (init wizard / pointer)"]
    G -- no --> LIVE["runLive(args, idea)"]
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
- **`loadConfigLayers(projectPath, homeDir?)`**: reads the user and project files *separately* (no
  merging) so source attribution is exact; `loadUserConfig` merges them key-by-key.
- **`describeModelSources(sources)`**: runs the precedence table above and reports which layer
  supplied each role (`flag` / `project` / `user` / `env` / `default`). `resolveModelsFromConfig`
  is the value-only view of the same single precedence implementation, so the two can never drift.
- **`saveUserConfig(projectPath, config)`** / **`saveGlobalUserConfig(homeDir, config)`**: merge
  with the existing file (unknown keys preserved) and write atomically, hardened against symlink
  swaps: `mkdirSync(.huginn, { mode: 0o700 })`, `lstatSync` refuses a symlinked `.huginn` dir, then
  a temp file created with the exclusive `wx` flag, a random suffix and mode `0o600`, followed by
  `renameSync` into place. A pre-existing symlink at the temp name is never followed (`EEXIST`
  retries once with a new suffix).

#### `huginn config` (`show` / `set`)

`handleConfigCommand` (`src/commands/config.ts`) is the runtime write path for the previously
unreachable config layer:

- **`huginn config show [--project <path>] [--home <path>]`** — prints the effective `thinker` and
  `executor` with the winning layer for each (`loadConfigLayers` → `describeModelSources`), plus
  the resolved project and user config file paths.
- **`huginn config set [--thinker <m>] [--executor <m>] [--global] [--project <path>] [--home <path>]`**
  — requires at least one of `--thinker`/`--executor` (a blank value exits 1 and prints usage) and
  writes to `<project>/.huginn/config.json` via `saveUserConfig`, or to `<home>/.huginn/config.json`
  via `saveGlobalUserConfig` when `--global` is passed. `--project`/`--home` override the defaults
  (homedir), which is how the tests avoid touching the real user home.

### 19.2 Universal Agent Integrator (`huginn setup`)

`huginn setup [--agent <t1,t2|all>] [--installed] [--status] [--dry-run] [--list] [--force] [--project <path>] [--home <path>]
[--opencode-config-dir <path>]` idempotently registers the `muninn` MCP server (command
`huginn mcp run --project <projectPath>`) and injects a marked rules block into every supported
agent. Everything agent-specific lives in the declarative `AGENT_REGISTRY`
(`src/agents/integrator.ts`), so a new agent is a one-row addition (REQ-15).

#### `AGENT_REGISTRY` (11 targets + `all`)

| id | label | MCP config path(s) | format | rules file |
|---|---|---|---|---|
| `cursor` | Cursor | `<project>/.cursor/mcp.json`, `<home>/.cursor/mcp.json` | `mcpServers` | `.cursorrules` |
| `claude` | Claude Code / Desktop | `<project>/.mcp.json`, `<home>/.claude.json`, `<home>/.claude/claude_desktop_config.json` | `mcpServers` | `CLAUDE.md` |
| `opencode` | OpenCode | `<home>/.config/opencode/opencode.json` (honors `HUGINN_OPENCODE_CONFIG_DIR`) | `opencode` (`mcp` key) | `AGENTS.md` |
| `windsurf` | Windsurf | `<home>/.codeium/windsurf/mcp_config.json` | `mcpServers` | `.windsurfrules` |
| `qwen` | Qwen Code | `<home>/.qwen/settings.json` | `mcpServers` | `QWEN.md` |
| `codex` | OpenAI Codex CLI | `<home>/.codex/config.toml` | `toml` (`[mcp_servers.muninn]`) | `AGENTS.md` |
| `agy` | Antigravity CLI (agy) | `<home>/.gemini/config/mcp_config.json`, `<project>/.agents/mcp_config.json` | `mcpServers` | `AGENTS.md` |
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
- **File safety (AC-15.6)**: missing parents are created (`0o700`); malformed existing JSON/TOML
  throws a descriptive per-target error and leaves the file untouched; writes are atomic and
  symlink-hardened (exclusive `wx` temp + random suffix + rename). An **existing** target keeps its
  current permission bits (a config the user hardened to `0o600` is never widened); a new file is
  created with `0o600` for MCP configs and `0o644` for rules files.
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
    Conflict --> [*]: cherry-pick --abort (primary restored), worktree removed, branch KEPT, run fails closed
```

#### `WorktreeManager` API (`src/engine/worktree.ts`)

| method | behavior |
|---|---|
| `createSandbox(projectRoot, iteration)` | resolves HEAD, **fails closed** (throws, no mutation) if the repo has no HEAD commit or the branch/path already exists, then `git worktree add -b <branch> <path> HEAD`; symlinks shared deps |
| `promoteSandbox(sandbox)` | integrates via `git merge --ff-only <branch>`, else `git cherry-pick <baseCommit>..<branch>`; returns `{ promoted, method: "ff"\|"cherry-pick"\|"none", commits }` |
| `discardSandbox(sandbox)` | removes the worktree (`--force`, tolerant) and deletes the ephemeral branch; idempotent; never touches the primary tree |
| `listSandboxes()` | parses `git worktree list --porcelain`, keeping only entries under `<root>/.huginn/worktrees/` |
| `cleanupAll()` | discards every listed sandbox **and** deletes orphaned `huginn/task-iter-*` branches with no worktree (safety net); returns the reclaimed resource count |

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
`sandboxingEnabled()` requires **both** the flag and an existing HEAD commit: a greenfield repo with
no HEAD cannot create a worktree, so the engine warns once and runs that run in place instead of
letting `createSandbox` throw.

- At the start of `run()`, when sandboxing is enabled, a best-effort `cleanupAll()` reclaims the
  worktrees **and** the orphaned `huginn/task-iter-*` branches (e.g. a branch preserved by a
  conflicted promotion) left behind by a crashed prior run.
- In `runIteration`, `createSandbox(projectRoot, iteration.index)` is called first (so its path can
  scope the agent session), then `workPath = sandbox?.path ?? projectPath`. `ensureSession` always
  creates a **fresh** `iter N: <title>` session under sandboxing — a persisted
  `iterationSessionId` was bound to a different directory and is never reused.
- **The agent is bound to the sandbox through the opencode SDK `directory` query parameter, not
  just rewritten paths.** `createSession`, `prompt` and `runCommand` in `src/server/client.ts`
  forward a `directory` to the server, and `PhaseContext.directory` is set to `workPath`;
  `agentDirectory(ctx)` (`ctx.directory ?? ctx.projectPath`) is passed to every phase prompt and
  slash command (including the `FIX_*` thinker prompts). The `PhaseContext` also carries
  `projectPath = workPath`, `baseCommit = headCommit(workPath)`, and the `spec/adr/plan` doc paths
  mapped into the sandbox (`sandboxDocPath`), so harness-side module inference (`inferModules`) and
  the compiler paths use `workPath` too. **Muninn is the deliberate exception**: the `PhaseContext`
  also carries `dbPath` (resolved from the primary `RunConfig.projectPath` via
  `resolveDatabasePath`) and `primaryProjectRoot` (= `cfg.projectPath`), so `commitAll` **scans**
  modified files from `workPath` but **persists** the symbol graph to the primary project's
  `.huginn/muninn.db` and attributes entities to the primary project record — durable memory must
  outlive the ephemeral sandbox (SPEC AC-17.6, ADR-20). Indexing still runs during `COMMIT_ALL`
  (before promotion), so a failed/aborted promotion can leave phantom entities for code that never
  landed; this is an accepted trade-off documented in ADR-20.
- On iteration success (no abort, not `--only-phase`), `promoteSandbox` integrates the commit into
  the primary branch and logs the method/commit count. On abort or a thrown phase error a
  `finally` block `discardSandbox`s, exactly once (`settled` flag), never touching the primary tree.
- **A promotion conflict fails the run closed (AC-17.4)**: `promoteSandbox` has already restored
  the primary tree and preserved the branch, so `runIteration` throws instead of reporting success
  — the iteration is not marked complete and the run finishes as an error naming the preserved
  branch.
- **Mid-iteration resume is disabled under sandboxing**: the resume phase is only honored when
  `!sandbox`, because a prior run's worktree was discarded at startup — an ephemeral sandbox cannot
  resume mid-iteration, so earlier phases re-run.
- `--no-sandbox` preserves the previous in-place behavior exactly. `cleanupSandboxes()` delegates to
  `cleanupAll()` and is registered on `SIGINT`/`SIGTERM` in `cli.ts` for both `run` and the live
  handoff path, so an unexpected exit never leaves `.huginn/worktrees/` behind.

---

## 20. Phase 5 — Fullscreen Terminal UI & Viewport Engine

Iteration 19 transforms Huginn's Ink-based terminal user interface from an inline stdout-streamed view into a fullscreen application running in the terminal's Alternate Screen Buffer, with responsive viewport scaling, hot console log interception, and stream batching.

### 20.1 Alternate Screen Buffer & Lifecycle Guarantees (`src/tui/render.tsx`)

Previously, Ink rendered directly to standard stdout inline with prior shell history. Startup banners and server logs polluted the scrollback buffer, and scrolling spilled into the host terminal emulator.

`setupTuiEnvironment()` in `src/tui/render.tsx` establishes strict fullscreen containment:
1. **Entering Alternate Buffer**: Writes `ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H"` to `process.stdout`, immediately switching the terminal emulator to a clean alternate screen buffer and homing the cursor.
2. **Terminal Restoration (`EXIT_ALT_SCREEN`)**: Restores the primary screen buffer and cursor visibility via `EXIT_ALT_SCREEN = "\x1b[?1049l\x1b[?25h"`.
3. **Multi-Tier Cleanup Safety**:
   - `try...finally` in `renderTui` and `renderLiveTui`.
   - Process signal handlers for `SIGINT` and `SIGTERM`.
   - `uncaughtException` trap.
   - Synchronous `process.on("exit")` listener so cursor visibility and primary screen are guaranteed to be restored even during unexpected or abrupt process termination.

```mermaid
sequenceDiagram
    participant CLI as cli.ts / app.tsx
    participant ENV as setupTuiEnvironment()
    participant TERM as Terminal Emulator
    participant INK as Ink Renderer
    participant LOGS as patchConsole()

    CLI->>ENV: setupTuiEnvironment()
    ENV->>LOGS: patchConsole() (intercept stdout)
    ENV->>TERM: write ENTER_ALT_SCREEN (\x1b[?1049h\x1b[H)
    ENV->>CLI: return cleanup() callback
    CLI->>INK: render(<Dashboard> / <LiveApp>)
    Note over INK,TERM: Responsive Fullscreen TUI active (100% viewport)
    INK-->>CLI: exit triggered (quit / completion / abort)
    CLI->>ENV: cleanup()
    ENV->>TERM: write EXIT_ALT_SCREEN (\x1b[?1049l\x1b[?25h)
    ENV->>LOGS: unpatchConsole() (restore stdout)
```

### 20.2 Responsive Viewport Engine (`src/tui/useTerminalSize.ts`)

Card heights were previously fixed (`VISIBLE_CHAT_LINES = 12`, `VISIBLE_STREAM_LINES = 8`), leading to visual clipping on smaller screens and wasted space on larger displays.

The `useTerminalSize()` hook dynamically measures and adapts to terminal dimensions:
- Reads `process.stdout.rows` and `process.stdout.columns` with safe fallbacks (`DEFAULT_ROWS = 24`, `DEFAULT_COLUMNS = 80`) when non-TTY or dimensions are undefined.
- Listens to `process.stdout.on("resize")` and triggers React state updates on dimension changes.
- Layout cards (`ScrollableChatCard`, `ScrollableStreamCard`, `PipelineCard`, `LogsCard`) dynamically calculate their height from available viewport `rows`:
  - `HeaderCard` (the raven header) and `InputBar` / `FooterBar` occupy fixed overhead. The header's row cost is no longer a constant: `useRavenHeaderPlan` / `ravenHeaderPlan` (`src/tui/RavenHeader.tsx`) derives it from the measured columns/rows, the viewport floor and the caller's context rows, resolving mark + wordmark → wordmark-only → plain text, so the header never spends rows the budget did not reserve (REQ-29 / AC-29.3).
  - Middle cards scale to occupy 100% of remaining vertical height without vertical overflow.

### 20.3 Zero Stdout Pollution & Hot Console Interception (`patchConsole`)

To prevent visual tearing and corrupted frames in the alternate screen buffer, stdout emissions are completely eliminated during TUI operation:
- **`patchConsole()` / `unpatchConsole()`**: Intercepts `console.log`, `console.warn`, and `console.error` methods.
- Intercepted messages are formatted using `node:util.format` and dispatched to `events.emit("log", { level, message, timestamp })`.
- **Pre-Mount Log Buffering (`Emitter.logBuffer`)**: `Emitter` maintains a ring buffer of the last 50 log events (`MAX_LOG_BUFFER = 50`) accessible via `events.getRecentLogs()`. Early initialization logs (server startup, provider checks, template warnings) are preserved and displayed in `LogsCard` without leaking raw text to stdout before Ink mounts.
- CLI banner and update checks are conditionally suppressed or routed through `events.emit("log", ...)` when `cfg.tui` is active.

### 20.4 Stream Batching & Scroll Containment

High-frequency token streaming from language models can cause rapid React re-renders, Ink CPU spikes, and terminal flickering:
- **60ms Stream Throttling**: In both `Dashboard.tsx` and `LiveDashboard.tsx`, incoming `phaseStream` event chunks append to an internal ref buffer (`streamBuf.current`) and flush to React state at a throttled interval (minimum 60ms between flushes).
- **1,000-Line Ring Buffer**: Stream lines are clamped to the latest 1,000 lines, preventing unbounded memory growth during long-running builds.
- **Scroll Containment**: Keyboard navigation (`PageUp`/`PageDown` by 4 lines, `↑`/`↓` line-by-line) operates directly on internal state (`streamScroll`, `chatScroll`). Terminal scrollback remains untainted by mouse or touchpad movements.

## 21. Decoupled Multi-Agent Runtime Architecture (`IAgentRuntime`)

To eliminate hard lock-in to OpenCode and enable seamless orchestration across diverse developer tool ecosystems (Claude Code, OpenAI Codex, Oh My Pi, Command Code, Qwen Code, and custom stdio agents), Huginn implements an explicit Hexagonal (Ports & Adapters) runtime boundary under `src/engine/agent/`.

```mermaid
flowchart TD
    CLI["cli.ts / run / live"] --> Registry["Agent Registry (registry.ts)"]
    Registry -->|"resolveAgent()"| TargetSelection["Target Selection (--agent / config / PATH)"]
    TargetSelection --> AdapterFactory["getAgentRuntime(target)"]

    subgraph "Ports & Core Engine"
        RuntimePort["IAgentRuntime (Port)"]
        SessionPort["IAgentSession (Port)"]
        Cycle["CycleEngine / Phase Runners"]
        Live["LiveEngine"]
    end

    AdapterFactory --> RuntimePort
    Cycle -->|"createSession()"| RuntimePort
    Live -->|"createSession()"| RuntimePort
    Cycle -->|"prompt() / runCommand()"| SessionPort
    Live -->|"prompt()"| SessionPort

    subgraph "Driven Adapters (src/engine/agent/adapters/)"
        OpencodeAdapter["OpencodeRuntimeAdapter (HTTP / SDK)"]
        ClaudeAdapter["ClaudeRuntimeAdapter (CLI / stdio)"]
        CodexAdapter["CodexRuntimeAdapter (CLI / stdio)"]
        OmpAdapter["OmpRuntimeAdapter (CLI / stdio)"]
        CommandCodeAdapter["CommandCodeRuntimeAdapter (CLI / stdio)"]
        QwenAdapter["QwenRuntimeAdapter (CLI / stdio)"]
        GenericAdapter["GenericSubprocessRuntimeAdapter (stdio)"]
    end

    RuntimePort -.-> OpencodeAdapter
    RuntimePort -.-> ClaudeAdapter
    RuntimePort -.-> CodexAdapter
    RuntimePort -.-> OmpAdapter
    RuntimePort -.-> CommandCodeAdapter
    RuntimePort -.-> QwenAdapter
    RuntimePort -.-> GenericAdapter
```

### 21.1 Core Contracts (`src/engine/agent/types.ts`)

The runtime abstraction defines two foundational ports:

1. **`IAgentRuntime`**:
   - `id: AgentTarget` (`opencode`, `claude`, `codex`, `omp`, `commandcode`, `qwen`, `kimi`, `pi`, `cursor`, `windsurf`, `agy`).
   - `name: string` — human-readable agent name.
   - `isAvailable(): Promise<boolean>` — non-blocking probe verifying if the agent's executable binary exists on `PATH` or daemon is reachable.
   - `getAvailableModels(): Promise<ModelInfo[]>` — queries the models the runtime can actually use (never a fabricated catalog); returns `[]` when the runtime exposes no listing mechanism.
   - `getModelCatalog?(): Promise<ModelCatalog>` — richer discovery carrying a `reason` when the catalog is empty, so an empty result is never indistinguishable from a failure (REQ-27/AC-27.4).
   - `getMcpStatus(): Promise<McpStatusReport>` — inspects configured Model Context Protocol servers, transport types, and tool counts.
   - `createSession(options: SessionOptions): Promise<IAgentSession>` — creates an execution session bounded to the target directory.
   - `startDaemon?(): Promise<void>` / `stopDaemon?(): Promise<void>` — lifecycle hooks for runtimes requiring background daemons (e.g. OpenCode server).

2. **`IAgentSession`**:
   - `id: string` — unique session identifier.
   - `prompt(text: string, options?: PromptOptions): Promise<PromptResult>` — sends prompts, streaming through stdin where applicable.
   - `runCommand?(command: string, args: string, options?: CommandOptions): Promise<PromptResult>` — translates slash commands or execution directives.
   - `abort(): Promise<void>` — aborts active executions and terminates child process groups.

### 21.2 Concrete Adapters (`src/engine/agent/adapters/`)

- **`OpencodeRuntimeAdapter`**: Wraps `opencode serve` and `@opencode-ai/sdk`. Manages background server lifecycle (`startDaemon`, `stopDaemon`), translates `client.provider.list()` and `client.mcp.status()`, and runs sessions via OpenCode's HTTP SDK.
- **`ClaudeRuntimeAdapter`**: Connects to the Claude Code CLI (`claude`). Supports interactive prompt streaming with `--print` flags and stdin piping.
- **`CodexRuntimeAdapter`**: Integrates with OpenAI Codex CLI (`codex`).
- **`OmpRuntimeAdapter`**: Connects to Oh My Pi (`omp`).
- **`CommandCodeRuntimeAdapter`**: Integrates with Command Code (`commandcode` or fallback `command-code`).
- **`QwenRuntimeAdapter`**: Integrates with Qwen Code (`qwen` or fallback `qwen-code`).
- **`GenericSubprocessRuntimeAdapter`**: Reusable base adapter and session implementation managing subprocess stdio, process groups, timeouts, and JSON/TOML MCP status inspection.

### 21.3 Agent Resolution Precedence

When initializing `CycleEngine` or `LiveEngine`, Huginn resolves the active runtime with strict deterministic precedence via `resolveAgent()`:

1. **CLI Flag**: `--agent <target>`
2. **Project Config**: `<project>/.huginn/config.json` (`agent` key)
3. **User Config**: `~/.huginn/config.json` (`agent` key)
4. **Environment**: `HUGINN_AGENT`
5. **Auto-Detection**: Scans `PATH` using `detectAvailableAgents()` for installed binaries (`opencode`, `claude`, `codex`, `omp`, `commandcode`, `qwen`).
6. **Fallback**: Default to `opencode`.

### 21.4 Security Hardening & Subprocess Isolation

The runtime subsystem incorporates strict security measures:
- **Allowlist Validation (SEC-001)**: `sanitizeConfig` and `getAgentRuntime` strictly reject any target not registered in `AGENT_TARGETS`, preventing malicious repositories from setting arbitrary command executions via `.huginn/config.json`.
- **Safe Stdin Streaming (SEC-002)**: Prompt text is streamed safely through `child.stdin.write(text); child.stdin.end()` rather than passed as positional arguments in `argv`, preventing `ARG_MAX` overflows, argument injection, and exposure in system process tables (`ps`). Where command line flags are required (`promptViaStdin: false`), arguments are size-capped and guarded with `--` option delimiters.
- **Memory Denial-of-Service Defense (SEC-003)**: Output accumulation from subprocess `stdout` and `stderr` is bounded to 10MB (`MAX_OUTPUT_BYTES = 10 * 1024 * 1024`), discarding excessive data and mitigating memory exhaustion.
- **Safe Executable Verification (SEC-004)**: `isExecutableBinary` verifies file existence (`statSync.isFile()`) and execute permissions (`accessSync(..., X_OK)`), ensuring directory matches in `PATH` do not trigger false-positive binary detections.
- **Process Group Termination & Timeout Safety**: Subprocess abortions and timeout expirations send signals to the entire process group (`process.kill(-pid, signal)`) with graceful SIGTERM followed by SIGKILL escalation, preventing orphaned child processes.

## 22. Interactive Model & Provider Selector & Persistence

Iteration 21 introduces interactive model and provider selection, dynamic model discovery across active agent runtimes, in-session switching, and multi-scope atomic persistence.

### 22.1 Motivation & Architectural Objectives

Huginn historically relied on hardcoded defaults (`anthropic/claude-opus-4-5` for thinker and `opencode/gpt-5.1-codex` for executor). If a user launched Huginn with a different agent (such as Claude Code, Codex, or a local provider via Oh My Pi) or lacked API keys for Anthropic or OpenCode, the run would abort with provider errors. Furthermore, users had no mechanism to inspect available models or switch models without stopping their live refinement session.

The model selection architecture achieves four objectives:
1. **Runtime-Driven Model Discovery**: Automatically inspects the models authenticated or supported by the active `IAgentRuntime`.
2. **Interactive 3-Step Selection Modal (`ModelPickerModal`)**: A focused fullscreen TUI modal with live search filtering, provider badges, scroll containment, and format validation.
3. **Multi-Scope Atomic Persistence**: Allows the developer to save chosen models as Project Default (`<project>/.huginn/config.json`), Global Default (`~/.huginn/config.json`), or Session Only.
4. **Frictionless Onboarding**: Auto-detects when default models are absent from the active runtime and automatically guides the developer through model selection on startup.

### 22.2 Selection Workflow & State Machine

`ModelPickerModal` (`src/tui/ModelPickerModal.tsx`) implements a 3-step state machine within the fullscreen TUI:

```mermaid
stateDiagram-v2
    [*] --> ThinkerStep: Launch (CLI --choose-model, /models, or auto-onboard)

    state ThinkerStep {
        [*] --> FetchCatalog
        FetchCatalog --> DisplayThinkerModels: runtime.getModelCatalog() → catalog, else empty/error state
        DisplayThinkerModels --> FilterThinker: Key strokes (sanitize input)
        FilterThinker --> SelectThinker: Enter (catalog id, or free text)
    }

    ThinkerStep --> ExecutorStep: Thinker selected & validated

    state ExecutorStep {
        [*] --> DisplayExecutorModels
        DisplayExecutorModels --> FilterExecutor: Key strokes
        FilterExecutor --> SelectExecutor: Enter (validate provider/model)
    }

    ExecutorStep --> PersistenceStep: Executor selected & validated

    state PersistenceStep {
        [*] --> ChooseScope: Options (Project / Global / Session)
        ChooseScope --> ScopeProject: "1" or Enter on Project
        ChooseScope --> ScopeGlobal: "2" or Enter on Global
        ChooseScope --> ScopeSession: "3" or Enter on Session
    }

    PersistenceStep --> ApplySelection: Confirm selection
    ApplySelection --> SaveConfig: Project / Global scope
    ApplySelection --> InSessionUpdate: Session scope
    SaveConfig --> [*]: writeConfigAtomic() & resume LiveDashboard
    InSessionUpdate --> [*]: live.updateModels() & resume LiveDashboard

    ThinkerStep --> Cancelled: Esc key
    ExecutorStep --> Cancelled: Esc key
    PersistenceStep --> Cancelled: Esc key
    Cancelled --> [*]: onCancel()
```

#### Modal Interaction Contract

1. **Step 1: Choose Thinker (`step: "thinker"`)**:
   - Prompts user to select the reasoning, architecture, and gate-fix model.
   - Live query string filters models by `id`, `name`, `provider`, or `description`.
   - Visual provider badges (`[Anthropic]`, `[OpenAI]`, `[Google]`, etc.) visually categorize models.
   - Enter selects the highlighted model (accepted verbatim), or applies the typed custom model string. The `provider/model` requirement is waived for a catalog selection and for runtimes whose own catalog exposes bare ids (`agy`, Command Code): bare text for a fully-qualified runtime is scoped as `${runtime.id}/<text>`, while a runtime that lists bare ids keeps the text verbatim so its CLI can resolve its own short name. With no catalog, no filter and no current value there is nothing to select, and the row reports `No models discovered from <runtime> — type a provider/model id and press Enter`.
   - Validates the canonical `provider/model` syntax (`slashIdx > 0 && slashIdx < modelId.length - 1`) only when the choice is not a catalog/exempt id; invalid formats display an inline error banner (`⚠ Custom models must be in provider/model format`).
2. **Step 2: Choose Executor (`step: "executor"`)**:
   - Prompts user to select the execution model for coding, test execution, gates, and commits.
   - Inherits the catalog and filtering mechanism from Step 1.
3. **Step 3: Save Preferences (`step: "saveScope"`)**:
   - Presents a 3-tier persistence menu:
     - `[1] Project Default`: `.huginn/config.json` (recommended for repo-specific requirements).
     - `[2] Global Default`: `~/.huginn/config.json` (cross-project fallback).
     - `[3] Session Only`: Applies to the current live session without touching the disk.
   - Supports arrow navigation (`↑`/`↓`), vim keys (`k`/`j`), direct numeric selection (`1`, `2`, `3`), and confirmation (`Enter`).

#### React 19 / Ink Reconciler Concurrency Guard

To prevent stale closure bugs under React 19's reconciler with Ink during rapid typing or key navigation, `ModelPickerModal` employs a synchronous ref bridge (`stateRef = useRef(...)`):
```ts
const stateRef = useRef({ ...stateAndProps });
stateRef.current = { ...stateAndProps };

useInput((input, key) => {
  const cur = stateRef.current;
  // all state reads evaluate from cur, guaranteeing fresh references
});
```
Input characters are filtered through `sanitizeKeyInput()` to strip ANSI escape codes and unprintable control characters, preventing terminal sequence corruption.

### 22.3 Provider Catalog Discovery & Fallback Resilience

The modal decouples model enumeration through `runtime.getModelCatalog?()` / `runtime.getAvailableModels()`:
- **Runtime Discovery**: Calls `runtime.getModelCatalog?.()` (falling back to `getAvailableModels()`). When operating with OpenCode, this queries `client.provider.list()` and keeps **only models from providers in the response's `connected` set** (581 on the reference machine, not the 8 195-model catalog), translating them into `ModelInfo` records (`id`, `name`, `provider`, `description`). Runtimes with a listing command use it (Command Code `--list-models`, `omp models`, `agy models`); when the SDK/CLI is unreachable it falls back to `opencode models`.
- **Honest Empty/Error States (supersedes the old `DEFAULT_FALLBACK_MODELS` fallback)**: an empty or failed discovery shows a distinct empty state ("No models discovered from <runtime> — type a provider/model id and press Enter") plus the sanitized discovery `reason`; a thrown discovery error is surfaced verbatim. No hardcoded catalog is ever substituted.
- **Custom Model Flexibility**: Users are never restricted to pre-discovered models; typing a model id and pressing `Enter` confirms it. The `provider/model` shape is required for free-text ids on fully-qualified runtimes, but a catalog selection — and a bare free-text id on a runtime that exposes bare ids (`agy`, Command Code) — is accepted verbatim.

### 22.4 Slash Commands & In-Session Switching

Live mode provides two complementary slash commands for model management without interrupting the ongoing refinement conversation:

```mermaid
sequenceDiagram
    actor Dev as Developer
    participant UI as LiveDashboard InputBar
    participant Modal as ModelPickerModal
    participant Live as LiveEngine
    participant Events as engineEvents

    alt Interactive Picker (/models or /model)
        Dev->>UI: /models
        UI->>Modal: mount modal (showModelPicker = true)
        Dev->>Modal: select thinker, executor, scope
        Modal->>UI: handleModelSelect(result)
        UI->>Live: live.updateModels({ thinker, executor })
        UI->>Events: emit("liveChat", { role: "system", text: "Active models updated: ... (scope)" })
        UI->>Modal: unmount modal (showModelPicker = false)
    else Inline Model Switch (/model <thinker> [executor])
        Dev->>UI: /model anthropic/claude-3-7-sonnet opencode/gpt-5.1-codex
        UI->>UI: validateModel(thinker) & validateModel(executor)
        UI->>Live: live.updateModels({ thinker, executor })
        UI->>Events: emit("liveChat", { role: "system", text: "Active models updated: ... (session only)" })
    end
```

- **/models or /model**: Mounts `ModelPickerModal` over the live dashboard. The chat history and stream state remain in memory; upon completion or cancellation, the dashboard view resumes seamlessly.
- **/model <thinker> [executor]**: Performs an inline, zero-click model switch for the active session. If `executor` is omitted, the current executor is retained. The input string is validated against `provider/model` format, and a system message is emitted to `liveChat` confirming the new models.

### 22.5 Multi-Scope Atomic Persistence Architecture

When the user confirms model selection with `project` or `global` scope, Huginn persists the settings using atomic filesystem operations:

```mermaid
flowchart TD
    Select["handleModelSelect(result)"] --> ScopeCheck{"saveScope"}

    ScopeCheck -- "project" --> SaveProject["saveUserConfig(projectPath, { thinker, executor })"]
    ScopeCheck -- "global" --> SaveGlobal["saveGlobalUserConfig({ thinker, executor })"]
    ScopeCheck -- "session" --> UpdateMem["live.updateModels({ thinker, executor })"]

    SaveProject --> AtomicWrite["writeConfigAtomic(targetPath, config)"]
    SaveGlobal --> AtomicWrite

    subgraph "Atomic & Symlink-Safe Persistence"
        AtomicWrite --> DirGuard["ensureDirSync(dir, 0o700)"]
        DirGuard --> ReadOld["read existing config & preserve unknown keys"]
        ReadOld --> WriteTemp["writeFileSync(tmpPath, mergedJson, 0o600)"]
        WriteTemp --> Rename["renameSync(tmpPath, targetPath)"]
    end

    Rename --> UpdateMem
    UpdateMem --> Emit["emit('liveChat', systemConfirmation)"]
```

1. **Path Resolution**:
   - Project: `<projectRoot>/.huginn/config.json`.
   - Global: `<home>/.huginn/config.json`, honoring `HUGINN_HOME` environment override or `os.homedir()`.
2. **Atomic Write Guarantee (`writeConfigAtomic`)**:
   - Ensures directory existence with mode `0o700`.
   - Preserves unknown JSON keys already present in the configuration file, allowing third-party tools to store metadata safely.
   - Writes new content to an ephemeral sibling temporary file (`<targetPath>.tmp.<pid>.<random>`) with mode `0o600`.
   - Atomically swaps the temporary file into place via `fs.renameSync()`, preventing partial reads or file corruption on process termination.
3. **Symlink Safety**:
   - Detects symlinks and resolves canonical real paths, preventing symlink traversal attacks outside allowed configuration directories.

### 22.6 Startup Ergonomics & Pre-Flight Auto-Onboarding

Huginn incorporates automated pre-flight checks in `src/cli.ts` (`runLive`):

1. **`--choose-model` CLI Flag**:
   - When passed (e.g. `huginn --choose-model` or `huginn live --choose-model`), Huginn initializes `LiveDashboard` with `showModelPicker = true`, presenting the model picker immediately before any initial prompts or ideas are processed.
2. **Pre-Flight Auto-Onboarding Check (REV-003)**:
   - When Huginn starts, `describeModelSources` inspects where `thinker` and `executor` originated.
   - If either model was assigned from fallback defaults (`source === "default"`), Huginn queries `runtime.getAvailableModels()`.
   - If the active runtime returns an available model catalog and **neither** default model (`anthropic/claude-opus-4-5` or `opencode/gpt-5.1-codex`) is present in the catalog, Huginn automatically enables `cfg.chooseModel = true`.
   - This eliminates confusing runtime failures on fresh installs with non-Anthropic / non-OpenCode runtimes (such as Codex or Claude Code), greeting the developer with an intuitive configuration wizard.

---

## 23. Live MCP Monitor, Inspector & Multi-MCP Configuration

Iteration 22 introduces real-time Model Context Protocol (MCP) health monitoring, an interactive two-pane server and tool inspector modal (`McpInspectorModal`), strict non-blocking timeout protection for the Ink render loop, project-level `.huginn/mcp.json` declaration, and terminal injection defense.

### 23.1 Motivation & Architectural Objectives

Modern AI coding agents rely on tools provided by MCP servers (Muninn memory, filesystem access, git integrations, databases, web search, etc.). In previous iterations:
1. **Zero Runtime Observability**: Developers had no visibility into whether their configured MCP servers were alive, hung, or disconnected during build and refinement sessions.
2. **Render Loop Blocking Hazard**: If an agent runtime attempted to query an unresponsive external MCP server, the synchronous or unconstrained asynchronous call could stall React/Ink rendering, freezing the entire terminal interface.
3. **Lack of Tool Inspection**: Developers had no in-app way to explore available MCP tools, parameters, descriptions, or latency without switching to external terminal windows or configuration files.
4. **Project-Level MCP Disconnect**: Agent-specific MCP paths (e.g. `~/.cursor/mcp.json`, `~/.config/opencode/opencode.json`) were decoupled from repository-specific MCP servers needed for a particular codebase.

The MCP monitoring architecture fulfills four core objectives:
- **Non-blocking Resilient Polling**: Guaranteed deadline enforcement via `Promise.race` ensuring MCP status checks cannot degrade TUI frame rates or block user input.
- **Visual Health Badging**: Dynamic header status reflecting active server counts, tool counts, and degraded/timeout alerts.
- **Interactive Two-Pane Inspector (`/mcp`)**: A keyboard-driven TUI inspector featuring server connectivity details, transport metadata, tool definitions, and paginated windowing.
- **Secure Multi-Source Configuration**: Safe loading of repository-scoped `.huginn/mcp.json` with prototype-pollution prevention, size constraints, and terminal sanitization against ANSI escape injection.

### 23.2 Architecture Overview & Data Flow

```mermaid
flowchart TD
    subgraph "TUI Render Layer (Dashboard / LiveDashboard)"
        Header["HeaderCard / LiveHeader (MCP Badge)"]
        Inspector["McpInspectorModal (/mcp slash command)"]
    end

    subgraph "Non-Blocking Polling Engine (mcpStatus.ts)"
        Poller["fetchMcpStatusWithTimeout(runtime, 1500)"]
        Race["Promise.race([runtime.getMcpStatus(), timeoutPromise])"]
        Formatter["formatMcpBadge(report)"]
    end

    subgraph "Agent Runtime Port (IAgentRuntime)"
        Runtime["runtime.getMcpStatus()"]
    end

    subgraph "Multi-Source Config Resolution (mcpConfig.ts)"
        ProjectConfig[".huginn/mcp.json (SEC-002, SEC-003)"]
        AgentConfigs["resolveMcpPaths(agentId) (Cursor, Claude, OpenCode, Codex)"]
    end

    subgraph "Shared Sanitization (util/text.ts)"
        Sanitizer["sanitizeTerminalText() (SEC-001)"]
    end

    Header --> Formatter
    Poller --> Race
    Race --> Runtime
    Runtime --> ProjectConfig
    Runtime --> AgentConfigs
    ProjectConfig --> Sanitizer
    AgentConfigs --> Sanitizer
    Poller --> Header
    Inspector --> Poller
```

### 23.3 Non-Blocking Polling & Render Protection (`fetchMcpStatusWithTimeout`)

In `src/engine/agent/mcpStatus.ts`, `fetchMcpStatusWithTimeout` provides fail-safe status retrieval:

```ts
export async function fetchMcpStatusWithTimeout(
  runtime: IAgentRuntime,
  timeoutMs = 1500,
): Promise<McpStatusReport>
```

1. **Strict Bounded Race**: Creates an internal timer racing against the runtime's MCP read. The TUI passes a 12 s budget (`MCP_STATUS_POLL_TIMEOUT_MS`, REQ-32) so a slow listing CLI (`opencode mcp list` ≈ 5 s, `commandcode` ≈ 8 s, `claude mcp list` health-checks at ≈ 23 s) is not killed mid-flight; if the budget expires the promise resolves with a degraded status object:
   ```ts
   {
     servers: [],
     totalTools: 0,
     healthy: false,
     degraded: true,
     error: `MCP status timed out after ${timeoutMs}ms`,
   }
   ```
2. **Deterministic Cleanup**: Timer handles are cleared in a mandatory `finally` block to prevent timer leakages across repeated polls, and the deadline timer is `.unref()`'d so a pending probe can never hold the process (or an Ink test runner) open.
3. **Degraded State Normalization**: If any individual server reports `status === "error"` but the overall report does not explicitly flag `degraded`, `fetchMcpStatusWithTimeout` automatically sets `degraded: true`.
4. **Listing-first order + cache (REQ-32)**: when the runtime implements `listMcpServers()`, that enumeration is tried first (it is the only source that can *attribute* servers to the active agent); an empty result falls through to `getMcpStatus()` config discovery, and a listing that outruns the poll still lands in a per-runtime cache (60 s) with a single shared in-flight spawn, so `claude mcp list` is not killed and retried forever.
5. **Periodic Polling Lifecycle**: Both `Dashboard` and `LiveDashboard` poll on mount and every 15 seconds via `setInterval`. Unmount callbacks clear intervals and set `active = false` flags, preventing state updates after component teardown.

#### Status Badge Formatting (`formatMcpBadge`)

`formatMcpBadge(report, agentName)` maps report metrics to concise colored terminal badges. Every badge is **self-describing and attributed** to the active agent (REQ-30 / REQ-32 / AC-32.4; the caller passes `runtime.id`), and every numeric field is nullish-coalesced so `undefined`/`NaN` cannot render (NFR-10):
- **Verified connected (Green)**: `MCP: 🟢 <n> connected (<tools> tools) · <agent>` — only servers a **real probe** reported reachable (e.g. `MCP: 🟢 3 connected · opencode`); the tool count appears only when a probe actually reported it
- **Error (Yellow)**: `MCP: 🟡 error — <sanitized reason> · <agent>` (or `MCP: 🟡 error · <agent>` when no reason is carried) when the report is `degraded`, carries an `error`, or any server reports `status === "error"`
- **Timeout (Yellow)**: `MCP: 🟡 timeout · <agent>` when the failure *is* the deadline (`MCP status timed out after <ms>ms`)
- **Configured / unverified (Gray)**: `MCP: ⚪ <n> configured · <agent>` — servers the agent's own CLI enumerated as configured (`enabled`/`disabled`/`pending`/`unknown`), i.e. known but never probed; only `connected` is ever described as live
- **Empty / Inactive (Gray)**: `MCP: ⚪ none · <agent>` — nothing registered, or nothing reported

### 23.4 Interactive Two-Pane Inspector Modal (`McpInspectorModal.tsx`)

Mounted via the `/mcp` slash command in `LiveDashboard`, `McpInspectorModal` renders a split-pane layout:

```
┌─ 🔌 MCP SERVER INSPECTOR ── 2/2 active ── 12 tools ─────────── Runtime: opencode ─┐
│ ┌─ Servers (2) ──────────────────────────┐ ┌─ Tools for git ───────────────────┐ │
│ │ ▶ git           [connected] [stdio] 5ms│ │   ▲ ... 2 more above              │ │
│ │   memory        [connected] [stdio] 1ms│ │ ▶ git_status                      │ │
│ │                                        │ │     Show current working tree ... │ │
│ │                                        │ │   git_diff                        │ │
│ │                                        │ │     Inspect diff between commits  │ │
│ │                                        │ │   ▼ ... and 3 more                │ │
│ └────────────────────────────────────────┘ └───────────────────────────────────┘ │
│ [↑/↓ or k/j] Navigate · [Tab/Enter] View Tools · [Esc] Close       Focus: servers│
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### Dual-Pane Focus & Keyboard Navigation
- **Left Pane (Servers)**: Displays each server as `name · transport · status · detail` — `[connected]` only for a verified probe, `[unknown]` for a server the agent's CLI reports as merely configured (`enabled`/`disabled`/`pending`), and whatever detail the CLI exposed (command, scope, auth) clamped to one column. Round-trip latency is shown only when a probe actually measured it. The pane header marks unverified servers as `n/total unverified` rather than counting them as active (AC-30.1).
- **Attribution & Muninn (AC-32.3 / AC-38.4)**: a header line names the source runtime (*"Servers come from **&lt;agent&gt;** — add or change them with the agent's own config or CLI; Huginn only observes them"*), and a second line states whether Muninn is registered for that agent (`✓ Muninn (the memory brain) is registered for <agent> … one project-scoped brain, shared by every agent`) or, when absent, the exact fix command `huginn setup --agent <id>`. An unknown server status reads "Status not reported by &lt;agent&gt; — configured, not probed" (AC-32.5).
- **Right Pane (Tools)**: Displays tools exposed by the currently highlighted server, with tool names and descriptions.
- **Focus Toggle**: `[Tab]` or `[Enter]` toggles `focusView` between `"servers"` and `"tools"`.
- **Directional Navigation**: `[↑]`/`[↓]` and `[k]`/`[j]` navigate the active pane. When navigating the server list, the tool list automatically resets selection to the first tool.
- **Dismissal**: `[Esc]` closes the modal, restoring live dashboard chat and input without loss of context.
- **React 19 Ref Bridge (`stateRef`)**: Uses `stateRef` synchronization to prevent stale closures in Ink's `useInput` hook during navigation.

### 23.5 Tool Pagination & Windowing Engine

When servers expose dozens of tools (e.g. AWS or database MCPs), rendering all items would overflow the terminal height. `McpInspectorModal` implements sliding-window pagination:
- **`MAX_VISIBLE_TOOLS = 10`**: Restricts the maximum number of simultaneously rendered tools to 10.
- **Centered Window Calculation**:
  ```ts
  const startIndex = Math.max(
    0,
    Math.min(
      selectedToolIndex - Math.floor(MAX_VISIBLE_TOOLS / 2),
      currentTools.length - MAX_VISIBLE_TOOLS,
    ),
  );
  const endIndex = Math.min(currentTools.length, startIndex + MAX_VISIBLE_TOOLS);
  const visibleTools = currentTools.slice(startIndex, endIndex);
  ```
- **Overflow Indicators**: Displays `▲ ... {moreAbove} more above` and `▼ ... and {moreBelow} more` markers when tools exist outside the current viewport.

### 23.6 Terminal Sanitization & Injection Defense (`sanitizeTerminalText`)

Server names, tool descriptions, and error payloads originate from external processes and untrusted configuration files. Unsanitized strings could emit ANSI escape sequences to hijack terminal cursors, manipulate alternate buffers, or poison logs (`SEC-001`).

`sanitizeTerminalText` lives in the shared module `src/util/text.ts` — relocated out of `src/engine/agent/mcpConfig.ts` so the TUI (`LiveDashboard`, `HelpModal`, `SkillsModal`, `McpInspectorModal`), the agent adapters (`generic.ts`), the MCP monitor (`mcpConfig.ts`), and the skills loader all share one implementation. Every consumer imports it from `src/util/text.js`. It sanitizes all displayed content:
- Strips ANSI escape sequences matching `[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`.
- Strips non-printable ASCII control characters **and the C1 range** `[\x00-\x08\x0B-\x1F\x7F-\x9F]` (the `\x7F–\x9F` addition covers 8-bit CSI/DCS/OSC introducers that the previous pattern left intact).
- Preserves printable whitespace (`\n`, `\t`) and valid Unicode text.

### 23.7 Project-Level MCP Declaration & Configuration Resolution

In addition to target agent configuration files (e.g. `~/.config/opencode/opencode.json`, `~/.claude.json`), `GenericSubprocessRuntimeAdapter` and runtime adapters automatically discover and load project-scoped declarations from `<project>/.huginn/mcp.json`.

1. **Supported Top-Level Keys**:
   - `mcpServers` (standard MCP client format)
   - `mcp` (OpenCode format)
   - `servers` (alternative container)
2. **File Size Defense (`SEC-002`)**:
   - Validates `statSync(configPath).isFile()` and bounds size to `1024 * 1024` (1MB). Files exceeding 1MB or pointing to special device files are rejected with a warning.
3. **Prototype Pollution Guard (`SEC-003`)**:
   - Strips dangerous object properties (`__proto__`, `constructor`, `prototype`) during both JSON parsing reviver and object iteration:
     ```ts
     const parsed = JSON.parse(content, (key, value) => {
       if (isReservedKey(key)) return undefined;
       return value;
     });
     ```
4. **Transport Inference**:
   - If `command` is present, transport defaults to `stdio`.
   - If `url` is present, transport defaults to `sse`.
   - Otherwise honors explicit `transport` string, sanitized against terminal injection.

---

## 24. Extensible Skills System & Rich Live Slash Commands

Iteration 23 adds a file-based **skills subsystem** (`src/engine/skills/`) and turns the Live console input bar into a first-class command surface (`/help`, `/agent`, `/skills`, `/status`, …) backed by two new modals (`HelpModal`, `SkillsModal`).

### 24.1 Motivation & Architectural Objectives

1. **Project-specific prompting**: teams want reusable, version-controlled prompt fragments (audits, refactors, domain explainers) without editing huginn's source or the installed opencode templates.
2. **Command discoverability**: before this iteration Live mode understood only `/draft`, `/go`, `/quit` and `/abort`; every other `/…` string was silently forwarded to the model as chat text, which produced confusing model replies to typos.
3. **Untrusted input**: skill files and skill directories come from the checked-out repository, so discovery and parsing must be treated as an attack surface (symlink escape, oversized reads, terminal-escape injection, prototype pollution).

### 24.2 Architecture Overview & Data Flow

```mermaid
flowchart TD
    subgraph "Live TUI (LiveDashboard.tsx)"
        Input["InputBar submit()"]
        Dispatcher{"starts with '/'?"}
        Help["HelpModal (/help)"]
        Skills["SkillsModal (/skills, /skill)"]
        Inspect["McpInspectorModal (/mcp [id])"]
        Picker["ModelPickerModal (/models, /model)"]
        Reject["system message: Unknown command"]
    end

    subgraph "Skills Subsystem (engine/skills/)"
        Loader["loadSkills(projectPath, { includeBuiltins })"]
        Parse["parseSkillContent()"]
        Find["findSkill(skills, query)"]
        Builtins["BUILTIN_SKILLS: audit, refactor, explain"]
    end

    subgraph "LiveEngine (engine/liveMode.ts)"
        Chat["chat(prompt)"]
        Switch["switchRuntime(agentId)"]
        Diag["getDiagnostics()"]
    end

    Input --> Dispatcher
    Dispatcher -- "/help" --> Help
    Dispatcher -- "/skills, bare /skill" --> Skills
    Dispatcher -- "/skill <name>" --> Find
    Dispatcher -- "/mcp [id]" --> Inspect
    Dispatcher -- "/models, /model" --> Picker
    Dispatcher -- "/status" --> Diag
    Dispatcher -- "/agent <id>" --> Switch
    Dispatcher -- "unknown /…" --> Reject
    Dispatcher -- "plain text" --> Chat
    Skills --> Loader
    Loader --> Parse
    Loader --> Builtins
    Loader --> Find
    Find -- matched skill body --> Chat
```

### 24.3 Skill Discovery, Precedence & Built-ins

`loadSkills(projectPath, options?)` (`src/engine/skills/loader.ts`) scans two project-relative directories, in order:

1. `<project>/.huginn/skills/`
2. `<project>/.opencode/skills/`

- **Precedence**: directory order is authoritative — a skill whose lowercased `id` (the `.md` basename) was already seen in `.huginn/skills/` is skipped in `.opencode/skills/`, so `.huginn` wins. Only `*.md` entries are considered; directory listing is sorted for deterministic order.
- **Built-in fallback**: with `includeBuiltins` (default `true`) three shipped skills — `audit`, `refactor`, `explain` (`BUILTIN_SKILLS`) — are appended for any id not shadowed by a project file, so a fresh repo always has usable skills. `includeBuiltins: false` yields project skills only.
- **Lookup**: `findSkill(skills, query)` resolves by exact `id`, then exact `name`, then exact `trigger`, and finally a case-insensitive substring match, so `/skill audit` and `/skill security` both reach the `audit` skill.

### 24.4 Frontmatter Parser & No-Frontmatter Fallback

`parseSkillContent(filename, filePath, rawContent)` implements a deliberately small, flat subset of YAML — not a full YAML parser:

- The `---`-delimited block is matched by `FRONTMATTER_REGEX`; only the flat `key: value` scalars are interpreted:
  - `name` or `title` → `name`
  - `description` or `desc` → `description`
  - `triggers` (or `trigger`) → list, accepting a YAML dash list (`- item`, continuation lines while indented), a bracketed flow list (`[a, b]`), or a bare comma list.
- **Inline `#` comments are stripped** from values, but only when the `#` is preceded by whitespace and outside quotes / brackets; values are then unquoted (`'…'` / `"…"`).
- Block scalars, nested keys, multi-line values and merge keys are **not** parsed and degrade to plain text.
- **No-frontmatter fallback**: `id` is the `.md` basename, `name` defaults to that basename, `description` defaults to the first paragraph (skipping a leading `# Heading`), `triggers` defaults to the lowercased `[basename]`, and `body` is the remaining paragraphs (or empty). A UTF-8 BOM is stripped before parsing.

Every produced field — including `filePath`, `name`, `description`, `triggers` and `body` — is passed through `sanitizeTerminalText` (`src/util/text.ts`), so terminal-escape payloads in a hostile skill file cannot reach the renderer.

### 24.5 Loader Security Hardening

Because skills are read from the repository, the loader treats discovery and reads as untrusted:

- **Scan-root containment**: `resolveContainedSkillDir` `lstat`s the candidate directory (rejecting symlinks and non-directories) and requires `realpathSync(candidate)` to equal `join(realpath(projectRoot), …segments)` **and** to stay under `realRoot + sep`. A hostile repo cannot point `.opencode/skills` at an arbitrary directory outside the project.
- **`O_NOFOLLOW` fd read with a size cap**: `readSkillFile` opens with `O_RDONLY | O_NOFOLLOW` (no symlink following, no stat/read race), `fstat`s the fd, rejects non-regular files and files larger than `MAX_FILE_SIZE_BYTES` (1 MB), and reads only from that fd.
- **Prototype-pollution key skip**: `__proto__`, `constructor` and `prototype` frontmatter keys are ignored during parsing (defence in depth alongside the same guard in the MCP config reader).
- **Terminal-escape sanitization**: see § 23.6 — the single shared `sanitizeTerminalText` implementation applied to every field.

### 24.6 Live Slash Command Dispatcher

`submit()` in `LiveDashboard.tsx` intercepts any input beginning with `/` before it can reach `LiveEngine.chat()`. Command *identity* and aliasing are resolved through the single command registry (`src/tui/commandRegistry.ts`, ADR-28 / REQ-28): `findCommand()` requires a leading `/`, so plain prose that merely starts with a command word is never dispatched as one, and only the per-command argument parsing stays in the `switch` below. The registry is also what the inline `CommandSuggestions` palette and `HelpModal`'s cheat sheet render from, with a drift-guard test asserting the three can never disagree. An unrecognized `/<...>` command is answered with a system message (`Unknown command "<cmd>" — type /help for the command reference.`) and **never forwarded to the model**; a registry entry that has no handler replies with an explicit warning instead of a silent no-op.

| Command | Behaviour |
|---|---|
| `/help` | Mounts `HelpModal` — command cheat sheet, navigation shortcuts, and the active agent/thinker/executor/project banner. `Esc`, `q` or `Enter` closes. |
| `/agent` | Opens the interactive `AgentPickerModal` (REQ-33): every `AGENT_TARGETS` row with an availability marker (`✔` / `— not installed`), the active one marked, and the highlighted entry's detected path; `↑`/`↓`/`j`/`k` move, `Enter` switches (a failed switch keeps the modal open), `Esc` cancels. |
| `/agent <id>` | Hot-switches the runtime via `LiveEngine.switchRuntime(id)`; an unknown id is rejected with the available-target list. |
| `/models`, `/model` | Mounts the interactive `ModelPickerModal`. |
| `/model <thinker> [executor]` (also `/models …`) | Validates `provider/model` syntax for both values (executor defaults to the current one), rejects extra args or malformed values, then calls `LiveEngine.updateModels(...)` for the session. |
| `/mcp`, `/mcp <id>` | Mounts `McpInspectorModal`, optionally pre-selecting a server by id (`text.slice(4).trim()`). |
| `/skills`, bare `/skill` | Refreshes via `loadSkills(cfg.projectPath)` and mounts `SkillsModal`; `Enter` on a skill executes it (`live.chat(skill.body)`). |
| `/skill <name>` | Resolves `findSkill(...)`; a match runs its `body` immediately, otherwise the browser hint message is shown. |
| `/status` | Calls `LiveEngine.getDiagnostics()` and renders a bordered box (branch, clean/dirty, worktree sandbox, runtime, thinker/executor, Muninn entity/observation counts). |
| `/clear` | Clears chat messages, stream buffer and both scroll offsets. |
| `/draft` (alias `/go`) | Runs `live.draft()` and, on approval, `onApprove()`. |
| `/quit` (alias `/abort`) | **Two-step confirmation**: the first invocation only asks to confirm; a second within the same session aborts. Any other command resets the pending confirmation. |

Each branch above answers with a sanitized acknowledgement from `feedback.ts` (`✓` result, `⚠` problem naming the next step with the raw cause on a `cause:` line, `…` while running), so no dispatched input is a silent no-op (REQ-31). While a bare `/…` draft has matches, the palette takes `↑`/`↓` (and `j`/`k`) / `Tab` / `Enter` / `Esc` *before* the dashboard's focus-toggle (`Tab`) and scroll-trap (`↑`/`↓`) handlers, and a draft with no matches does not count as open (REQ-28 / AC-28.3).

`SkillsModal` and `HelpModal` follow the same TUI conventions as the other modals: a `stateRef` bridge for fresh `useInput` callbacks under React 19, centered list windowing (`VISIBLE_LIST_ITEMS = 8`, `VISIBLE_BODY_LINES = 8`), `Tab` pane focus, and `Esc`/`q` dismissal. `HelpModal` sanitizes and clamps every external prop at the component boundary, and its `SLASH_COMMANDS` array is now *derived* from the command registry instead of hand-maintained.

### 24.7 `LiveEngine` Runtime Switching & Diagnostics

Two engine additions back the dispatcher (`src/engine/liveMode.ts`):

- **`switchRuntime(agentId)`**: resolves the target runtime via the injected `runtimeFactory` (a new optional `LiveEngineOptions.runtimeFactory` field used by tests) or `getAgentRuntime(...)`, then **fails closed** — if `isAvailable()` is false it throws and the active runtime is left untouched. On success it aborts the previous `session` (or `sessionId` via `abortSession`), swaps the runtime, clears the session handle, and sets `needsSystemPrompt` so the architect/system prompt is re-seeded on the next `prompt` rather than lost with the disposed session. A `liveChat` system event announces the switch.
- **`getDiagnostics()`**: returns `DiagnosticsInfo` assembled from best-effort git probes (`rev-parse --abbrev-ref HEAD`, `status --porcelain`, `--git-dir` worktree detection), the active `runtime.name`, the formatted thinker/executor models, and Muninn `getStats()` entity/observation counts — each wrapped in `try/catch` so a missing git repo or uninitialized memory DB degrades to defaults instead of throwing.
- `runtime` is now a **private field behind a public getter** (`get runtime()`), mutated only by the constructor and `switchRuntime`.

## 25. Iteration 24 — `huginn init` Onboarding Wizard, Two-Tier Help & Greenfield Launch

Iteration 24 removes the CLI's remaining first-run friction: a developer who cloned a repository and
typed a bare `huginn` got an unconditional live-mode launch — or the terse `"<path>" is not a git
repository.` failure once live mode reached its git check — with no route to the agent/model/MCP
configuration the engine needs, while `huginn --help` dumped one flat ~90-line string in which the
five commands a newcomer actually wants were indistinguishable from installer internals and
model-resolution precedence. Three changes ship together: a guided `huginn init` wizard, a two-tier
`--help` hierarchy, and greenfield-launch onboarding. The implementation lives in
`src/commands/init.ts` (new), `src/cli.ts`, `src/commands/setup.ts`, `src/setup/install.ts`, and
`src/engine/agent/registry.ts`.

### 25.1 Motivation & Architectural Objectives

1. **Onboarding with no new primitives**: every step the wizard needs already exists and is already
   hardened — `handleSetupCommand` (Muninn MCP + rules registration), `saveUserConfig` (atomic,
   symlink-safe, unknown-key preserving), `detectAvailableAgents` (PATH scan over `AGENT_TARGETS`)
   and `promptYesNo` (returns its fallback when non-interactive). `huginn init` is therefore a *thin
   orchestrator*: it adds only `existsSync` probes and sectioned output and delegates the rest. It
   owns no I/O, so it cannot drift from `setup`/`config` semantics.
2. **A scannable help surface**: the concise default must fit on one screen without abandoning the
   full reference, which other tools and `test/muninn/commands.test.ts` assert on — hence two
   functions rather than one aliased string.
3. **Greenfield safety on a live-first dispatcher**: because an unknown or absent subcommand is
   *already* meaningful input (a free-text idea, REQ-14.4), onboarding cannot hijack the no-argument
   case wholesale; it must stay out of the way of `huginn "add a checkout flow"`.

### 25.2 Architecture Overview & Data Flow

```mermaid
flowchart TD
    Main["main(argv) — src/cli.ts"] --> Help{"help / --help / -h?"}
    Help -- "yes, --all" --> Full["usage() — full reference"]
    Help -- "yes (-h too)" --> Core["usageCore() — concise"]
    Help -- no --> Route{"_command in KNOWN_COMMANDS?"}
    Route -- "known" --> Handler["explicit handler (incl. init)"]
    Route -- "none, or free-text idea" --> Green{"shouldLaunchInit(args, projectPath)?"}
    Green -- "yes — bare launch, no .huginn/" --> Launch["handleGreenfieldLaunch"]
    Green -- no --> Live["runLive(args, idea)"]
    Launch -- "TTY" --> Init["handleInitCommand — src/commands/init.ts"]
    Launch -- "non-interactive" --> Pointer["stdout pointer to huginn init (exit 0)"]
    Init --> Detect["detectAvailableAgents(PATH) — agent CLIs"]
    Init --> SetupCmd["handleSetupCommand — SetupReport / undefined"]
    Init --> Save["saveUserConfig — project config.json"]
    Init --> Prompt["promptLine / promptYesNo — PromptIo seam"]
```

### 25.3 The `huginn init` wizard (`src/commands/init.ts`)

`handleInitCommand(args, deps?)` prints six numbered sections and mirrors each finding into the
returned `InitReport`:

| Step | Detection / action | Source |
|---|---|---|
| 1. Repository | `existsSync(join(project, ".git"))` — informational only; a missing repo prints a `git init` tip and never fails | `src/commands/init.ts` |
| 2. Package manager | `detectPackageManager(projectPath)`: `bun.lock`/`bun.lockb` → `bun`, `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `package-lock.json` → `npm`, a lone `package.json` → `npm`, nothing → `unknown` (bun wins when lockfiles coexist) | `detectPackageManager` |
| 3. Agent CLIs | `detectAvailableAgents(env.PATH)`, printed primary-first (`PRIMARY_AGENT_CLIS` = `opencode`, `claude`, `codex`, `omp`) then the remaining `AGENT_TARGETS` in registry order; available entries show a green `✔` and their path, unavailable ones are dimmed | `src/engine/agent/registry.ts` |
| 4. Agent & models | TTY-only prompts, else the flags/defaults; the default agent is the first `available: true` entry of the *same* printed list, falling back to `DEFAULT_AGENT` (`opencode`) | `promptChoiceDefault` / `promptTextDefault` |
| 5. Muninn MCP | delegates to `handleSetupCommand({ "--agent", "--project", "--home"[, "--opencode-config-dir", "--force"] })`; `--skip-setup` skips it | `src/commands/setup.ts` |
| 6. Project config | `saveUserConfig(projectPath, { agent, thinker, executor })` → `<project>/.huginn/config.json` (atomic, unknown keys preserved); overwrite prompt on a TTY unless `--force` | `src/config.ts` |

- **Agent precedence inside the wizard**: `--agent` (case-folded, validated by `isAgentTarget`) →
  first detected available of the primary-first list → `DEFAULT_AGENT`. Because the default derives
  from the list the wizard just printed, the pre-selected agent can never contradict the first line
  of section 3 (REV-203). Unlike `resolveAgent`, the wizard reads no config or `HUGINN_AGENT` layer —
  there is nothing configured yet on a greenfield run — and it always writes the *project* config so
  the choices stay repo-local.
- **`InitReport`** is the contract callers consume: `projectPath`, `homeDir`, `configPath`, `agent`,
  `thinker`, `executor`, `setupRan`, `configWritten`. Pure step-mirror state (the git / package
  manager / agent findings) is printed but deliberately not part of it.
- **Non-blocking by construction**: `canPrompt = interactive && !env.CI && !--yes`; otherwise the
  flags and the documented `DEFAULT_THINKER_MODEL` / `DEFAULT_EXECUTOR_MODEL` are used. The only
  interactive question is overwriting an existing config, whose `promptYesNo` fallback is `true`, so
  a non-interactive re-run stays idempotent.
- **Failure semantics**: an unknown `--agent` and a failed config write print an error, set
  `process.exitCode = 1` and return before any write; a failed `huginn setup` delegation warns and
  sets `process.exitCode = 1` but still writes the config so the repository stays usable. The handler
  never throws and never calls `process.exit`.
- **`--help`/`-h`** early-returns `printInitUsage()` and writes nothing: the CLI's
  `huginn init --help` route and a programmatic caller both get the same "print usage, write nothing"
  contract.
- **`InitDeps`** makes every side effect injectable (`projectPath`, `homeDir`, `env`, `isTTY`,
  `stdin`, `stdout`, `detectAgents`, `runSetup`, `promptText`, `promptChoice`, `confirm`, `log`,
  `error`), so `test/commands/init.test.ts` exercises the production readline path against scripted
  TTY streams without touching the real `~`, the real opencode config or the terminal.

### 25.4 Greenfield launch onboarding (`src/cli.ts`)

Three exports add the routing rule without touching the live-first default:

- **`isGreenfieldLaunch(projectPath)`** — `!existsSync(join(projectPath, ".huginn"))`. The `.huginn/`
  directory is created by *every* stateful huginn command (`init`, `config set`, `memory`, live
  state), so its absence is the cheapest reliable "this repository has never run huginn" signal — no
  lock file or version marker needed.
- **`shouldLaunchInit(args, projectPath)`** — true only when there is no `_command`, no `_positional`
  idea, no `--help`/`-h`, no flag outside `BENIGN_BARE_FLAGS` (`--project`, `--home`,
  `--opencode-config-dir`, `--yes`), and the project is greenfield. An explicit idea, a work/mode flag
  such as `--headless`/`--resume`/`--thinker`, or an already-configured project keeps the documented
  live-first behavior, so the caller's explicit intent always wins over first-run guidance.
- **`handleGreenfieldLaunch(args, projectPath, deps?)`** — on an interactive TTY it forwards the
  canonical path as both the `--project` flag (so a raw/relative flag cannot win) and the wizard's
  `projectPath` default, then delegates to `handleInitCommand`; otherwise it prints a four-line
  pointer to `huginn init` / `huginn --help` on **stdout with exit code 0** — an unconfigured
  repository is guidance, not an error. The delegated wizard still reports a failed step (e.g. MCP
  registration) through `process.exitCode` (REV-201).

`main()` applies the predicate only inside the live-first branch (no known subcommand), so
`huginn run --project …` and `huginn "my idea"` are untouched.

### 25.5 Two-tier help hierarchy (`usageCore` / `usage`)

| Surface | Trigger | Content |
|---|---|---|
| `usageCore()` | `huginn --help`, `huginn help`, `huginn -h` | usage line, the five Core commands (`live`, `run`, `init`, `setup`, `doctor`), four copy-pasteable examples, the common flags, and a single "run `huginn --help --all`" pointer |
| `usage()` | `huginn --help --all`, `huginn help --all` | the full reference: every subcommand, every flag and default, and the model-resolution precedence order |
| `printInitUsage()` | `huginn init --help` | the wizard's own flags, steps and non-interactive note |

- `usage()` is kept byte-stable: `test/muninn/commands.test.ts` asserts on it (e.g. the
  `huginn memory init …` line) and it remains the long-form reference; `usageCore()` is a strict
  subset of it. All help surfaces print the banner first (`printBanner({})`) and exit 0.
- `--all` (and the wizard's `--skip-setup`) were added to `BOOLEAN_FLAGS` so `parseArgs` never
  swallows the following argument.
- **Drift guard**: `test/commands/init.test.ts` parses the `Core commands:` block out of
  `usageCore()` and asserts it is exactly `["live", "run", "init", "setup", "doctor"]`, that every
  one of those tokens also appears in `usage()`, and that `usage()` is longer than `usageCore()` — so
  the subset relationship is enforced rather than assumed.

### 25.6 Shared prompt seam & delegated-setup contract

Three small extractions keep the wizard from re-implementing existing behaviour:

- **`promptLine(question, fallback, io)` + `PromptIo { env?, stdin?, stdout? }`**
  (`src/setup/install.ts`) — one readline implementation whose TTY/CI guard and `node:readline`
  plumbing are shared. `promptYesNo(question, fallback, io)` now delegates to it (asking `[y/N]`
  with the `"yes"`/`"no"` fallback), so the `install` command and the wizard read answers through the
  identical seam; every field defaults to the real `process.*` primitive, so production callers omit
  it, and a blank answer resolves to `fallback`.
- **`handleSetupCommand` returns `Promise<SetupReport | undefined>`** (`src/commands/setup.ts`) —
  `undefined` for `--help`/`--list`, an unknown agent, or a failed `setup()`. Handlers in this CLI
  signal failure through `process.exitCode`, so a merely-resolved `await` is *not* success: the
  wizard sets `setupRan` only when the delegation both returned a report and left
  `process.exitCode !== 1` (REV-201). `src/cli.ts`'s own `setup` route ignores the return value.
- **`isAgentTarget(value): value is AgentTarget`** (`src/engine/agent/registry.ts`) — the single
  `AGENT_TARGETS` allowlist check, now exported and reused by `resolveAgent`, the CLI and the wizard
  (replacing `resolveAgent`'s former private `isTarget` closure), so the membership test exists once.

## 26. Phase 6 — Runtime Fidelity, Discoverability & Live Diagnostics

Phase 6 fixes what a hand-driven session on a real machine proved broken: model discovery that either
returned an unusable catalog or silently substituted a fabricated one, a TUI that never showed what
could be typed, an eagle where the raven belonged, and an MCP badge that claimed liveness Huginn had
never verified. The implementation lives in `src/engine/agent/adapters/` (plus `modelList.ts`),
`src/engine/agent/mcpStatus.ts`, `src/tui/commandRegistry.ts`, `CommandSuggestions.tsx`,
`RavenHeader.tsx` (with `src/brand.ts`), `feedback.ts`, `src/commands/memory.ts`,
`src/muninn/mcp/server.ts`, `src/server/lifecycle.ts` and `src/engine/liveMode.ts`. Nothing in the
engine's phase pipeline, the sandboxing model, the Muninn schema or the `provider/model` wire format
changed.

### 26.1 Truthful cross-runtime model discovery & native selection (REQ-27)

`getAvailableModels()` is now a thin projection of the optional richer `getModelCatalog()`
(`{ models, reason? }`), and **no** adapter invents a model any more — the previous
`anthropic/claude-opus-4-5` / `opencode/gpt-5.1-codex` substitution and the generic
`${id}/default` literal are gone. Discovery is per runtime:

| runtime | listing mechanism | verified |
|---|---|---|
| `opencode` | `client.provider.list()` intersected with the response's **`connected`** provider ids; on throw/empty, the `opencode models` CLI | 581 of the 8 195-model catalog |
| `commandcode` | `commandcode --list-models` (group headings, `id` + 2-space description rows; the trailing `Pass the full id…` / `Docs:` footer breaks the parse) | 82 |
| `omp` | `omp models` (`<provider> (<count>)` sections + box-drawing table; header and border rows skipped) | 192 |
| `agy` | `agy models` (`id<TAB>name` TSV; non-TSV preamble and duplicates dropped) | 14 |
| `claude`, `qwen`, `kimi`, `pi`, `cursor`, `windsurf`, `codex` | none → `[]` **with a reason** | — |

```mermaid
flowchart TD
    P["ModelPickerModal / cli.ts pre-flight"] --> C{"runtime.getModelCatalog()"}
    C -- "catalog" --> R{"catalog non-empty?"}
    C -- "throws" --> ERR["sanitized discovery error state + free-text id"]
    R -- yes --> LIST["render catalog (6-row window + substring filter)"]
    R -- no --> EMPTY["no models discovered + reason + free-text id"]
    LIST --> SEL["selection (catalog id, or free text)"]
    EMPTY --> SEL
    ERR --> SEL
    SEL --> FLAG["native channel: SDK model ref, or --model/-m via withModelArgs"]
```

- **Reasons are discriminating.** Every empty result comes from `runModelListCommand`
  (`src/engine/agent/adapters/modelList.ts`), which never throws and never fabricates: a missing
  binary (`could not run …`), a non-zero exit (`exited with code N: <first stderr line>`), a timeout
  or empty output each produce their own sanitized `reason`, so "no listing mechanism", "the CLI
  failed" and "nothing discovered" are distinguishable in the picker.
- **Native forwarding.** `withModelArgs` appends the runtime's documented flag
  (`--model`/`-m`) to argv and, when the base argv already carries that flag in either form
  (`--model old`, `--model=old`), **replaces its value** rather than dropping the pair;
  `HUGINN_MODEL` survives only as an extra env hint. opencode passes the model as an SDK model ref.
- **Provider validation.** `validateModels` (`src/cli.ts`) reads `config.providers().providers`
  (not `.all`), so the "provider is not in the configured provider list" warning fires only when a
  provider is genuinely absent instead of on every opencode run.
- **Honest picker (`ModelPickerModal`).** Distinct loading / empty / error states, no
  `DEFAULT_FALLBACK_MODELS`; a catalog selection and a bare id on a runtime that lists bare ids are
  accepted verbatim; filtering runs in a `useMemo` over a fixed 6-row window so a ~600–8 000-entry
  catalog stays responsive.
- **Verification.** Discovery is exercised against captured artifacts under `test/fixtures/`
  (a real `GET /provider` payload, `opencode models` with 581 lines, `commandcode --list-models`
  with 82 models, `omp models`, `agy models`) rather than hand-written mocks alone.

### 26.2 Discoverable slash-command palette (REQ-28)

`src/tui/commandRegistry.ts` exports the single `SLASH_COMMANDS` registry
(`id`, `aliases`, `argHint`, `description`, `category`, `takesArgs`) plus `findCommand` /
`matchCommands` / `commandUsage` / `describeCommand`. `submit()` resolves command *identity* through
it (requiring a leading `/`, so a prompt whose first word happens to be a command is never
dispatched), `CommandSuggestions` renders a bounded overlay from the same list, and `HelpModal`'s
`SLASH_COMMANDS` cheat sheet is *derived* from it, so the three cannot drift. While a bare `/…`
draft has matches, `↑`/`↓` (and `j`/`k`) move the highlight, `Tab` accepts, `Enter` submits and
`Esc` dismisses the overlay — all taking precedence over the focus-toggle and scroll-trap handlers
only while it is open — and the overlay's height (≤6 content rows, shrinking on short terminals)
is part of the layout budget so the cards shrink instead of overflowing.

### 26.3 Raven identity (`src/brand.ts` + `src/tui/RavenHeader.tsx`) (REQ-29)

The eagle emoji is gone from the source. One dependency-free `src/brand.ts` holds the five-row
`HUGINN` wordmark (also printed by the CLI banner) and the three-row ASCII raven mark; one
`RavenHeader` component renders them for both `Dashboard` and `LiveDashboard` so the headers cannot
diverge. `ravenHeaderPlan()` derives the variant and exact row cost from the measured
columns/rows, a `reservedRows` viewport floor and the caller's context rows:
mark + wordmark at ≥ 72 columns → wordmark only → plain `HUGINN` text (also when the terminal is
too short to afford the art). The header additionally carries the live stage, the MCP badge, the
runtime, the project path and the models, with every dynamic value sanitized and width-clamped
(`headerValue`) so a header row can never wrap into an unbudgeted extra line. The CLI and the TUI
therefore share one visual identity without sharing a rendering path.

### 26.4 Honest MCP/Muninn liveness & hardened stdio lifecycle (REQ-30)

- **No fabricated status.** `GenericSubprocessRuntimeAdapter` holds no MCP client, so a server it
  merely *finds* in `.huginn/mcp.json` or an agent config file is reported as `unknown`
  (`asUnverifiedServer`), and such a report is `healthy: false` with `unverified: true`; only
  opencode's real `mcp.status()` probe can report `connected`/`error`.
- **Errors propagate.** A throwing probe yields `degraded: true` plus the sanitized error (and the
  opencode adapter's `catch` does the same), so the badge shows `MCP: 🟡 error` instead of an
  ambiguous `⚪ 0 active`; a supervised daemon that died is reported as a recoverable error until it
  recovers.
- **Daemon supervision (`src/server/lifecycle.ts`).** After the initial health check the child is
  watched: an unexpected exit is logged, `isHealthy()` flips to `false`, `onExit` fires, and at most
  **one** best-effort restart is attempted with a backoff and its own health deadline before the
  failure is declared permanent — so a dead daemon is neither silent nor permanent.
- **Stdio lifecycle (`huginn mcp run`).** A `process.stdout` `'error'` handler turns an EPIPE into a
  logged clean shutdown, a no-op `stderr` `'error'` handler absorbs the second broken end, stdin
  `'end'`/`'close'` are bridged to the same `done()` used by `transport.onclose`, `server.onerror`
  logs protocol failures, and `send()` is bounded (5 s) so a broken pipe fails the pending request
  rather than hanging on `'drain'`.
- **Muninn diagnostics.** `getDiagnostics()` distinguishes "unavailable" from "empty": a failed DB
  open carries a sanitized `memoryStats.error` that `/status` prints instead of
  `0 entities, 0 observations`, and best-effort indexing failures in `phases.ts` are logged when
  `HUGINN_DEBUG` is set instead of being swallowed by a bare `catch {}`.

### 26.5 Fluid feedback (REQ-31)

`src/tui/feedback.ts` is the console's single voice: `okFeedback` (`✓`), `warnFeedback` (`⚠`),
`busyFeedback` (`…`), `failureFeedback` (a `⚠ <component> — <next step>` headline whose hint always
precedes a sanitized `cause:` line) and the `NEXT_STEP` hints (`/model <id>`, `/agent`, `/mcp`,
diagnostics, session). Every `submit()` branch emits one of them — including the previously silent
paths and the registry entry with no handler — so an action can no longer appear to do nothing, and
an error names the failing component and what to do next instead of dumping a bare message. An
empty chat viewport renders `EMPTY_CHAT_HINTS`, a short raven-flavoured list pointing at the palette,
`/draft`, `/mcp`, `/status` and `/help`, sliced to the rows the card actually has so it can never
push the frame past the terminal height.

## 27. Phase 7 — Per-Agent MCP Truth, Composer Ergonomics & Methodology Profiles

Phase 7 answers what a live session on this machine exposed. **MCP is per-agent** — Huginn holds no
client, the active agent owns every connection — yet the header reported an unattributed,
unexplained number that could print `undefined`. `/agent` could only *list* runtimes, so selecting
one (e.g. `agy`) meant memorising its id. The composer had no recall and no visual presence, the
agent-stream panel assumed reasoning most frontier models no longer emit, `gemini` was a dead target
whose `-p` needs an argument Huginn never passed, and agent questions only ever surfaced on opencode.
The implementation lives in `src/engine/agent/` (`mcpList.ts`, `mcpStatus.ts`, the adapters),
`src/engine/profiles.ts`, `src/engine/receipts.ts`, `src/engine/questionBlock.ts`,
`src/engine/liveMode.ts`, `src/agents/integrator.ts`, `src/commands/setup.ts`, `src/commands/doctor.ts`,
`src/config.ts`, `src/tui/` (`AgentPickerModal.tsx`, `LiveDashboard.tsx`, `Dashboard.tsx`) and the
fixtures under `test/fixtures/`. The phase pipeline's *engine* (`runPhase`/`runIteration`), the
sandboxing model and the Muninn schema are untouched.

### 27.1 Per-agent MCP enumeration & honest attribution (REQ-32)

The active agent is the only authority on its own servers, so `IAgentRuntime` gains an optional
`listMcpServers(): Promise<McpServerListing[]>` (`McpServerListing = { name; transport?;
status: "connected"|"enabled"|"disabled"|"pending"|"unknown"; detail? }`). Runtimes whose CLI can
list use it; the rest fall back to config-file discovery with `status: "unknown"`:

| runtime | listing command | parser | statuses seen |
|---|---|---|---|
| `opencode` | `opencode mcp list` | `parseOpencodeMcpList` | `connected` (box list, ANSI stripped) |
| `claude` | `claude mcp list` | `parseClaudeMcpList` | `connected` (`✔`, health-checks ≈ 23 s) |
| `qwen` | `qwen mcp list` | `parseQwenMcpList` | `connected` |
| `agy` | `agy mcp list` | `parseAgyMcpList` | `enabled`/`disabled` (TSV; **config state**) |
| `commandcode` | `commandcode mcp list` | `parseCommandcodeMcpList` | scope/auth surfaced as `detail` |
| `omp`, `kimi`, `pi`, `cursor`, `windsurf` | *(none)* | — | config discovery → `unknown` |

```mermaid
flowchart TD
    P["fetchMcpStatusWithTimeout(runtime, budget)"] --> L{"runtime.listMcpServers?"}
    L -- yes --> C{"cached (< 60 s)?"}
    C -- yes --> R["reportFromListings(agent, listings)"]
    C -- no --> RUN["listMcpServersViaCommand → runMcpListCommand (bounded, sanitized)"]
    RUN -- empty/timeout --> G["fall back to getMcpStatus() config discovery"]
    RUN -- listings --> R
    G --> R
    R --> B["formatMcpBadge(report, runtime.id)"]
    B --> H["MCP: 🟢 n connected · agent / ⚪ n configured · agent / ⚪ none · agent"]
```

- **Honest mapping (`mapListingToServerState`).** Only `connected` maps to `connected`; `disabled` →
  `disconnected`; `enabled`/`pending`/`unknown` → `unknown` (configured, never probed). A listing word
  is never upgraded to liveness (AC-32.2).
- **Attribution.** `reportFromListings` ids every server `<agent>:<name>`, defaults a missing
  transport to `"unknown"` rather than assuming stdio, and flags `unverified` whenever nothing was
  probed. The badge (`formatMcpBadge(report, agentName)`) names its source; every numeric field is
  nullish-coalesced (`count()` / `mcpToolTotal()`), so `undefined`/`NaN` cannot render (AC-32.4 /
  NFR-10).
- **Never fabricate, never block.** `runMcpListCommand` reuses `runModelListCommand`'s bounded spawn
  (timeout, stdout cap, process-group kill, sanitized `reason`) and returns `{ error }` rather than
  throwing; `listMcpServersViaCommand` collapses that to `[]` so a missing binary or unparseable
  output silently degrades to config discovery instead of failing the poll.
- **Deeper truth where it exists (AC-32.5).** Whatever per-server detail the CLI exposed (command,
  scope, auth) travels on `detail` and is shown verbatim; where the agent reports no status the panel
  says so ("Status not reported by &lt;agent&gt; — configured, not probed").
- **Verification.** Each format is fixture-tested against captured output
  (`test/fixtures/*-mcp-list.txt`, documented in `test/fixtures/README.md`), the status mapping and
  badge strings have their own tests, and a guard drives every badge state asserting the literal
  `undefined`/`NaN` never appears.

### 27.2 Interactive runtime picker (REQ-33)

`src/tui/AgentPickerModal.tsx` turns runtime switching into a selection. `/agent` (no argument) opens
it; `/agent <id>` is unchanged. The modal renders `AGENT_TARGETS` in registry order via
`buildAgentRows`, resolving availability from `detectAvailableAgents()` asynchronously (a detection
failure simply leaves every row "not installed", never blocks render). Each row shows the label, a
`✔` or `— not installed`, a `● active` marker for the current runtime, and — for the highlighted row
only — its resolved binary path; the list is windowed (`VISIBLE_AGENT_ROWS = 6`) with
`▲`/`▼` overflow markers. `↑`/`↓` (or `j`/`k`) move, `Enter` calls `onSelect` and `Esc` cancels; the
caller (`LiveDashboard`) keeps the modal open when a switch fails, so another runtime can be chosen
immediately, and its footer reminds the user that Muninn memory is project-scoped and unaffected.

### 27.3 Composer ergonomics & honest panels (REQ-34 / REQ-35)

- **Input history.** `LiveDashboard` keeps a bounded `inputHistory` (`INPUT_HISTORY_LIMIT = 50`); `↑`
  recalls the previous submission when the palette is closed, the draft is empty and the chat card is
  focused, and `↓` walks forward ending at the empty draft. Recalled drafts stay editable, and
  slash-command submissions are excluded from history.
- **Composer presence (AC-34.2).** `ChatInputRow` owns its accent border/background and a `❯` glyph,
  and reserves exactly one content line regardless of placeholder or history hint, so the layout
  budget at 80×24 is unchanged.
- **Honest panels.** The `REFINEMENT CONVERSATION` card is renamed **`Conversation`** wherever
  rendered or documented (AC-35.1). The agent-stream panel is adaptive (AC-35.2): it renders
  collapsed — returning its rows to the conversation — until the session has real stream content, and
  expands on the first content; it is never an empty bordered box.
- **Target hygiene (AC-35.3, ADR-34).** `gemini` is removed from `AGENT_TARGETS`/`AGENT_REGISTRY`. The
  persisted-config path stays safe: `REMOVED_AGENT_TARGETS` (`gemini → agy`) makes `resolveAgent`
  warn and fall back to detection instead of throwing, and any *other* unknown value is still rejected.

### 27.4 Methodology profiles — the Huginn Cycle + SDD/ODD/RDD/Strict-TDD (REQ-36)

The pipeline was already data (`PipelineStep[]`), so a profile is a **named, ordered subset of the
existing phase vocabulary** plus the evidence it must freeze — `runPhase`/`runIteration` are
untouched. `src/engine/profiles.ts` defines `PROFILES: Record<ProfileName, ProfileSpec>`
(`ProfileName = "huginn"|"sdd"|"odd"|"rdd"|"strict-tdd"`, `DEFAULT_PROFILE = "huginn"`, i.e. the
**Huginn Cycle**), each with `phases`, an `evidence` rule (`none`/`receipt`/`snapshot`), and an
optional `preamble` folded into the iteration prompt:

| profile | phases | evidence |
|---|---|---|
| `huginn` | SPEC_AUDIT → EXECUTE → VALIDATE_STEP → TEST_MODULE → SECURE_CHECK → REVIEW → DOC_SYNC → COMMIT_ALL | none |
| `sdd` | SPEC_AUDIT → EXECUTE → VALIDATE_STEP → TEST_MODULE → REVIEW → DOC_SYNC → COMMIT_ALL (+ spec-first preamble) | receipt |
| `odd` | EXECUTE → TEST_MODULE → COMMIT_ALL | none |
| `rdd` | EXECUTE → TEST_MODULE → VALIDATE_STEP → COMMIT_ALL | receipt |
| `strict-tdd` | TEST_MODULE → EXECUTE → TEST_MODULE → VALIDATE_STEP → COMMIT_ALL | snapshot |

- **Surface.** `--profile <id>` on `run` and `live`, `profile` in `RunConfig`/`UserConfig`/
  `stateSchema` (sanitized like `mode`), and `huginn config set --profile`. `resolveProfile` fails
  closed with usage on an unknown flag; a persisted unknown profile is dropped with a warning.
- **Profile-aware lists.** `--only-phase` validates against `PROFILE_PHASES` (the union over all
  profiles), and `MAIN_PHASES`-derived progress/`PHASE_LABEL` render from the active profile.
- **Two subtleties the gate forced.** The resume cursor is occurrence-aware (keyed off the first step
  the iteration has *not* recorded, not `currentPhase` which starts at SPEC_AUDIT), so a profile that
  does not begin with SPEC_AUDIT no longer runs zero phases and reports success; and `strict-tdd`'s
  pre-EXECUTE `TEST_MODULE` (`testFirst: true`) is **judged but never blocks or triggers `FIX_TEST`**,
  so the failing test is recorded as evidence rather than "fixed" into an inverted TDD.
- **Frozen evidence (`src/engine/receipts.ts`).** For `rdd`/`strict-tdd`, `buildIterationReceipt`
  produces an `IterationReceipt` (profile, base/head commits, `treeHash`, verdicts, and for
  `strict-tdd` the `preExecuteTree`) and `writeIterationReceipt` persists it to
  `.huginn/receipts/iter-<n>.json` (`0o600`) — best-effort, so a receipt can never fail an otherwise
  successful iteration. The claim "tests passed" is checkable against a hash instead of prose.
- **Announced & fail-closed.** The active profile is printed in the CLI banner (`profile=huginn`) and
  shown as the **Methodology** row in `/status`; `validateProfilePhases` rejects a profile naming an
  unimplemented phase rather than silently degrading to the default.

### 27.5 Agent-agnostic question protocol (REQ-37)

Only opencode could surface a mid-turn question (and only with `permissions: ask` through its own
event stream); every subprocess CLI closes `stdin` after the prompt. `src/engine/questionBlock.ts`
defines a **marked block** that needs no protocol support from the CLI:

```
<<<HUGINN_QUESTION>>>
[{"question": "Which database?", "header": "Storage",
  "options": [{"label": "Postgres", "description": "managed"},
              {"label": "SQLite", "description": "embedded"}]}]
<<<END_HUGINN_QUESTION>>>
```

```mermaid
sequenceDiagram
    participant Agent as Any runtime (subprocess or opencode)
    participant Live as LiveEngine.chat()
    participant Parser as parseQuestionBlock()
    participant UI as DecisionModal
    Agent->>Live: reply text + marked block
    Live->>Parser: parseQuestionBlock(reply)
    Parser-->>Live: { questions, cleanedText }
    Live->>Live: emit cleanedText (block stripped)
    alt questions present
        Live->>UI: DecisionRequest { kind: "question", questionItems }
        UI-->>Live: digit → option label / Enter → recommended / d → skip / Esc → abort
        Live->>Agent: follow-up turn (formatQuestionAnswer)
    end
```

- **Parsing.** `parseQuestionBlock` returns `{ questions, cleanedText, warning? }`. It strips **every**
  block from the displayed text (so a second block cannot leak raw markers), bounds the payload
  (64 KiB), the question count (10) and the options (8), sanitizes every field, and — for an
  unparseable, oversized, unclosed or options-less block — returns a sanitized `warning` **without
  truncating the rest of the reply**. `normalizeQuestion` keeps `multiple`/`custom` flags if present.
- **Wiring.** `LiveEngine.chat()` parses the reply, emits any warning to the system log, strips the
  block, and when questions exist raises a `kind: "question"` `DecisionRequest` through the decision
  broker; the chosen answer(s) are sent back as a plain follow-up turn (`formatQuestionAnswer`) so it
  works on every runtime. `askQuestion` bounds the wait (`QUESTION_TIMEOUT_MS = 10 min`, `.unref()`'d)
  and aborts the turn on expiry rather than hanging. opencode's native `question.asked` /
  `permission.asked` path is untouched and produces the same `DecisionRequest`.
- **Decision UI.** `DecisionModal` (and `LiveDashboard.resolveDecisionKey`) render one row per option
  with its description, inline (a `<Box>` column, not a `<Box>` inside a `<Text>` — Ink would not draw
  it). A digit `1`–`9` picks that option verbatim, `Enter` accepts the recommended (first) one, `d`
  skips and `Esc` aborts; keys are matched explicitly, so the `input === ""` that Ink sends for
  non-alphanumeric keys (Escape included) can no longer silently answer. Only the **first** question
  is selectable, and a multi-question block says so.
- **Deliberately de-scoped (AC-37.3).** `multiple` (multi-select) and `custom` (free-text) are parsed
  but honoured nowhere, and there is no arrow-key selection; a future iteration must amend the AC
  before claiming them, rather than assume them.
- **Taught to the agent.** The protocol is injected into the refine system prompt and the Muninn rules
  block (`integrator.ts`), so any agent can be told how to ask.

### 27.6 Muninn provisioning & agent-independent memory (REQ-38)

Memory is Huginn's differentiator, so it must not belong to any agent. The database stays
**project-scoped** (`<project>/.huginn/muninn.db`, ADR-20); the engine never keys memory by
`runtime.id`, so switching runtime mid-session reads and writes the *same* brain (asserted by a test
that observes identical stats across a switch).

`huginn setup` gains a provisioning surface built on `describeMuninnProvisioning` (a
`MuninnProvisioningRow[]` of agent × installed × registered, with the inspected paths):

- **`--status`** prints the matrix (`✔ registered` / `• not registered`, `installed` / `not installed`)
  plus the exact fix command for the installed gaps (`huginn setup --agent <id1,id2>`), and writes
  nothing. `huginn doctor` renders the same rows in its `integrations` check.
- **`--agent a,b`** selects exactly that subset (comma-separated; `all` is the default); an unknown
  name — alone or in a list — exits non-zero with usage.
- **`--installed`** *filters* the selection to agents whose CLI is present and reports the skipped
  ones; it never widens the selection.
- **`--dry-run`** computes the identical report and writes **nothing**: `writeAtomic` returns early
  while still reporting what would be registered, skipped as conflicting, and which rules files would
  change.
- **One registration mechanism (AC-38.3, verified).** A native-first path (`opencode/claude/qwen/agy/
  commandcode mcp add`) was evaluated and rejected — `opencode mcp add` takes no command positional
  (it prompts interactively) and `commandcode mcp add` accepts only `url`, so shelling out would need
  per-CLI special cases for strictly less safety than the hardened file writer the agents already
  read. Provisioning keeps the single `registerMcpForTarget` (atomic, symlink-safe, key- and
  sibling-preserving, `0o600`); an existing registration is a no-op and an unparseable config is
  reported, never rewritten.





