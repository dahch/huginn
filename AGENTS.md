# Huginn — Agent & Command Inventory

This file documents the roles and step instructions **huginn composes and drives itself**, plus what
a developer working *on* huginn needs to know to run, test, and debug it.

The definitions live in `src/engine/steps/instructions.ts` (the inlined role texts and task bodies),
are composed per step by `src/engine/steps/prompts.ts` over the bounded context helpers in
`src/engine/steps/context.ts`, and are driven by `src/engine/phases.ts` + `src/engine/cycle.ts`.

> There is **nothing to install**. The old opencode subagents/slash commands, the `templates/` tree,
> `scripts/postinstall.ts` and `HUGINN_TEMPLATES_DIR` are gone; `huginn install` prints a
> compatibility notice and exits 0. The only agent huginn ever asks opencode for by name is the
> built-in `build` agent — used by `EXECUTE` and the `FIX_*` phases so the SDK session keeps that
> agent's tools. Every other step is a plain prompt, which is what makes a subprocess runtime
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
- **Driven by**: `SPEC_AUDIT` (`specAuditPrompt`) and as sub-prompt 2 of `VALIDATE_STEP`
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
  bounded patterns instead.
- **Driven by**: `TEST_MODULE` (full mode, `testModulePrompt`) and sub-prompt 1 of `VALIDATE_STEP`
  (`validateStepQaPrompt`), where `auditOnlyGuardrails()` (`src/engine/steps/context.ts`) appends the
  audit-only contract: run the existing suite **once**, non-interactively and read-only; write **no**
  artefacts (no coverage output, `-u`/`--update` snapshots forbidden, no file-writing reporters); do
  not create, modify, move or delete anything.

### `security` (`ROLE_SECURITY`)
- **Purpose**: Application security audit — hardcoded secrets/credentials, auth & authorization
  flaws, injection, dependency CVEs (`npm audit`, Maven dependency-check), data exposure, insecure
  config, weak crypto. Stack-aware (Java / Node / polyglot). Read-only: never modifies the codebase.
- **Driven by**: `SECURE_CHECK` (fast pre-push scan, `secureCheckPrompt`) and sub-prompt 3 of
  `VALIDATE_STEP` (`validateStepSecurityPrompt`), whose task body scopes the diff and **excludes
  test files** (they contain mock credentials and produce false positives).

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
| `SPEC_AUDIT` | `specAuditPrompt` | spec-auditor role + spec/adr/plan + iteration + git status | `### Overall fidelity:` parsed by `parseSpecAuditVerdict` |
| `EXECUTE` | `executePrompt` | the iteration's prompt verbatim (+ the profile preamble) | non-blocking, but an empty report still fails closed |
| `VALIDATE_STEP` | `validateStepSubPrompts` (qa / spec / security) + `validateStepSynthesisPrompt` | three independent audits, then a consolidation turn | huginn computes it (§4) |
| `TEST_MODULE` | `testModulePrompt` | qa role + module scope | judge pass (`judgePhase`) |
| `SECURE_CHECK` | `secureCheckPrompt` | security role + scoped diff | judge pass |
| `REVIEW` | `reviewPrompt` | reviewing role + pre-PR diff | judge pass |
| `DOC_SYNC` | `docSyncPrompt` | doc-writer role + recent history | informative (never blocks) |
| `COMMIT_ALL` | `commitAllPrompt` | commit instruction + pending changes | informative (never blocks) |
| `FIX_SPEC` / `FIX_VALIDATE` / `FIX_TEST` / `FIX_SECURITY` / `FIX_REVIEW` | `fixFindingsPrompt` (+ the speculative/security extras) | the finding report + the extra instructions | re-runs the gate |

`runCommand` still exists on `IAgentSession` (the opencode and generic adapters implement it) but **no
step uses it**: a huginn step is always a prompt, so a runtime with no command surface runs the same
pipeline.

## 3. Which model runs what

The `--thinker` / `--executor` split is enforced in `src/engine/phases.ts` + `src/engine/cycle.ts`
(run) and `src/engine/liveMode.ts` (live):

| Work | Model | How |
|---|---|---|
| `SPEC_AUDIT` (spec-auditor prompt) | **executor** | `promptWithContext({ text: specAuditPrompt(ctx), model: executor })` — unless the repo has no implementation code yet, in which case the audit is **skipped** (`hasImplementationCode`, `src/engine/diff.ts`) and the role is never invoked |
| `EXECUTE` (build agent) | **executor** | `promptWithContext({ text: executePrompt(ctx), agent: "build", model: executor })` |
| `VALIDATE_STEP` (qa + spec-auditor + security + synthesis) | **executor** | four `promptWithContext` calls, each with `model: executor` |
| Judge pass for `TEST_MODULE` / `SECURE_CHECK` / `REVIEW` | **executor** | `judgePhase(..., executor, ...)` |
| `FIX_SPEC` / `FIX_VALIDATE` / `FIX_TEST` / `FIX_SECURITY` / `FIX_REVIEW` | **thinker** | `fixFindingsPrompt` → `promptWithContext({ agent: "build", model: thinker })` |
| `huginn plan` drafts (spec → adr → plan) | **thinker** | `prompt({ model: thinker })`, 20-min timeout each |
| `huginn live` chat refinement / scope extraction / doc drafts (`LiveEngine`) | **thinker** | `prompt({ model: thinker })` via `liveMode.ts`, 20-min timeout each; after handoff the resulting `CycleEngine` uses the executor per the rows above |

## 4. Orchestration, verdicts and the read-only guard

`/validate-step` used to work only because the installed `reviewing` agent could delegate to `qa`,
`spec-auditor` and `security` through opencode's Task tool. That allowlist is gone with the templates:
**huginn runs the chain itself** (qa → spec-auditor → security → synthesis, one prompt each) and
decides the outcome:

- `computeValidateVerdict` derives the gate from the three sub-reports (each must emit its own
  `### Audit status:` / `### Overall fidelity:` line): an empty or marker-less report is `blocked`, any
  blocked → `blocked`, any warning → `warning`, all green → `pass`. The synthesis may only **escalate**
  it, never downgrade it.
- `enforceValidateVerdict` strips every pre-existing `### Overall gate:`/handoff line from the
  synthesis and appends huginn's own, so `parseValidateStepVerdict` reads back exactly what huginn
  computed. The verdict also travels structurally as `authoritativeVerdict`, which `runPhase` prefers
  over parsing the report text.
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

## 5. Runtime requirements

1. **Bun** (the bin is `#!/usr/bin/env bun`; the bundle is Bun-target).
2. **An agent CLI on `$PATH`** — any of the 13 registered targets. `opencode` is the default and the
   only runtime with a native permission subscriber (`--permissions ask|deny`), server-side
   session history, and an incremental output channel (`IAgentRuntime.streamsOutput`, `true` only
   there — every subprocess CLI buffers stdout and resolves once, so a surface shows the phase report
   instead of pretending to stream); when it is used, huginn starts it itself via
   `opencode serve --port <n> --hostname 127.0.0.1` in the project dir (logs to
   `.harness/logs/server.log`).
3. **`git` on `$PATH`** — used for module inference, diffs, base commits, doc staging and worktree
   sandboxing. The project directory does **not** have to be a repository: `run`/`plan`/`live`
   bootstrap one (`git init -b main` + `.gitignore` + a bootstrap commit) unless `--no-git-init` is
   passed. `plan.md`/`spec.md`/`adr.md` must exist for `run` (but not for `plan`/`live`, which create
   or update them).
4. **Nothing to install** — the roles and task bodies are embedded in the binary (§1). There is no
   `templates/` directory, no `postinstall` hook and no warning about missing pieces.

## 6. Developer workflow (working on huginn itself)

```sh
bun install            # dependencies only — there is no postinstall hook any more
bun link               # exposes the global `huginn` bin → dist/cli.js
bun test               # unit tests under src/**/*.test.ts (bun:test)
vitest run             # integration + Muninn suite under test/**/*.test.ts
bun run typecheck      # tsc --noEmit (strict)
bun run dev -- ...     # run from source, e.g.
                       #   bun run dev -- run --project ../repo --thinker a/b --executor c/d
bun run build          # bun build src/cli.ts --target=bun --outdir=dist --minify
```

The suites that matter for the step pipeline and its state: `src/engine/gate.test.ts` (the verdict
parsers), `src/engine/cycle.test.ts` (retry/escalation, the read-only guard, structural verdicts),
`src/engine/steps/prompts.test.ts` + `src/engine/steps/context.test.ts` (composition, bounding,
nonce delimitation, the git-interpolation allowlist, doc containment), `test/engine/phases.test.ts`
(the orchestrated `VALIDATE_STEP`: three sub-prompts plus synthesis, the deterministic verdict and
the single imposed gate/handoff line), `test/engine/phasesContractGuard.test.ts` (a compiler-contract
verification that throws fails closed), `test/engine/gitRepo.test.ts` + `test/engine/docPath.test.ts`
(bootstrap and path containment), and `test/state/liveSession.test.ts` +
`test/engine/liveSessionPersistence.test.ts` + `test/commands/liveSessions.test.ts` (the persisted
live store, resume flags and reattach).

### Env overrides (all optional)

| Variable | Effect |
|---|---|
| `HUGINN_OPENCODE_CONFIG_DIR` | Where opencode's own config lives (default `~/.config/opencode`); also where the update-check cache (`huginn-update-cache.json`) is written. No longer an install destination (`getOpencodeConfigDir`, `src/setup/opencodeConfig.ts`). |
| `HUGINN_NO_UPDATE_CHECK` | Any non-empty value disables the background npm version check (`src/update.ts`). |
| `HUGINN_DEBUG` | Print full error stack traces on fatal errors, plus non-fatal notes (e.g. why Muninn indexing or contract verification was skipped). |
| `HUGINN_THEME` | `light` \| `dark` \| `auto` (default) — pins the TUI palette (`src/tui/theme.ts`). |
| `NO_COLOR` | Any non-empty value clears every theme token and `dimColor` (per no-color.org). |
| `CI` | Every prompt (`promptLine`/`promptYesNo`, `src/util/prompt.ts`) returns its fallback instead of reading stdin; nothing blocks on a human. |

### Testing the step prompts and the verdict contract

- The verdict markers are a **three-way contract**: the literals in
  `src/engine/steps/instructions.ts` / `src/engine/steps/context.ts` (`AUDIT_STATUS_*`,
  `SPEC_FIDELITY_*`, the `VALIDATE_STEP_GATE_LOGIC` and handoff lines), huginn's own enforcement
  (`computeValidateVerdict` / `enforceValidateVerdict` in `src/engine/phases.ts`), and the parsers in
  `src/engine/gate.ts` (`parseValidateStepVerdict`, `parseSpecAuditVerdict`, `parseAuditStatus`). A
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
| `/status` | Renders branch, dirty state, worktree sandbox, runtime, models and Muninn counts. | `LiveEngine.getDiagnostics()` |
| `/clear` | Clears chat + stream viewports. | — |
| `/draft` / `/go` | Runs scope extraction and drafting. | `LiveEngine.draft()` |
| `/quit` / `/abort` | Two-step confirmation, then aborts. | `LiveEngine.requestAbort()` |

Session resume is a CLI-flag surface rather than a command: `--continue`/`-c`, `--session <id>` and
`--list-sessions`/`-sl` read `<project>/.huginn/live/sessions.json` (`src/state/liveSession.ts`). The
store and the resume precedence are documented for users too, in the `usage()` section *Sessions
(live)* (`src/cli.ts`, REQ-53).

Two display conventions a TUI change must follow:

- **Display glyphs come from `src/tui/glyphs.ts`** — one table of single-width ASCII shared by the
  dashboard and `.harness/PROGRESS.md` (`·` pending, the braille spinner while running, `✓` pass, `!`
  warning, `✕` blocked, `–` skipped; phase kinds `?` `>` `=` `%` `#` `@` `~` `.`, `+` for any other).
  Never add an emoji display glyph. The gate marker literals (`### Overall gate: 🟢/🟡/🔴`,
  `### Overall fidelity: …`) and the runtime stream prefixes (`⚡ ✓ ✗ 💭`) are excluded: the first are a
  three-way contract, the second are producer output.
- **An output panel only claims what the runtime can deliver**: the run dashboard's `StreamCard` shows
  the last finished phase's report, or the two-raven idle state, and keeps the `LIVE AGENT OUTPUT`
  title and waiting placeholder **only** for a runtime whose `IAgentRuntime.streamsOutput` is `true`
  (`opencode`); everything else is titled `AGENT OUTPUT` and names itself (REQ-51).

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
