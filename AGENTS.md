# Huginn — Agent & Command Inventory

This file documents the opencode subagents and slash commands that **huginn
installs and drives**, plus what a developer working *on* huginn needs to know
to run, test, and debug it. The definitions themselves live in
`templates/agents/*.md` and `templates/commands/*.md`; the engine code that
invokes them is `src/engine/phases.ts` and `src/engine/cycle.ts`.

> The `build` agent is built into opencode and is **not** bundled by huginn —
> it is invoked by name (`agent: "build"`) by the execute and fix phases and by
> `/commit-all`.

## 1. The five agents (installed to `~/.config/opencode/agents/`)

### `spec-auditor`
- **Purpose**: Contract auditor. Detects **semantic deviation** between `spec.md`
  and the implementation — omissions, additions, substitutions — across module
  boundaries, domain model, port/adapter contracts, behavior, config, and
  `EXECUTION_CONSTRAINTS`. Explicitly *not* a code-quality reviewer.
- **Permissions** (frontmatter): read/glob/grep/list allowed; `edit` denied;
  bash restricted to `git diff/log/show/ls-files`, `find*`, `cat*`; webfetch,
  websearch, task, todowrite denied.
- **Driven by**: `SPEC_AUDIT` phase (`prompt` with `agent: "spec-auditor"`),
  and inside `/validate-step` (phase 2 of its chain).
- **Contract with the engine**: the report must end with the line
  `Overall fidelity: 🟢 ALIGNED / 🟡 MINOR DRIFT / 🔴 MAJOR DEVIATION` —
  `parseSpecAuditVerdict` in `src/engine/gate.ts` reads it.
- **Manual use**: `huginn install && opencode` then
  `spec-auditor: audit semantic alignment between SPEC.md and src/...`.

### `qa`
- **Purpose**: Senior QA engineer. Tests (unit 70% / integration 20% / E2E 10%),
  coverage analysis, gap reporting. Has **two modes** decided by the invocation
  prompt: if it contains `AUDIT-ONLY MODE` the agent must **not** write/modify
  any test file — it runs existing tests, reports coverage, and lists gaps
  (used by `/validate-step`); otherwise FIX mode, full test authoring.
- **Permissions**: `edit` allowed; bash allows test runners (`npx *`,
  `npm run test*`, `npm run coverage*`, `npm test*`, `yarn test*`, `pnpm*`,
  `bun test*`, `bun run test*`, `bun run coverage*`, `vitest*`, `jest*`,
  `playwright*`, `cypress*`, `pytest*`, `cargo test*`, `go test*`) and
  reading coverage/config files; webfetch denied; websearch, todowrite
  allowed; task denied.
- **Guardrails**: tests always run **non-interactively** — never watch mode
  (`vitest run` / `jest --watchAll=false --ci --runInBand` / `bun test` /
  `pytest -q`, never bare `vitest`, `cypress open`, `playwright test --ui`).
  Searches must never recursively glob package-manager/build-cache
  directories (`node_modules`, `build/`, `dist/`, `.git/`, `~/.gradle`,
  `~/.m2`, `~/.npm`, `Pods/`, `.build/`) — scope to the project tree with
  bounded patterns instead.
- **Driven by**: `/test-module` (FIX mode) and `/validate-step` phase 1
  (AUDIT-ONLY mode).

### `security`
- **Purpose**: Application security audit — hardcoded secrets/credentials,
  auth & authorization flaws, injection, dependency CVEs (`npm audit`, Maven
  dependency-check), data exposure, insecure config, weak crypto. Read-only:
  never modifies the codebase.
- **Permissions**: `edit` denied; bash allows `grep -r*`, `find * -name
  .env*/...`, `cat package*.json|yarn.lock|pom.xml|build.gradle*|*application*`,
  `npm audit*`, `git log --all --full-history*`, `git grep*`, `git diff*`;
  webfetch/websearch allowed; task denied; todowrite allowed.
- **Driven by**: `/secure-check` (fast pre-push scan) and `/validate-step`
  phase 3 (scoped diff excluding test files, which contain mock credentials).
- **Manual use**: `/secure-check` before a push.

### `doc-writer`
- **Purpose**: Senior technical writer. Creates/updates README.md, ADR.md,
  SPEC.md, DESIGN.md, AGENTS.md, API docs, and inline comments — updates only
  what is stale.
- **Permissions**: `edit` allowed; bash allows `git log/diff/shortlog/tag`,
  `find * -name *.ts/*.tsx/*.md`, `cat package.json|tsconfig*|openapi*|swagger*`;
  webfetch/websearch allowed; task denied; todowrite allowed.
- **Driven by**: `/doc-sync` (non-blocking `DOC_SYNC` phase).
- **Note**: this agent's prompt is the same documentation policy the huginn
  docs were written against; keep `templates/agents/doc-writer.md` in sync with
  the doc set it describes.

### `reviewing`
- **Purpose**: Expert code reviewer — Clean Architecture, DDD, SOLID, FSD
  (Feature-Sliced Design), performance, patterns. Reports only, never edits.
- **Permissions**: `edit` denied; bash allows `git diff/log/show/blame`;
  webfetch/websearch allowed; todowrite denied; **`task` is restricted to
  exactly `qa`, `spec-auditor`, `security` — every other Task target is
  denied** (see delegation note below).
- **Guardrails**: searches are scoped to the project's own source tree;
  recursive globs over package-manager/build-cache directories
  (`node_modules`, `build/`, `dist/`, `.git/`, `Pods/`, `.build/`,
  `~/.gradle`, `~/.m2`, `~/.npm`) are banned — a `**` glob there can hang
  for tens of minutes and stall the pipeline. Use bounded patterns
  (`find <path> -maxdepth N ... | head`) and grep scoped to project paths.
- **Driven by**: `/review` (pre-PR review of `main...HEAD`) and `/validate-step`
  (it is the `agent:` of that command and orchestrates the three-phase chain).

## 2. The six slash commands (installed to `~/.config/opencode/commands/`)

| Command | `agent:` | Purpose |
|---|---|---|
| `/validate-step <module> [spec] [git-range]` | `reviewing` | Full validation gate: chains **qa (AUDIT-ONLY) → spec-auditor → security**, detects cross-phase contradictions, and emits `### Overall gate: 🟢/🟡/🔴` plus a trailing `✅ AUTO-APPROVED` / `⚠️ REVIEW REQUESTED` / `🛑 BLOCKED` marker line. |
| `/test-module <module>` | `qa` | Full QA cycle on a module: analyze, write missing tests, run, report coverage. |
| `/secure-check` | `security` | Fast pre-push scan of `git diff HEAD` for secrets/tokens/credentials. |
| `/review` | `reviewing` | Pre-PR review of `git diff main...HEAD` — architecture, SOLID, merge-blockers. |
| `/doc-sync` | `doc-writer` | Sync stale docs with code (checks README/SPEC/DESIGN/ADR/AGENTS against recent history). |
| `/commit-all` | `build` | Groups pending changes into atomic **Conventional Commits** (`feat/fix/refactor/chore/docs/test/perf/ci/style/build(scope):`), orders commits dependencies→domain→infra→UI, bans force-push/amend/empty/`misc` commits, then shows `git log --oneline -10`. |

## 3. Which model runs what

The `--thinker` / `--executor` split is enforced in `src/engine/phases.ts` +
`src/engine/cycle.ts`:

| Work | Model | How |
|---|---|---|
| `SPEC_AUDIT` (spec-auditor invocation) | **executor** | `prompt({ agent: "spec-auditor", model: executor })` — unless the repo has no implementation code yet, in which case the audit is **skipped** (`hasImplementationCode`, `src/engine/diff.ts`) and the agent is never invoked |
| `EXECUTE` (build agent) | **executor** | `prompt({ agent: "build", model: executor })` |
| All 6 slash commands | **executor** | `runCommand({ command, arguments, model: "provider/model" (executor) })` |
| Judge pass for TEST_MODULE / SECURE_CHECK / REVIEW | **executor** | `judgePhase(client, session, executor, ...)` |
| `FIX_SPEC` / `FIX_VALIDATE` / `FIX_TEST` / `FIX_SECURITY` / `FIX_REVIEW` | **thinker** | `fixSpec` / `fixFindings` / `fixSecurity` → `prompt({ agent: "build", model: thinker })` |
| `huginn plan` drafts (spec → adr → plan) | **thinker** | `prompt({ model: thinker })`, 20-min timeout each |

Subagent delegation *inside* a command (e.g. `/validate-step`'s chain) is
handled by opencode via the Task tool with the orchestrating agent's
permissions — the harness only chooses the top-level command's model.

## 4. Delegation note (must stay true in the templates)

`/validate-step` works only because the `reviewing` agent may delegate via the
Task tool to `qa`, `spec-auditor`, and `security` — its frontmatter allows
exactly those three and denies all other Task targets. If you edit
`templates/agents/reviewing.md`, keep the `task:` allowlist intact; `huginn run`
does **not** verify this at runtime, so a broken allowlist surfaces as a
fail-closed `🛑 BLOCKED` at the `VALIDATE_STEP` gate.

## 5. Runtime requirements

1. **Bun** (the bin is `#!/usr/bin/env bun`; bundle is Bun-target).
2. **opencode CLI** on `$PATH` with authenticated providers, started by huginn
   itself via `opencode serve --port <n> --hostname 127.0.0.1` in the project
   dir (logs to `.harness/logs/server.log`).
3. **git repo** — required for `run` (module inference, base commits, agent
   context). Plan/spec/adr files must exist.
4. **Templates installed** — `huginn install` (or the `bun install`
   postinstall). Missing pieces only produce a warning at `run`/`plan`, but the
   corresponding gates will fail closed without them.

## 6. Developer workflow (working on huginn itself)

```sh
bun install            # runs scripts/postinstall.ts — prompts to install
                       # templates interactively, silent if all present,
                       # prints "huginn install --yes" hint when unattended
bun link               # exposes the global `huginn` bin → dist/cli.js
bun test               # unit tests: cli, gate, decisionBroker, plan parser,
                       # state store, installer, client timeouts, diff
                       # (greenfield detection), cycle (run-loop regression:
                       # abort interruption, empty EXECUTE fail-closed)
bun run typecheck      # tsc --noEmit (strict)
bun run dev -- ...     # run from source, e.g.
                       #   bun run dev -- run --project ../repo --thinker a/b --executor c/d
bun run build          # bun build src/cli.ts --target=bun --outdir=dist --minify
```

### Env overrides (all optional)

| Variable | Effect |
|---|---|
| `HUGINN_TEMPLATES_DIR` | Where `templates/` is read from (default: auto-detected by walking up from the module location — works from `src/`, `dist/`, `scripts/`). |
| `HUGINN_OPENCODE_CONFIG_DIR` | Install destination (default `~/.config/opencode`). The installer tests use this to isolate a temp config dir. |
| `HUGINN_DEBUG` | Print full error stack traces on fatal errors (`src/cli.ts`). |
| `CI` | `huginn install` skips its prompt (`--yes` implied); `promptYesNo` returns the fallback. |

### Testing the templates

- `src/setup/install.test.ts` asserts the exact 11-piece inventory
  (5 agents + 6 commands), idempotency, no-overwrite-without-`--force`, and
  `--only` filtering — keep `REQUIRED_TEMPLATES` and the `templates/` tree in
  sync or these fail.
- The verdict-marker contract between templates and parsers is covered on the
  parser side in `src/engine/gate.test.ts` (markers, secondary lines, and the
  null/fail-closed case). If you change a template's marker wording, update the
  corresponding parser and its tests in the same change.

## 7. Manual invocation examples (in an opencode session)

```
/validate-step src/contexts/notifications SPECS.md
/test-module src/features/auth
/secure-check
/review
/doc-sync
/commit-all
spec-auditor: audit src/ against SPEC.md
qa: AUDIT-ONLY MODE — run tests and report coverage for src/features/auth
security: audit the current diff for hardcoded secrets
doc-writer: update the docs that are stale
reviewing: review src/ for architecture violations
```
