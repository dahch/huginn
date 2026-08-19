# Huginn

[![npm](https://img.shields.io/npm/v/%40dahch%2Fhuginn)](https://www.npmjs.com/package/@dahch/huginn) [![license](https://img.shields.io/github/license/dahch/huginn)](https://github.com/dahch/huginn/blob/main/LICENSE) [![ci](https://img.shields.io/github/actions/workflow/status/dahch/huginn/publish.yml)](https://github.com/dahch/huginn/actions) [![stars](https://img.shields.io/github/stars/dahch/huginn)](https://github.com/dahch/huginn/stargazers) [![issues](https://img.shields.io/github/issues/dahch/huginn)](https://github.com/dahch/huginn/issues) [![bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/stack-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

CLI/TUI orchestrator for the opencode-based build cycle:

> **spec-auditor → execute → validate-step → test-module → secure-check → review → doc-sync → commit-all**

It drives your existing opencode subagents and slash commands headlessly (or from a live dashboard),
saves full execution state so any run can be resumed after an interruption, and routes fixes to a
"thinker" model while everything else runs on an "executor" model. It can also draft the initial
`spec.md`, `adr.md` and `plan.md` from a single idea using the thinker model — either in one shot
(`huginn plan`) or interactively, by chatting with the thinker to refine the idea before drafting
and then executing the resulting plan in the same session (`huginn live`).

## Requirements

- [Bun](https://bun.sh) >= 1.0 (runtime)
- [opencode](https://opencode.ai) CLI on `$PATH` with authenticated providers
- The opencode agents/commands that huginn drives — these are **installed by huginn
  itself** (see below), not something you set up by hand.

> Note: the `reviewing` agent must be able to delegate via the Task tool to `qa`, `spec-auditor`
> and `security` for `/validate-step` to work. The bundled templates already allow those
> three (see `templates/agents/reviewing.md`).

## Install

```sh
npm install -g @dahch/huginn        # npm
# or
bun install -g @dahch/huginn        # bun
```

For development, from the repo:

```sh
bun install
bun link          # exposes the `huginn` bin globally
```

The first `bun install` asks whether you want to install the opencode subagents and slash
commands huginn needs (and stays silent if they are already present). That installs these
into `~/.config/opencode/`:

- **agents** (subagents): `spec-auditor`, `qa`, `security`, `doc-writer`, `reviewing`
- **commands** (slash commands): `/validate-step`, `/test-module`, `/secure-check`, `/review`, `/doc-sync`, `/commit-all`

You can also install (or re-install) them at any time:

```sh
huginn install              # show what's missing, ask for confirmation
huginn install --yes        # install without asking (CI / scripts)
huginn install --force      # overwrite existing files (default: never overwrites)
huginn install --only agents | --only commands
```

Existing files are never overwritten unless you pass `--force`, so personalized agents/commands
are left alone. If a required piece is still missing when you `huginn run`/`huginn plan`, huginn
warns you and points at `huginn install`.

## Usage

```sh
huginn run \
  --project /path/to/repo \
  --thinker anthropic/claude-opus-4-5 \
  --executor opencode/gpt-5.1-codex
```

Run `huginn help` (or `huginn -h`) for all flags — note a bare `--help` is parsed
as a run-mode flag and falls through to argument validation (it prints usage, but
exits 1); `huginn help` exits 0:

| Flag | Default | Meaning |
|------|---------|---------|
| `--project <path>` | required | git repo being built (must contain `plan.md`, `spec.md`, `adr.md`) |
| `--thinker <m>` | required | model used to **fix** findings (auditor + reviewer + any blocker) |
| `--executor <m>` | required | model used for everything else (execution, gates, docs, commits) |
| `--plan / --spec / --adr <file>` | `plan.md`/`spec.md`/`adr.md` | input documents |
| `--mode auto\|supervised` | `auto` | `auto`: autonomous with a fix-retry budget, escalating to you only when it is exhausted; `supervised`: pause for your call at every blocked gate |
| `--permissions auto\|ask\|deny` | `auto` | auto-approve tool permission requests |
| `--max-retries <n>` | `3` | thinker fix attempts per blocked gate before escalating to you |
| `--from-iteration <n>` | — | start at iteration n |
| `--only-phase <name>` | — | run a single phase per iteration (debugging) |
| `--resume` | — | resume from saved state; fails if no saved state exists (plain re-runs auto-resume anyway) |
| `--force-restart` | — | discard saved state and start over |
| `--ignore-plan-changes` | — | resume even if plan/spec/adr changed |
| `--tui \| --headless` | auto | interactive dashboard vs stdout logs |
| `--port <n>` | free port | port for the internal `opencode serve` |
| `--server-timeout <ms>` | `60000` | server startup timeout |
| `--phase-timeout <ms>` | `1200000` (20 min) | hard deadline per phase step; on expiry the step is interrupted, retried up to `--max-retries`, then escalated. `0` disables |

## Plan mode (`huginn plan`)

Generate the three input documents from a single idea using the thinker model:

```sh
huginn plan \
  --project /path/to/repo \
  --thinker anthropic/claude-opus-4-5 \
  "A CLI that tracks podcast subscriptions and notifies me of new episodes"
```

For long prompts, use `--prompt-file <file>` instead of a positional argument.

What happens:

1. An opencode session is created and the thinker drafts `spec.md` (functional/non-functional
   requirements, numbered and traceable).
2. The thinker drafts `adr.md` given the spec (architecture decisions with alternatives and tradeoffs).
3. The thinker drafts `plan.md` given the spec + ADR (iterations in the `## Iteration N — Title`
   format the harness understands).

Flags: `--spec/--adr/--plan <file>` to override output paths, `--force` to overwrite existing
documents (it refuses by default), `--port`/`--server-timeout` like `run`.

When done it prints the `huginn run ...` command to start the build cycle.

## Live mode (`huginn live`)

Interactive refinement + autonomous execution in one dashboard: chat with the thinker to refine
the idea (or extend an existing project), draft/update the documents, approve them, then run the
build cycle in the same session:

```sh
huginn live \
  --project /path/to/repo \
  --thinker anthropic/claude-opus-4-5 \
  --executor opencode/gpt-5.1-codex \
  "Add a podcast notification CLI to this project"   # optional initial idea
```

What happens (stages shown in the dashboard: refine → draft → approve → execute):

1. **Refine** — an opencode session is created and you chat with the thinker, which is grounded in
   the current repo state (git log/status, source tree) and any existing `spec.md`/`adr.md`/`plan.md`.
2. **Draft** — typing `/draft` makes the thinker emit a `SCOPE:` block (goals, non-goals,
   constraints); if it can't be parsed the run asks you to retry or fall back to your last message.
   The docs are then drafted with a **format contract** — spec.md (rewritten or created), adr.md
   (new entries *appended* to the existing file), plan.md (remaining iterations). A draft that
   violates the contract is retried once, then a human decision is requested (retry / accept
   as-is / abort).
3. **Approve** — the docs are staged as intent-to-add so `git diff HEAD -- spec.md adr.md plan.md`
   shows them for review; you choose re-draft, OK — commit & execute, or abort.
4. **Execute** — on approval the docs are committed (`docs(scope): …`) and a fresh
   [`huginn run`](#usage) cycle runs the plan in the same dashboard. When all iterations complete,
   the TUI presents an interactive modal allowing you to either exit (`[c]` / `[a]`) or return to
   Live mode (`[r]`) to continue refining and adding new tasks. Aborting before approval drops the
   intent-to-add staging so nothing review-only lingers in the index.

**Live TUI Features**:
- **Dual Cards**: parallel scrollable cards for **Refinement Conversation** and **Thinking Stream**.
- **Interactive Controls**: `[Tab]` toggles active card focus; `[PageUp]`/`[PageDown]` scrolls the focused history by 4 lines; `[↑]`/`[↓]` scrolls line-by-line.
- **Native Markdown Rendering**: bold, italic, inline code backticks, headers, quotes, bullet points, and code fences are styled natively in the terminal.
- **Immediate Abort**: `[Esc]` or typing `/quit` cancels execution immediately.

Flags: `--spec/--adr/--plan <file>` to override paths, `--prompt-file <file>` for long ideas,
plus the run-mode flags `--mode`, `--permissions`, `--max-retries`, `--port`,
`--server-timeout`, `--phase-timeout`, `--tui | --headless`. In headless mode the chat
refinement is skipped (the CLI idea is used as-is) and approvals are answered on stdin;
non-interactive stdin aborts with a hint to use the TUI.

## The cycle (per iteration of `plan.md`)

1. **SPEC_AUDIT** — invokes the `spec-auditor` subagent against `spec.md`. 🔴 deviations → fix with thinker, re-audit. On a repo with no implementation code yet (greenfield), the audit is skipped with a ⏭️ verdict until an iteration has produced code.
2. **EXECUTE** — sends the iteration's prompt verbatim to the `build` agent (executor).
3. **VALIDATE_STEP** — runs `/validate-step <modules> <spec.md>`; consumes its `✅/⚠️/🛑` verdict.
4. **TEST_MODULE** — runs `/test-module <modules>`; verdict via a small "judge" pass.
5. **SECURE_CHECK** — runs `/secure-check`; any breach → fix with thinker until clear.
6. **REVIEW** — runs `/review`; blockers → fix with thinker and re-review.
7. **DOC_SYNC** — runs `/doc-sync` (informative, never blocks).
8. **COMMIT_ALL** — runs `/commit-all` to produce semantic commits.

Blocked gates are fixed with the **thinker** model up to `--max-retries` times; if still blocked the
run pauses for your decision — retry (resets the fix budget), force-continue, or abort — via an
interactive prompt in the TUI or stdin in headless mode. In `supervised` mode every blocked gate
surfaces that decision; in `auto` mode the same decision is requested once the fix budget is exhausted.

Gates **fail closed**: a phase report with no parseable verdict marker (empty, truncated or
hallucinated output) is treated as BLOCKED and logged, never silently passed. Permission
auto-approvals (`--permissions auto`) are also logged to the run stream so every tool action is
auditable.

Modules for steps 3–4 come from the `modules:` line of the iteration heading, or are inferred
automatically from `git diff` since the iteration started.

## `plan.md` convention

```markdown
# Plan: my project

## Iteration 1 — Audio domain setup
modules: src/audio/

The literal prompt that will be sent to the executor in step 2.
All text up to the next `## Iteration N` heading is the prompt.

## Iteration 2 — Export pipeline integration
modules: src/audio/, src/export/
...
```

Headings use `## Iteration N` with `—`, `-` or `:` separators. Iterations run in numeric order (the
parser sorts by index). The optional `modules:` line right below the heading provides explicit paths
for `/validate-step` and `/test-module`; otherwise they are inferred from git.

## State & resumability (`.harness/`)

The `run` cycle never edits `plan.md`/`spec.md`/`adr.md` (only `plan` mode writes them at creation
time, and `live` mode writes/commits them after explicit human approval). Everything the harness
needs is written under `<project>/.harness/`:

- `state.json` — machine-readable source of truth (current iteration/phase, history, sessions).
- `PROGRESS.md` — human-readable checklist regenerated after every phase.
- `reports/` — full raw report of each phase attempt (`01-SPEC_AUDIT-1.md`).
- `logs/server.log` — the internal `opencode serve` output.

If a run is interrupted, just re-run the same command and it auto-resumes from the exact phase.
`--force-restart` wipes saved state; `--ignore-plan-changes` resumes even after editing the docs.

## Environment variables

All optional:

| Variable | Type | Default | Effect |
|---|---|---|---|
| `HUGINN_TEMPLATES_DIR` | path | auto-detected (walk up from module location) | Where `templates/` is read from — works from `src/`, `dist/`, `scripts/`. |
| `HUGINN_OPENCODE_CONFIG_DIR` | path | `~/.config/opencode` | Install destination for agents/commands; also where the update-check cache lives. |
| `HUGINN_NO_UPDATE_CHECK` | string | unset | Any non-empty value disables the background npm version check. |
| `HUGINN_DEBUG` | string | unset | Print full error stack traces on fatal errors. |
| `CI` | string | unset | `huginn install` skips its confirmation prompt (`--yes` implied). |

### Background update check

Every `huginn run` / `plan` / `live` fires a **non-blocking** check against the npm registry
(`https://registry.npmjs.org/@dahch/huginn/latest`, 3 s fetch timeout). It never delays or fails
the run: the result is only a yellow `⬆ A new version of huginn is available: vX → vY` reminder on
stderr with the update command. Results are cached in
`<opencode-config-dir>/huginn-update-cache.json` for 24 hours, and a stale cache is used as a
fallback when the registry is unreachable. Set `HUGINN_NO_UPDATE_CHECK=1` to disable.

## Development

```sh
bun test              # unit tests (parsers, gates, state, installer, run-loop regressions)
bun run typecheck     # tsc --noEmit
bun run dev -- ...    # run from source
bun run build         # bundle to dist/ for the global bin
```

## How the installer works

- `templates/agents/*.md` and `templates/commands/*.md` are the opencode definitions huginn
  ships with. They are copied into `~/.config/opencode/{agents,commands}/` (no overwrites
  without `--force`).
- The `postinstall` lifecycle hook runs on `bun install`, asks for confirmation (interactive
  terminal only), and prints a hint pointing at `huginn install --yes` when unattended.
- `huginn install` does the same on demand; `huginn run`/`huginn plan` warn if a required piece
  is still missing. Override paths with `HUGINN_TEMPLATES_DIR` (templates source) and
  `HUGINN_OPENCODE_CONFIG_DIR` (install destination).
