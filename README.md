# Huginn

[![npm](https://img.shields.io/npm/v/%40dahch%2Fhuginn)](https://www.npmjs.com/package/@dahch/huginn) [![license](https://img.shields.io/github/license/dahch/huginn)](https://github.com/dahch/huginn/blob/main/LICENSE) [![ci](https://img.shields.io/github/actions/workflow/status/dahch/huginn/publish.yml)](https://github.com/dahch/huginn/actions) [![stars](https://img.shields.io/github/stars/dahch/huginn)](https://github.com/dahch/huginn/stargazers) [![issues](https://img.shields.io/github/issues/dahch/huginn)](https://github.com/dahch/huginn/issues) [![bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh) [![TypeScript](https://img.shields.io/badge/stack-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

CLI/TUI orchestrator for the agent-driven build cycle:

> **spec-audit → execute → validate-step → test-module → secure-check → review → doc-sync → commit-all**

Huginn **owns the cycle**: it composes every step's instruction itself (`src/engine/steps/`) and sends
it to whichever agent runtime you configured (opencode, Claude Code, Codex, …) as a plain prompt, so a
single-file install behaves exactly like a source checkout and there are no subagents or slash
commands to install. It saves full execution state so any run can be resumed after an interruption,
and routes fixes to a "thinker" model while everything else runs on an "executor" model. It can also
draft the initial `spec.md`, `adr.md` and `plan.md` from a single idea using the thinker model —
either in one shot (`huginn plan`) or interactively, by chatting with the thinker to refine the idea
before drafting and then executing the resulting plan in the same session (`huginn live`). A project
does not even have to be a git repository yet: `run`/`plan`/`live` bootstrap one (`git init -b main`,
a default `.gitignore` and a bootstrap commit) unless `--no-git-init` asks them to fail instead.

## Requirements

- [Bun](https://bun.sh) >= 1.0 (runtime)
- An AI coding agent CLI on `$PATH` (any of the 13 registered targets below; `opencode` is the only
  one with a native permission subscriber and server-side session history):
  - [opencode](https://opencode.ai) CLI (default runtime)
  - [Claude Code](https://claude.ai/code) (`claude`)
  - [OpenAI Codex](https://github.com/openai/codex) (`codex`)
  - [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`)
  - [Command Code](https://github.com/command-code) (`commandcode`)
  - [Qwen Code](https://github.com/QwenLM) (`qwen`)
  - Kimi Code CLI (`kimi`), Pi coding agent (`pi`), Devin (`devin`), Antigravity CLI (`agy`),
    MiniMax Code (`mcode`), MiMo Code (`mimo`) and Cursor (`cursor`)
  - Or any generic agent CLI conforming to stdio execution.
- `git` on `$PATH` (module inference, diffs, worktree sandboxing). A directory that is inside **no**
  work tree is initialized in place by `run`/`plan`/`live` unless `--no-git-init` is passed.

> Note: the instructions huginn drives are **built in** (`src/engine/steps/instructions.ts`) — there
> are no opencode subagents or slash commands to install, and `huginn install` is a compatibility
> no-op. The one agent huginn asks opencode for by name is the built-in `build` agent, used for
> `EXECUTE` and the `FIX_*` phases.

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

Nothing else has to be set up: every step instruction the cycle runs is embedded in the bundle
(`src/engine/steps/`), so a global install and a source checkout behave identically. `huginn install`
is kept as a documented no-op so existing scripts keep working:

```sh
huginn install      # → [huginn] agents and step prompts are built in; there is nothing to install.
```

## Usage

Running `huginn` with no subcommand opens the **live console** — the live-first default:

```sh
# Open the interactive live console in the current git repo
huginn

# ...or start it with an idea: refine, draft, approve, then build
huginn "create a payments module"

# Set up a brand-new repository: agent, models, Muninn MCP and .huginn/config.json
huginn init

# The examples below all remain available as explicit subcommands.
# Run the 8-phase spec-build cycle against an existing plan
huginn run \
  --project /path/to/repo \
  --thinker anthropic/claude-opus-4-5 \
  --executor opencode/gpt-5.1-codex

# Interactive refinement & execution in a live dashboard
huginn live \
  --project /path/to/repo \
  --thinker anthropic/claude-opus-4-5 \
  --executor opencode/gpt-5.1-codex \
  "Initial idea..."

# Resume a persisted live conversation (it survives restarts and handoffs)
huginn live --continue               # the project's latest live session
huginn live --session <id>           # a specific one
huginn live --list-sessions          # list them and exit 0

# Draft spec.md, adr.md, and plan.md from an idea
huginn plan \
  --project /path/to/repo \
  --thinker anthropic/claude-opus-4-5 \
  "Initial idea..."

# Register the Muninn MCP server + agent directives with your agents
huginn setup

# Diagnose the local environment, providers and Muninn database
huginn doctor

# Inspect the effective models, or persist thinker/executor for future runs
huginn config show
huginn config set --executor opencode/gpt-5.1-codex

# Search persistent memory across codebase
huginn memory search "database schema"

# Start the MCP stdio server for agent integration
huginn mcp run
```

The project defaults to the current working directory and the models are resolved from configuration
(see [Model and Agent configuration](#model-and-agent-configuration)) rather than requiring `--thinker`/`--executor`.

In a repository that has never run huginn (no `.huginn/` directory), a bare `huginn` opens the
**init wizard** instead of the live console — interactive onboarding on a TTY, a short pointer to
`huginn init` otherwise. Passing an idea, or a repository that already has `.huginn/`, keeps the
live-first default described above.

`huginn --help` (also `huginn help` or `huginn -h`) prints a concise, grouped overview: the Core
commands (`live`, `run`, `init`, `setup`, `doctor`), copy-pasteable examples and the flags you need
first. `huginn --help --all` (or `huginn help --all`) prints the full reference — every command, flag
and default — while `huginn init --help` prints the wizard's own usage.

### Commands

| Command | Usage | Description |
|---|---|---|
| *(none)* | `huginn ["<idea>"]` | **Live-first default**: open the live console (optionally seeded with an idea) |
| `run` | `huginn run [flags]` | Execute the build cycle against `plan.md`/`spec.md`/`adr.md` |
| `live` | `huginn live [flags] ["<idea>"]` | Interactive chat refinement with thinker model, drafting, approval, and execution (`--continue`/`-c`, `--session <id>`, `--list-sessions`/`-sl` resume or list persisted sessions) |
| `plan` | `huginn plan [flags] "<idea>"` | Generate `spec.md`, `adr.md`, and `plan.md` in one shot using thinker model |
| `init` | `huginn init [--yes] [--skip-setup] [flags]` | Guided onboarding: detect git/package manager/agent CLIs, pick agent + models (from the runtime's own catalog when it lists one), register Muninn MCP, write `.huginn/config.json` |
| `setup` | `huginn setup [--agent <t1,t2\|all>] [--installed] [--status] [--dry-run] [flags]` | Register the Muninn MCP server + agent directives across supported agents (or inspect the provisioning matrix) |
| `doctor` | `huginn doctor [flags]` | Diagnose the environment, providers and Muninn database |
| `config` | `huginn config show\|set [flags]` | Inspect the effective models, or persist `thinker`/`executor` to project or user config |
| `check` | `huginn check [files...] [flags]` | Verify TypeScript compiler execution contracts with visual diagnostic snippets |
| `install` | `huginn install` | Compatibility no-op: the step prompts are built into huginn |
| `memory` | `huginn memory <subcmd> [flags]` | Manage persistent codebase memory (`init`, `search`, `sync`, `index`) |
| `mcp` | `huginn mcp run [flags]` | Start the Model Context Protocol stdio server for agent integration |

`huginn setup` targets: `cursor`, `claude`, `opencode`, `devin`, `qwen`, `codex`, `agy`,
`kimi`, `pi`, `commandcode`, `omp`, `mcode`, `mimo`, or `all` (default). `--status` prints the provisioning matrix
(agent × installed × muninn registered) with the exact fix command and writes nothing; `--installed`
**filters** the selection to the agents whose CLI is present (never widening it) and reports what it
skipped; `--agent a,b` configures exactly that subset. `--dry-run` reports exactly what would change
and writes **nothing** — a preview never mutates a third-party config. `--list` prints the registry
without writing anything; `--force` overwrites a conflicting existing `muninn` entry (otherwise it is
left untouched and reported as skipped). Paths are overridable via `HUGINN_AGENT_<ID>_MCP_PATH` (colon-separated)
and `HUGINN_AGENT_RULES_PATH` / `HUGINN_AGENT_<ID>_RULES_PATH`.

`huginn doctor` exits `0` only when its **critical** checks pass (git repository, a runtime, and the
Muninn database); the `git` binary, Node, `opencode` CLI and missing agent integrations are warnings.
Its `integrations` check renders the same Muninn provisioning matrix as `huginn setup --status` — agent
× installed × registered — with the exact `huginn setup --agent <id>` fix for every installed gap.

`huginn init` runs six non-blocking steps: git detection via `git rev-parse --is-inside-work-tree`
(so a subdirectory, a linked worktree or a symlinked checkout counts; otherwise it prints a `git init`
tip), package-manager detection from the lockfile (`bun`/`pnpm`/`yarn`/`npm`, else `unknown`), a `PATH`
scan of the agent CLIs (`opencode`, `claude`, `codex`, `omp` first, then the rest), the agent prompt
followed by a **model picker fed by the chosen runtime's own catalog** (`getModelCatalog()`; a runtime
that cannot list models falls back to plain text entry and prints the sanitized `reason`),
`huginn setup` for the chosen agent, and finally `<project>/.huginn/config.json`. With `--yes`, in CI
or without a TTY it never prompts: the flags and the documented model defaults
(`DEFAULT_THINKER_MODEL`/`DEFAULT_EXECUTOR_MODEL`) are used instead.
`--agent`, `--thinker` and `--executor` pre-select values, `--skip-setup` skips the MCP registration,
`--force` overwrites conflicting MCP entries, and `--project`/`--home`/`--opencode-config-dir`
override the detected locations.

### Run Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--project <path>` | `cwd` | project being built — any directory inside a git work tree; a directory outside one is bootstrapped. `run` requires `plan.md`, `spec.md`, `adr.md` |
| `--agent <id>` | resolved from config | AI agent runtime (`opencode`, `claude`, `codex`, `omp`, `commandcode`, `qwen`, `kimi`, `pi`, `cursor`, `devin`, `agy`, `mcode`, `mimo`) |
| `--thinker <m>` | resolved from config (see [Model and Agent configuration](#model-and-agent-configuration)) | model used to **fix** findings (auditor + reviewer + any blocker) |
| `--executor <m>` | resolved from config | model used for everything else (execution, gates, docs, commits) |
| `--plan / --spec / --adr <file>` | `plan.md`/`spec.md`/`adr.md` | input documents |
| `--mode auto\|supervised` | `auto` | `auto`: autonomous with a fix-retry budget, escalating to you only when it is exhausted; `supervised`: pause for your call at every blocked gate |
| `--profile <id>` | `huginn` | Methodology profile: `huginn` (the **Huginn Cycle**, below) · `sdd` · `odd` · `rdd` · `strict-tdd` (see [Methodology profiles](#methodology-profiles)) |
| `--permissions auto\|ask\|deny` | `auto` | permission policy. Only opencode can honour `ask`/`deny` (through its event subscriber); a **subprocess** runtime (`claude`, `codex`, …) fails closed with exit 1 on `ask`/`deny`, and an invalid value exits 1 |
| `--max-retries <n>` | `3` | thinker fix attempts per blocked gate before escalating to you |
| `--from-iteration <n>` | — | start at iteration n |
| `--only-phase <name>` | — | run a single phase per iteration (debugging) |
| `--sandbox` / `--no-sandbox` | `--sandbox` | run each iteration in an isolated git worktree under `.huginn/worktrees/` (see [Sandboxing](#sandboxing-git-worktrees)); `--no-sandbox` runs iterations in place |
| `--resume` | — | resume from saved state; fails if no saved state exists (plain re-runs auto-resume anyway) |
| `--force-restart` | — | discard saved state and start over |
| `--ignore-plan-changes` | — | resume even if plan/spec/adr changed |
| `--continue`, `-c` | — | (live) resume the project's most recently updated live session |
| `--session <id>` | — | (live) resume the persisted live session with this id |
| `--list-sessions`, `-sl` | — | (live) print the persisted live sessions and exit 0 |
| `--no-git-init` | — | fail instead of initializing a missing git repository |
| `--tui \| --headless` | auto | interactive dashboard vs stdout logs |
| `--port <n>` | free port | port for the internal `opencode serve` |
| `--server-timeout <ms>` | `60000` | server startup timeout |
| `--phase-timeout <ms>` | `1200000` (20 min) | hard deadline per phase step; on expiry the step is interrupted, retried up to `--max-retries`, then escalated. `0` disables |
| `--choose-model` | `false` | open the interactive model & provider selector on startup |

## Model and Agent configuration

`run` and `live` do not require `--thinker`/`--executor` or `--agent`. Settings are resolved in strict
precedence order, first non-empty value wins:

### Agent Resolution Precedence

1. CLI flag — `--agent <id>`
2. project config — `<project>/.huginn/config.json` (`agent` key)
3. user config — `~/.huginn/config.json` (`agent` key)
4. environment — `HUGINN_AGENT`
5. PATH auto-detection — first detected installed binary, scanning the registry order (`cursor`, `claude`, `opencode`, `devin`, `qwen`, `codex`, `agy`, `kimi`, `pi`, `commandcode`, `omp`, `mcode`, `mimo`)
6. fallback — `opencode`

### Model Resolution Precedence

1. CLI flag — `--thinker <m>` / `--executor <m>`
2. project config — `<project>/.huginn/config.json`
3. user config — `~/.huginn/config.json`
4. environment — `HUGINN_THINKER_MODEL` / `HUGINN_EXECUTOR_MODEL`
5. defaults — thinker `anthropic/claude-opus-4-5`, executor `opencode/gpt-5.1-codex`

The project config file is a JSON object with documented keys:

```json
{
  "agent": "claude",
  "thinker": "anthropic/claude-opus-4-5",
  "executor": "opencode/gpt-5.1-codex",
  "mode": "auto",
  "profile": "huginn"
}
```

- `agent` must be one of the registered agent targets (`opencode`, `claude`, `codex`, `omp`, `commandcode`, `qwen`, `kimi`, `pi`, `cursor`, `devin`, `agy`, `mcode`, `mimo`).
- `thinker` / `executor` are model strings (`provider/model`); `mode` is `auto` or `supervised`.
- `profile` is `huginn` (default), `sdd`, `odd`, `rdd` or `strict-tdd`; an unrecognised value is dropped with a warning rather than failing the run.
- A persisted `agent` naming a **removed** target (`gemini`, superseded by `agy`; `windsurf`, renamed to `devin`) is not fatal: it warns and falls back to PATH detection.
- Unknown keys are preserved verbatim, so third-party tooling can keep its own settings alongside.
- The project file overrides the user file key-by-key; a missing file is treated as empty and a
  malformed one is ignored with a warning (never fatal), falling back to the next layer.
- Writes are atomic and symlink-hardened (`.huginn/` is created `0o700`, the config `0o600`).

The `huginn config` command is the CLI surface for this layer:

```sh
# Effective thinker/executor + which layer each came from
huginn config show [--project <path>] [--home <path>]

# Persist to <project>/.huginn/config.json, or ~/.huginn/config.json with --global
huginn config set [--thinker <m>] [--executor <m>] [--profile <id>] [--global] [--project <path>] [--home <path>]
```

`set` requires at least one of `--thinker`/`--executor`/`--profile`; `--project`/`--home` override the paths
(used by tests). `show` also prints the effective methodology profile and its display name.

## Sandboxing (git worktrees)

By default (`--sandbox`), each iteration runs in an isolated git worktree so your editor stays on
the primary branch while the agent works:

- The worktree lives at `<project>/.huginn/worktrees/task-iter-<N>` on an ephemeral branch
  `huginn/task-iter-<N>`; `node_modules` and `.env` are symlinked in from the project root.
- Every agent phase runs against the sandbox: the iteration session is created with, and every
  `prompt`/slash-command carries, the opencode SDK `directory` query parameter set to the worktree
  path, so the agent's own tools edit the sandbox rather than your primary tree. Harness-side work
  (module inference, compiler contracts, git diff) reads the same path; **Muninn indexing is the
  exception** — it scans the worktree but persists symbols to the primary project's
  `.huginn/muninn.db`, so long-term memory survives the sandbox (ADR-20).
- On iteration success the sandbox commits are integrated into your active branch
  (`git merge --ff-only`, falling back to `git cherry-pick`) and the worktree + branch are removed.
- On abort or a phase error the sandbox is discarded and your working tree is never touched.
- If promotion conflicts, the primary tree is restored, the `huginn/task-iter-<N>` branch is **kept**
  so the work is recoverable by hand, and the run **fails closed** (the iteration is not marked
  complete) instead of reporting success.
- If the repository has no `HEAD` commit yet, sandboxing is skipped for that run with a warning and
  the iterations run in place — a worktree cannot be created from an empty repository.
- `--no-sandbox` runs iterations in place, exactly as before.

Stale worktrees **and** any orphaned `huginn/task-iter-*` branches from a crashed run are reclaimed
at the start of the next run, and `SIGINT`/`SIGTERM` trigger a best-effort cleanup.

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
   intent-to-add staging so nothing review-only lingers in the index. The conversation itself is
   **rehydrated** from the engine after the cycle instead of starting blank.

The refinement conversation is **persisted** in `<project>/.huginn/live/sessions.json` (atomic writes,
mode `0o600`, capped messages/sessions/bytes, symlink-contained) and is deliberately *not* deleted on
handoff, so a session survives a restart or a cycle: `huginn live --continue` (or `-c`) resumes the
project's latest session, `huginn live --session <id>` a specific one, and
`huginn live --list-sessions` prints them and exits 0. Resuming **reattaches** to the same
server-side opencode session when it is still alive; for a runtime that keeps no history each turn
carries a bounded, sanitized transcript (12 turns / 12 000 characters, delimited as untrusted data), so
a one-shot CLI still sees the conversation. `.huginn/.gitignore` (holding `*`) keeps that state out of
the working tree.

**Live & Dashboard TUI Features**:
- **Raven Brand Header (`RavenHeader`)**: Both dashboards render one shared ASCII **raven mark + `HUGINN` wordmark** (from `src/brand.ts`), so the TUI reads as Huginn the raven instead of an eagle emoji. The mark degrades to wordmark-only below 72 columns, to plain `HUGINN` text when even that does not fit or the terminal is too short, and the header also carries the live stage, the MCP badge, the active runtime, the project path and the active models.
- **Fullscreen Alternate Screen Buffer**: Operates in an isolated alternate screen buffer (`\x1b[?1049h\x1b[H`) with multi-layered exit handlers (`SIGINT`, `SIGTERM`, unhandled exceptions, and `process.on("exit")`), guaranteeing clean restoration of your shell history and visible cursor.
- **Responsive Viewport Scaling**: Dynamically measures rows and columns via `useTerminalSize()` and auto-adapts layout cards to fill 100% of the screen upon terminal resizing without line truncation.
- **Console Log Drawer (Zero Stdout Pollution)**: Background server logs, provider warnings, and runtime notices are intercepted via `patchConsole()` and routed into an in-app log drawer (`LogsCard`) rather than dumping to stdout and tearing the alternate screen.
- **Stream Batching & Scroll Containment**: Real-time agent streaming (`phaseStream`) is throttled to 60ms flushes and capped with a 1,000-line ring buffer to prevent Ink rerender lag. Mouse and keyboard scrolling are trapped within the active card (`[PageUp]`/`[PageDown]` for 4 lines, `[↑]`/`[↓]` line-by-line) without leaking into the terminal scrollback history.
- **Dual Focusable Cards & Markdown Rendering**: Parallel scrollable cards for conversation and live agent output with syntax-highlighted code fences, bold, italic, and headers. `[Tab]` switches card focus; `[Space]` pauses/resumes runs; `[v]` toggles verbose mode; `[Esc]` aborts immediately, while `/quit` (alias `/abort`) aborts after a two-step confirmation.
- **Composer with a Cursor, Multiline Growth & Input History**: the message row is the anchor of the view — its own accent border and a `❯` prompt glyph. It is a real editor: `←`/`→` move the caret (with `⌥`/`Ctrl` for whole words), `Home`/`End` jump to the ends of the caret's visual row, `Backspace`/`Delete` act at the caret (again word-wise with `⌥`/`Ctrl`), and typed text is inserted at the caret. A draft that wraps grows up to **6 rows** and then scrolls internally, and the caret is always drawn inside the frame (it never pushes a column off the row). `↑` recalls the previous submission of the session (the last 50), `↓` walks forward and ends at the empty draft. Recalled drafts stay editable and slash-command submissions are never stored. Recall applies only while the command palette is closed and the draft is empty, so it never fights the palette's own `↑`/`↓`.
- **Terminal Theme System (`src/tui/theme.ts`)**: components ask for a semantic token (`THEME.text`, `THEME.muted`, `THEME.danger`, …) instead of hard-coding colours — the old `color="white"` chat body is gone, so nothing is invisible on a white terminal. Modes are `light`, `dark` and `auto` (default), pinned with `HUGINN_THEME`; `auto` stays background-agnostic (and sniffs `COLORFGBG` when the terminal advertises it), and a non-empty `NO_COLOR` disables every token and `dimColor`.
- **Live Context Panel & Empty-State Hero (`InfoPanel` / `LiveHero`)**: on wide terminals (≥100 columns, with a minimum spare column/row budget) a compact **LIVE CONTEXT** panel sits beside the conversation with the stage, agent and models, the per-agent MCP enumeration, the git branch and tree state, the worktree sandbox, Muninn's counts and the size of the conversation, plus a stage-appropriate tip; below that width it is not rendered at all and the header alone carries the facts, so it can never push the composer or footer off the frame. An empty conversation renders a raven-branded hero with the first-run guidance instead of a blank card, sliced to the card's real rows.
- **Honest Panels**: the old `REFINEMENT CONVERSATION` card is simply **`Conversation`**, and the agent-output (stream) panel **collapses automatically** while the agent has emitted no reasoning/stream content for the session — its rows return to the conversation and it is never shown as an empty bordered box; it expands on the first content.
- **Selectable Runtime Picker (`AgentPickerModal`)**: bare `/agent` opens a modal over every registered target, each with an availability marker (`✔` / `— not installed`), the active runtime marked, and the highlighted entry's resolved binary path. `↑`/`↓` (or `j`/`k`) navigate, `Enter` switches, `Esc` cancels; a failed switch keeps the picker open so another runtime can be chosen immediately. `/agent <id>` still works for power users.
- **Agent-Agnostic Questions**: any runtime can ask you a clarifying question through a marked output block; the decision modal renders the real option rows — a digit picks that option verbatim, `Enter` accepts the recommended one, `d` skips and `Esc` aborts (see [Clarifying questions](#clarifying-questions-agent-agnostic)).
- **Interactive Model & Provider Selector (`ModelPickerModal`)**:
  - Launch with `--choose-model` flag: `huginn --choose-model` or `huginn live --choose-model`.
  - In-session slash commands:
    - `/models` or bare `/model`: opens the interactive 3-step modal selector directly over the dashboard without interrupting chat context.
    - `/model <thinker> [executor]`: instantly changes the active models inline for the session (e.g. `/model anthropic/claude-3-7-sonnet opencode/gpt-5.1-codex`).
  - **3-Step Selector Modal**:
    1. **Step 1: Choose Thinker**: queries the active runtime's own catalog (`runtime.getModelCatalog()`), showing provider badges (`[Anthropic]`, `[OpenAI]`, `[Google]`, etc.), model names, and IDs with live search filtering. Only models the runtime can actually run are offered — OpenCode offers the models of its **connected** providers only (falling back to the `opencode models` CLI), Command Code, `omp` and `agy` parse their own CLI listings, and a runtime with no listing mechanism reports an honest empty catalog with the reason instead of a fabricated one. The loading, discovery-error and "no models discovered" states are distinct, and the empty state accepts a free-text id — there is no fallback model list.
    2. **Step 2: Choose Executor**: selects the coding/execution model with the same interactive filter.
    3. **Step 3: Save Preferences**: choose multi-scope persistence:
       - `[1] Project Default`: writes atomically to `<project>/.huginn/config.json`.
       - `[2] Global Default`: writes atomically to `~/.huginn/config.json`.
       - `[3] Session Only`: updates in-memory active models for the current session without writing to disk.
  - **Native Model Forwarding**: the chosen model is passed to the runtime through the flag it documents (`--model`/`-m`, or the OpenCode SDK model ref), so selecting a model actually takes effect; `HUGINN_MODEL` is kept only as an extra environment hint for wrapper scripts.
  - **Auto-Onboarding Preflight Check**: if thinker or executor came from the documented defaults and the runtime's catalog is non-empty while containing **neither** default, Huginn automatically opens the model selector on startup.
- **Live MCP Monitor & Server Inspector (`McpInspectorModal`)**:
  - **Live Header Status Badge**: real-time indicator with 15-second polls over a bounded 12 s budget. MCP is **per-agent** — Huginn holds no client, the active agent owns every connection — so the badge is always self-describing and **attributes the agent it describes**, never rendering a bare or unexplained number: `MCP: 🟢 3 connected · opencode` for servers a real probe reported reachable, `MCP: ⚪ 5 configured · agy` for servers the agent's own CLI enumerated as configured-but-unprobed, `MCP: ⚪ none · omp` when nothing is registered, and `MCP: 🟡 error — <reason> · <agent>` / `MCP: 🟡 timeout · <agent>` on failure. Every numeric field is nullish-coalesced, so `undefined`/`NaN` can no longer reach the screen.
  - **Render Loop Protection**: `fetchMcpStatusWithTimeout` enforces a strict `Promise.race` deadline (with `.unref()`'d timers) so an unresponsive MCP server never blocks the Ink render loop; a completed listing is cached for 60 s per runtime and one spawn is shared across polls, so a slow CLI (`claude mcp list` health-checks every server, ~23 s measured) is fetched once and reused instead of being killed and retried forever.
  - **Interactive Inspector (`/mcp`)**: Type `/mcp` in the live chat input to open an interactive two-pane inspector modal:
    - *Left Pane (Servers)*: lists each server as `name · transport · status · detail` — `[connected]` only after a real probe, `[unknown]` for a server the agent's CLI reports as merely configured (`enabled`/`disabled`/`pending`), plus whatever detail the CLI exposed (command, scope, auth); the header summarizes `n/total active` or `n/total unverified` instead of counting unprobed servers as live.
    - *Attribution & Muninn*: the header names the source runtime (*"Servers come from **&lt;agent&gt;** — add or change them with the agent's own config or CLI; Huginn only observes them"*) and states whether Muninn is registered for that agent (`✓ Muninn (the memory brain) is registered for <agent> … one project-scoped brain, shared by every agent`), or, when it is missing, the exact fix command `huginn setup --agent <id>`.
    - *Right Pane (Tools)*: Inspects exposed tools for the selected server with descriptions and paginated windowing (10 visible tools with scroll overflow indicators).
    - *Navigation*: `[↑]`/`[↓]` or `[k]`/`[j]` to navigate, `[Tab]` or `[Enter]` to switch focus between servers and tools panes, `[Esc]` to return to chat.
    - *Terminal Injection Defense*: All server names, tool descriptions, and error strings are sanitized via `sanitizeTerminalText` (shared module `src/util/text.ts`) to strip ANSI escape sequences, C0 and C1 non-printable control characters.
- **Inline Command Palette**: typing `/` in an empty-or-partial input opens an autocomplete overlay directly beneath the input row — `↑`/`↓` (or `j`/`k` while the draft is exactly `/`) move the highlight, `Tab` accepts the highlighted command, `Enter` runs it, and `Esc` dismisses the overlay without aborting the session. Further typing filters by id/alias substring; accepting a command that takes arguments inserts its argument hint. These bindings take precedence over focus/scroll only while the overlay is open, and the palette is height-bounded (≤6 rows with `▲`/`▼` markers, shrinking on short terminals) so it can never push the frame off-screen.
- **Rich Live Slash Commands**: a single command registry (`src/tui/commandRegistry.ts`) is the source of truth for dispatch, the palette and the `/help` cheat sheet (a drift-guard test keeps them in sync), so the UI can never advertise a command the dispatcher does not implement. The Live input bar intercepts any `/<…>` input before model dispatch, so typos are reported (``Unknown command "<cmd>" — type /help for the command reference.``) instead of being sent to the model as chat text. Available commands:
  - `/help`: opens the **cheat-sheet modal** (`HelpModal`) with every command, the navigation shortcuts, and the active agent/thinker/executor/project banner.
  - `/agent`: opens the interactive **runtime picker** (`AgentPickerModal`) described above. `/agent <id>` hot-switches the runtime in-session (fails closed if the target binary is unavailable).
  - `/models` or `/model`: opens the interactive model picker; `/model <thinker> [executor]` sets both models inline for the session.
  - `/mcp [id]`: opens the MCP inspector, optionally pre-selecting a server by id.
  - `/skills` (or bare `/skill`): opens the skills browser; `/skill <name>` executes a skill immediately.
  - `/status`: renders a system-diagnostics box — git branch, clean/dirty working tree, worktree-sandbox state, active runtime, thinker/executor models, the active **methodology profile**, and Muninn entity/observation counts (a failed Muninn database open reports the error instead of `0 entities, 0 observations`).
  - `/clear`: clears the conversation and stream viewports.
  - `/draft` (alias `/go`): runs scope extraction and document drafting.
  - `/quit` (alias `/abort`): exits the session after a two-step confirmation.
- **Extensible Skills System (`/skills`, `/skill <name>`)**: Markdown skills in `<project>/.huginn/skills/` and `<project>/.opencode/skills/` (`.huginn` wins) are discovered automatically and browsable/executable in-app. Each skill pairs flat frontmatter metadata (`name`/`title`, `description`/`desc`, `triggers` as a YAML list, `[a, b]` or comma list) with a reusable prompt body; a file without frontmatter falls back to its basename + first paragraph. Three built-in skills (`audit`, `refactor`, `explain`) ship by default. See [Project skills](#project-skills-huginnskills).
- **Consistent Action Feedback**: every action answers in the conversation with one of three prefixes — `✓` (done), `⚠` (problem, always naming the next step such as `/model <id>`, `/agent` or `/mcp`, with the raw cause on a `cause:` line) or `…` (running) — so no input is a silent no-op. An empty conversation shows raven-flavoured first-run hints for the palette, `/draft`, `/mcp`, `/status` and `/help`.

Flags: `--spec/--adr/--plan <file>` to override paths, `--prompt-file <file>` for long ideas,
`--choose-model` to open the model selector modal on launch, `--continue`/`-c`, `--session <id>` and
`--list-sessions`/`-sl` to resume or list persisted sessions,
plus the run-mode flags `--mode`, `--profile`, `--permissions`, `--max-retries`, `--sandbox`/`--no-sandbox`,
`--no-git-init`, `--port`, `--server-timeout`, `--phase-timeout`, `--tui | --headless`. In headless
mode the chat refinement is skipped (the CLI idea is used as-is) and approvals are answered on stdin;
non-interactive stdin aborts with a hint to use the TUI.

### Clarifying questions (agent-agnostic)

Every runtime — not just OpenCode — can ask you a question mid-turn, because a one-shot subprocess
CLI cannot open a prompt of its own. When the agent needs a decision it emits a marked block:

```
<<<HUGINN_QUESTION>>>
[{"question": "Which database?", "header": "Storage",
  "options": [{"label": "Postgres", "description": "managed, needs a server"},
              {"label": "SQLite", "description": "embedded, single file"}]}]
<<<END_HUGINN_QUESTION>>>
```

Huginn parses the JSON `QuestionItem[]` out of the reply, **strips the block from what you see**,
and opens its decision modal with the real options. Keys: a digit `1`–`9` picks that option verbatim,
`Enter` accepts the recommended (first) one, `d` skips the question (the turn continues without an
answer) and `Esc` aborts it. The chosen answer is sent back to the agent as a follow-up turn, so it
can continue with your decision. Only the **first** question in a block is selectable — a block with
more says so. An unparseable, unclosed or empty block is surfaced as a warning (sanitized) instead of
being dropped, and a question left unanswered aborts the turn after a bounded deadline.

To make your own agent ask, the protocol is wired into the refine system prompt and the injected
Muninn rules block; the instruction is simply:

> If you genuinely need the user to choose before you can continue, emit a single question block
> instead of guessing: `<<<HUGINN_QUESTION>>>` followed by a JSON array of
> `{"question": string, "options": [{"label": string, "description"?: string}]}` and
> `<<<END_HUGINN_QUESTION>>>`, each on its own line.

**Not honoured today (deliberately de-scoped):** the `multiple` (multi-select) and `custom`
(free-text) fields are parsed but ignored, and there is no arrow-key selection — a future iteration
must amend the spec before claiming them.

### Project skills (`.huginn/skills/`)

Live mode discovers Markdown skills in two project-relative folders — `.huginn/skills/` first (so it
shadows `.opencode/skills/`) — and falls back to the three built-in skills `audit`, `refactor` and
`explain`. Browse everything with `/skills`, or run one directly with `/skill <name>`:

```markdown
---
name: Release notes
description: Draft release notes from the diff since the last tag.
triggers: [release, changelog, notes]
---

Summarize the commits since the last git tag as user-facing release notes.
Group them under Added / Changed / Fixed and link each entry to its PR.
```

- Frontmatter is a flat subset only: `name`/`title`, `description`/`desc`, and `triggers` (dash list,
  `[a, b]` flow list, or comma list). Inline `#` comments are stripped; nested keys, block scalars and
  multi-line values are treated as plain text.
- A file **without** frontmatter still works: id/name come from the filename, the description from the
  first paragraph, and the body from the rest (a leading `# Heading` is skipped).
- `/skill <name>` resolves by id, name or trigger, then by substring.
- Discovery is hardened for untrusted repos: symlinked skill directories are rejected (`lstat` +
  `realpath` containment), files are opened with `O_NOFOLLOW` and capped at 1 MB, prototype-pollution
  keys are skipped, and every field is run through `sanitizeTerminalText`.

## The cycle (per iteration of `plan.md`)

Huginn composes every step's instruction itself (`src/engine/steps/`) and sends it as a **prompt** to
the configured runtime — no opencode subagents and no slash commands are involved (only `EXECUTE` and
the `FIX_*` phases name opencode's built-in `build` agent, so the SDK session keeps that agent's
tools). The verdict of a huginn-run gate is huginn's own:

1. **SPEC_AUDIT** — the embedded spec-auditor role audits `spec.md` against the implementation and must
   end on `### Overall fidelity: 🟢/🟡/🔴`. 🔴 deviations → fix with thinker, re-audit. On a repo with
   no implementation code yet (greenfield), the audit is skipped with a ⏭️ verdict until an iteration
   has produced code.
2. **EXECUTE** — sends the iteration's prompt verbatim to the `build` agent (executor).
3. **VALIDATE_STEP** — huginn runs the gate itself: the qa role in `AUDIT-ONLY MODE`, the spec-auditor
   role and the security role, then a synthesis turn. The verdict is **computed deterministically** from
   the three sub-reports (each must emit its own `### Audit status:`/`### Overall fidelity:` line) and
   the synthesis may only *escalate* it; huginn imposes the final `### Overall gate:` line and handoff
   marker on the report and gates on the structured verdict, never on the model's prose.
4. **TEST_MODULE** — the embedded test-module instruction; verdict via a small "judge" pass.
5. **SECURE_CHECK** — the embedded security-audit instruction; any breach → fix with thinker until clear.
6. **REVIEW** — the embedded pre-PR review instruction; blockers → fix with thinker and re-review.
7. **DOC_SYNC** — the embedded doc-sync instruction (informative, never blocks).
8. **COMMIT_ALL** — the embedded commit instruction produces the semantic commits.

The auditor phases (`SPEC_AUDIT`, `VALIDATE_STEP`, `SECURE_CHECK`, `REVIEW`) are **read-only**: huginn
hashes the working tree before and after the step and forces BLOCKED if the signature is missing or
changed, so an audit that wrote to the repository cannot pass a gate.

Repository material is treated as **untrusted**: every fragment embedded in a prompt (documents, `git`
output, module names, phase reports) is sanitized, capped at 60 000 characters and wrapped in a
`<<<BEGIN/END UNTRUSTED-<nonce> …>>>` block whose closing delimiter the content cannot forge; a
document path that is a symlink — or that resolves outside the project when it is meant to be inside
it — is refused instead of read or written; and every `git` call runs with the repository's own pager,
fsmonitor, hooks and diff drivers disabled.

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

### Methodology profiles

The eight phases above are the **Huginn Cycle** — the default `--profile huginn`, unchanged and pinned
by a snapshot test. `--profile` selects a different ordered pipeline over the same phase vocabulary,
so switching methodology changes *what runs and in what order*, not how a phase works:

| Profile | Name | Pipeline |
|---|---|---|
| `huginn` | Huginn Cycle (default) | spec-audit → execute → validate-step → test-module → secure-check → review → doc-sync → commit-all |
| `sdd` | Spec-Driven Development | spec-audit → execute → validate-step → test-module → review → doc-sync → commit-all, with a spec/design/tasks **preamble** folded into execute and the run committed only after verification |
| `odd` | Organic-Driven Development | execute → test-module → commit-all (lightweight daily changes, no heavy gates) |
| `rdd` | Receipt-Driven Development | execute → test-module → validate-step → commit-all, where verification **freezes a receipt** the commit references |
| `strict-tdd` | Strict TDD | test-module (**expected to fail**) → execute → test-module → validate-step → commit-all, with a **frozen worktree snapshot** recorded as evidence |

- **Selecting it**: `--profile <id>` on `run` and `live`, `"profile"` in `.huginn/config.json`, or
  `huginn config set --profile <id>`. An unknown id fails closed with usage; a persisted unknown
  profile is dropped with a warning (never a crash).
- **Announced**: the active profile is printed in the CLI banner (e.g. `profile=huginn`) and shown as
  the **Methodology** row in the `/status` box, so you always know which cycle is running.
- **Frozen evidence (`rdd` / `strict-tdd`)**: on iteration success a receipt is written to
  `.huginn/receipts/iter-<n>.json` (mode `0o600`) recording the profile, the base and resulting
  commits, the tree hash and the per-phase verdicts; `strict-tdd` also pins the pre-`EXECUTE` tree,
  so "the tests were failing first" is checkable against a hash instead of a claim. Writing a receipt
  is best-effort and never fails an otherwise-successful iteration.

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

Live-mode conversations are **not** part of `.harness/` (which the handoff clears): they live in
`<project>/.huginn/live/sessions.json` and are excluded from git through `.huginn/.gitignore`.

If a run is interrupted, just re-run the same command and it auto-resumes from the exact phase.
`--force-restart` wipes saved state; `--ignore-plan-changes` resumes even after editing the docs.

## Muninn Memory Engine (`.huginn/`)

Huginn includes the **Muninn memory engine** (`src/muninn/`), an embedded, persistent memory layer for AI agents and developers that stores architectural decisions, conventions, bugfixes, discoveries, and code symbol linkages using SQLite with FTS5:

- **Path Resolution**:
  - Automatically resolves to `<git_root>/.huginn/muninn.db` when operating inside a git repository.
  - Falls back to `~/.huginn/muninn.db` when running outside of a git repository.
  - Supports explicit custom file paths or `:memory:` for testing.
  - Parent directories are created with secure permissions (`0o700`).
  - `.huginn/` and SQLite WAL/SHM artifacts are excluded from version control via `.gitignore`.
- **Database Reliability & Pragmas**:
  - `journal_mode = WAL`: Write-Ahead Logging for high concurrency and crash durability.
  - `foreign_keys = ON`: Strict foreign key enforcement with cascading deletions (`ON DELETE CASCADE`).
  - `recursive_triggers = ON`: Ensures cascading row deletes activate FTS5 synchronization triggers.
  - `busy_timeout = 5000`: 5-second queue wait during database lock contention.
  - Indexed via `idx_observations_project_updated` on `(project_id, updated_at DESC, created_at DESC)` for fast chronological retrieval.
- **FTS5 Full-Text Search**:
  - Real-time indexing of `title`, `content`, and `topic_key` via `observations_fts` virtual table.
  - Kept in sync automatically by database triggers (`obs_ai`, `obs_ad`, `obs_au`).
- **Security & Privacy**:
  - Git remote URLs in the `projects` table have embedded basic auth credentials stripped prior to storage.
  - Exported memory files (`.huginn/memories.jsonl`) are written with restrictive owner-only permissions (`0o600`).

### MemoryService API (`src/muninn/service/`)

The application core exposes `MemoryService` (`src/muninn/service/memory-service.ts`) for high-level memory operations:

- **`saveObservation(input)`**:
  - Transactionally creates an observation and links any provided symbols in a single atomic transaction.
  - Enforces strict category validation (`decision`, `convention`, `discovery`, `bugfix`, `architecture`).
  - Accepts flexible symbol shapes (`string`, `{ name, filePath, type }`, or `{ identifier }`), normalizing them via `normalizeSymbol`.
  - Reuses existing entities within the project and deduplicates identical symbols attached to the same observation.
  - Returns the newly created observation with generated UUID and attached `entities`.
- **`search(options)`**:
  - Full-text search across `title`, `content`, and `topic_key` using SQLite FTS5 `MATCH`.
  - Ranks matches by BM25 relevance (`bm25(observations_fts) ASC`, lower score = higher relevance).
  - Sanitizes user input via `sanitizeFtsQuery` (escapes quotes, handles paths, slashes, colons, and prefix `*` wildcards safely) to prevent FTS5 syntax errors.
  - Scopes searches to the current project by default (override with `allProjects: true` or explicit `projectId`).
  - Clamps result limits between `1` and `500` (default: `10`).
  - Returns matches with BM25 `rank` and all linked `entities` attached.
- **`getContext(options)`**:
  - Retrieves recent observations ordered chronologically by `updated_at DESC, created_at DESC`.
  - Supports filtering by `category`, `topicKey`, and `projectId`.
  - Clamps limits between `1` and `500` (default: `20`).
  - Fetches and attaches linked entities in safe chunks (max 500 items per batch) to respect SQLite parameter limits.
- **`linkSymbol(observationId, symbol)` / `linkSymbol(input)`**:
  - Explicitly links a code symbol or file to an existing observation within an atomic transaction.
  - Idempotent: re-linking an already associated entity executes cleanly without creating duplicate links.
- **`getStats(projectId?)`**:
  - Returns aggregate counts for `projects`, `observations`, `entities`, and `links` (`observation_entities`).
  - Supports global aggregation or scoping to a specific `projectId`.
- **`syncToDisk(targetPath?, options?)`**:
  - Exports observations and linked entities to a portable JSON Lines (`.jsonl`) file, defaulting to `<project_root>/.huginn/memories.jsonl`.
  - Safe atomic write: writes content to a temporary `.tmp` file with `0o600` permissions (`rw-------`), ensures permissions via `chmod`, and replaces the target via `renameSync`.
- **`importFromDisk(sourcePath?)`**:
  - Idempotently imports records from `.huginn/memories.jsonl` (or custom path) inside a single transaction.
  - Automatically skips records whose observation `id` already exists.
  - Validates record structure, falling back to current project if a foreign `projectId` is missing, and defaulting invalid categories to `'decision'`.
  - Re-links and indexes all entities; imported observations are automatically indexed into FTS5 by database triggers.

### Model Context Protocol (MCP) Server (`src/muninn/mcp/`)

Muninn exposes its memory engine directly to AI coding agents (Claude Code, Cursor, OpenCode, Devin) through a standard Model Context Protocol (MCP) server:

- **Transport**: JSON-RPC 2.0 communication over standard input/output (`stdio`), using a bounded `StdioServerTransport` from `@modelcontextprotocol/sdk` (a 5 s write deadline plus output-stream error rejection, so a broken pipe fails the pending request instead of hanging on `'drain'`).
- **Architecture**: Decoupled via the `IMemoryService` port interface (`src/muninn/service/index.ts`). The server accepts any compliant memory service instance or options to initialize its own.
- **Declarative Tool Registry**: Defined via `TOOL_REGISTRY`, mapping tool names to strict Zod schemas and typed handlers.

#### Available Tools

| Tool | Description | Parameters |
|---|---|---|
| `muninn_save` | Saves an observation with optional linked entities. | `category` (`decision`, `convention`, `discovery`, `bugfix`, `architecture`), `title` (1–1,000 chars), `content` (1–1,000,000 chars), optional `topicKey` (<= 256 chars), optional `symbols` (array of up to 500 strings or Symbol objects). |
| `muninn_search` | Full-text keyword search ranked with BM25 relevance. | `query` (1–2,000 chars), optional `category`, optional `limit` (1–500, default: 10), optional `allProjects` (boolean). |
| `muninn_context` | Retrieves recent chronological observations for context injection. | optional `limit` (1–500, default: 20), optional `category`, optional `topicKey` (<= 256 chars), optional `allProjects` (boolean). |
| `muninn_link_symbol` | Links a code symbol or file to an existing observation. | `observationId` (string), `symbol` (string or Symbol object with at least one of `name`, `identifier`, or `filePath`). |
| `muninn_stats` | Returns aggregate metrics (`projects`, `observations`, `entities`, `links`). | optional `allProjects` (boolean). |

#### Validation & Security Hardening

- **Zod Schema Validation**: Every tool argument payload is validated with strict type, enum, and length constraints.
- **Payload Bounds Defense**: Defensive upper bounds prevent denial-of-service via oversized payloads (titles clamped to 1,000 chars, content to 1,000,000 chars, topic keys to 256 chars, symbols arrays to 500 items, search queries to 2,000 chars, and result limits to 500).
- **Nullish Normalization & Alias Translation**: `normalizeArgs` strips explicit `null` and `undefined` values sent by LLM clients for optional parameters and automatically maps `snake_case` aliases (`topic_key`, `observation_id`, `all_projects`) to their canonical `camelCase` equivalents.
- **Prototype Pollution Prevention**: `normalizeArgs` ignores sensitive keys (`__proto__`, `constructor`, `prototype`) during argument processing.
- **Symbol Refinement**: `SymbolSchema` requires at least one identifiable attribute (`name`, `identifier`, `filePath`, or `file_path`), rejecting empty `{}` symbol objects.
- **Fail-Safe Tool Responses**: Tool handler errors and Zod validation failures are trapped and returned as structured tool error results (`isError: true` with formatted messages via `formatZodErrors`) rather than terminating the stdio transport connection.

#### Agent Integration

Configure the Muninn MCP server in your agent client (e.g. `.cursor/mcp.json` or OpenCode `mcp` settings):

```json
{
  "mcpServers": {
    "muninn": {
      "command": "huginn",
      "args": ["mcp", "run"]
    }
  }
}
```

For running from source during development:

```json
{
  "mcpServers": {
    "muninn": {
      "command": "bun",
      "args": ["run", "/path/to/huginn/src/cli.ts", "mcp", "run"]
    }
  }
}
```

#### Project-Level MCP Configuration (`.huginn/mcp.json`)

Huginn automatically discovers and loads project-scoped MCP servers declared in `<project>/.huginn/mcp.json`. Supported root containers include `mcpServers`, `mcp`, or `servers`:

```json
{
  "mcpServers": {
    "git": {
      "command": "mcp-server-git",
      "args": ["--repository", "."]
    },
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}
```

- **Safe Parsing & Defense-in-Depth**: Config files exceeding 1MB are ignored; object keys including `__proto__`, `constructor`, and `prototype` are stripped to prevent prototype pollution.
- **Unified Merge**: Automatically merged alongside target agent configurations (e.g. `.cursor/mcp.json`, `.mcp.json`, OpenCode `mcp` settings) when reporting server health and tool lists in the `/mcp` inspector.

### Muninn CLI Commands (`huginn memory`)

Muninn memory operations are accessible directly from the CLI:

```sh
# Initialize SQLite database and verify schema
huginn memory init [--db <path>] [--project <path>]

# Search observations with BM25 relevance ranking
huginn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]

# Export observations to portable JSON Lines format (.huginn/memories.jsonl)
huginn memory sync [--file <path>] [--project <path>]

# Import observations from JSON Lines format
huginn memory sync --import [--file <path>] [--project <path>]
```

| Subcommand | Flag / Option | Description |
|---|---|---|
| `init` | `--db <path>` | Path to SQLite database (defaults to `<git_root>/.huginn/muninn.db`). |
| | `--project <path>` / `--root <path>` | Workspace root path to associate. |
| `search` | `<query>` or `--query <q>` | Search query string (BM25 ranked over title, content, topic). |
| | `--category <cat>` | Filter by category (`decision`, `convention`, `discovery`, `bugfix`, `architecture`). |
| | `--limit <n>` | Max search results to display (default: `10`). |
| `sync` | `--import` | Import from disk into SQLite database instead of exporting. |
| | `--file <path>` | Path to `.jsonl` file (defaults to `<project_root>/.huginn/memories.jsonl`). |

### Stdio MCP Server Runner (`huginn mcp run`)

Run the MCP stdio server to connect Muninn memory with agent clients:

```sh
# Start stdio MCP server for current git workspace
huginn mcp run

# Start stdio MCP server with custom database and workspace
huginn mcp run --db /custom/muninn.db --project /path/to/project
```

The server is stdout-silent and EPIPE-safe: it writes nothing to `stdout`, logs protocol and stdout failures to `stderr`, and shuts down cleanly when its parent closes `stdin` (EOF) or the transport closes — a dead parent can neither leave it running nor crash it mid-response.

## Environment variables

All optional:

| Variable | Type | Default | Effect |
|---|---|---|---|
| `HUGINN_OPENCODE_CONFIG_DIR` | path | `~/.config/opencode` | Where opencode's own config lives; also where the update-check cache (`huginn-update-cache.json`) is written. |
| `HUGINN_THINKER_MODEL` | model string | `anthropic/claude-opus-4-5` | Fallback thinker model when neither flag nor config sets one. |
| `HUGINN_EXECUTOR_MODEL` | model string | `opencode/gpt-5.1-codex` | Fallback executor model when neither flag nor config sets one. |
| `HUGINN_AGENT` | agent id | unset | Fallback agent runtime when neither flag nor config sets one. A removed target (`gemini`, `windsurf`) warns and falls through to PATH detection. |
| `HUGINN_THEME` | `light` \| `dark` \| `auto` | `auto` | Pins the TUI palette; `auto` stays background-agnostic (and sniffs `COLORFGBG`). |
| `NO_COLOR` | string | unset | Any non-empty value (per no-color.org) disables every TUI theme token and `dimColor`. |
| `HUGINN_MODEL` | model string | unset | Extra environment hint for wrapper scripts; the real model channel is the runtime's own `--model`/`-m` flag (or the OpenCode SDK model ref). |
| `HUGINN_AGENT_<ID>_MCP_PATH` | colon-separated paths | registry default | Override the MCP config path(s) for a `huginn setup` target. |
| `HUGINN_AGENT_<ID>_RULES_PATH` / `HUGINN_AGENT_RULES_PATH` | path | registry default | Override the rules file path for a `huginn setup` target (or all targets). |
| `HUGINN_HOME` | path | `os.homedir()` | Home directory used for global config/MCP resolution. |
| `HUGINN_NO_UPDATE_CHECK` | string | unset | Any non-empty value disables the background npm version check. |
| `HUGINN_DEBUG` | string | unset | Print full error stack traces on fatal errors, plus non-fatal notes (e.g. why Muninn indexing was skipped). |
| `CI` | string | unset | Every prompt (`promptLine`/`promptYesNo`, `src/util/prompt.ts`) returns its fallback instead of reading stdin — `huginn init` and any non-interactive run never block on a human. |

### Background update check

Every `huginn run` / `plan` / `live` fires a **non-blocking** check against the npm registry
(`https://registry.npmjs.org/@dahch/huginn/latest`, 3 s fetch timeout). It never delays or fails
the run: the result is only a yellow `⬆ A new version of huginn is available: vX → vY` reminder on
stderr with the update command. Results are cached in
`<opencode-config-dir>/huginn-update-cache.json` for 24 hours, and a stale cache is used as a
fallback when the registry is unreachable. Set `HUGINN_NO_UPDATE_CHECK=1` to disable.

## Development

```sh
npm test              # full test suite (bun test unit tests + vitest muninn suite)
bun test              # run core unit tests via bun test
vitest run            # run muninn database, service, mcp, and command tests
bun run typecheck     # tsc --noEmit
bun run dev -- ...    # run from source
bun run build         # bundle to dist/ for the global bin
```

## Built-in step prompts (no installer)

- The roles and task bodies the cycle runs (`spec-auditor`, `qa`, `security`, `doc-writer`,
  `reviewing` and the per-step instructions) are inlined in `src/engine/steps/instructions.ts` and
  composed per step by `src/engine/steps/prompts.ts`, so they are read from memory and never from
  disk — a single-file install and a source checkout behave identically and there is no
  `~/.config/opencode` copy to drift.
- The `bun install` postinstall hook and the `templates/` tree are gone, along with
  `HUGINN_TEMPLATES_DIR`; `huginn install` prints a compatibility notice and exits 0.
- `HUGINN_OPENCODE_CONFIG_DIR` still points at opencode's own config directory (used for the
  update-check cache and the `opencode` MCP registration path in `huginn setup`).
