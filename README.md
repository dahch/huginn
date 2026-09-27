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

Running `huginn` with no subcommand opens the **live console** — the live-first default:

```sh
# Open the interactive live console in the current git repo
huginn

# ...or start it with an idea: refine, draft, approve, then build
huginn "create a payments module"

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

# Draft spec.md, adr.md, and plan.md from an idea
huginn plan \
  --project /path/to/repo \
  --thinker anthropic/claude-opus-4-5 \
  "Initial idea..."

# Register the Muninn MCP server + agent directives with your agents
huginn setup

# Diagnose the local environment, providers and Muninn database
huginn doctor

# Search persistent memory across codebase
huginn memory search "database schema"

# Start the MCP stdio server for agent integration
huginn mcp run
```

The project defaults to the current working directory and the models are resolved from configuration
(see [Model configuration](#model-configuration)) rather than requiring `--thinker`/`--executor`.

Run `huginn help` (or `huginn -h`) for all flags — note a bare `--help` is parsed
as a run-mode flag and falls through to argument validation (it prints usage, but
exits 1); `huginn help` exits 0.

### Commands

| Command | Usage | Description |
|---|---|---|
| *(none)* | `huginn ["<idea>"]` | **Live-first default**: open the live console (optionally seeded with an idea) |
| `run` | `huginn run [flags]` | Execute the build cycle against `plan.md`/`spec.md`/`adr.md` |
| `live` | `huginn live [flags] ["<idea>"]` | Interactive chat refinement with thinker model, drafting, approval, and execution |
| `plan` | `huginn plan [flags] "<idea>"` | Generate `spec.md`, `adr.md`, and `plan.md` in one shot using thinker model |
| `setup` | `huginn setup [--agent <id\|all>] [--list] [flags]` | Register the Muninn MCP server + agent directives across supported agents |
| `doctor` | `huginn doctor [flags]` | Diagnose the environment, providers and Muninn database |
| `check` | `huginn check [files...] [flags]` | Verify TypeScript compiler execution contracts with visual diagnostic snippets |
| `install` | `huginn install [flags]` | Install opencode subagents and slash commands into `~/.config/opencode` |
| `memory` | `huginn memory <subcmd> [flags]` | Manage persistent codebase memory (`init`, `search`, `sync`, `index`) |
| `mcp` | `huginn mcp run [flags]` | Start the Model Context Protocol stdio server for agent integration |

`huginn setup` targets: `cursor`, `claude`, `opencode`, `windsurf`, `gemini`, `qwen`, `codex`, `agy`,
`kimi`, `pi`, `commandcode`, `omp`, or `all` (default). `--list` prints the registry without writing
anything; `--force` overwrites a conflicting existing `muninn` entry (otherwise it is left untouched
and reported as skipped). Paths are overridable via `HUGINN_AGENT_<ID>_MCP_PATH` (colon-separated)
and `HUGINN_AGENT_RULES_PATH` / `HUGINN_AGENT_<ID>_RULES_PATH`.

`huginn doctor` exits `0` only when its **critical** checks pass (git repository, a runtime, and the
Muninn database); the `git` binary, Node, `opencode` CLI and missing agent integrations are warnings.

### Run Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--project <path>` | `cwd` | git repo being built; `run` requires `plan.md`, `spec.md`, `adr.md` |
| `--thinker <m>` | resolved from config (see [Model configuration](#model-configuration)) | model used to **fix** findings (auditor + reviewer + any blocker) |
| `--executor <m>` | resolved from config | model used for everything else (execution, gates, docs, commits) |
| `--plan / --spec / --adr <file>` | `plan.md`/`spec.md`/`adr.md` | input documents |
| `--mode auto\|supervised` | `auto` | `auto`: autonomous with a fix-retry budget, escalating to you only when it is exhausted; `supervised`: pause for your call at every blocked gate |
| `--permissions auto\|ask\|deny` | `auto` | auto-approve tool permission requests |
| `--max-retries <n>` | `3` | thinker fix attempts per blocked gate before escalating to you |
| `--from-iteration <n>` | — | start at iteration n |
| `--only-phase <name>` | — | run a single phase per iteration (debugging) |
| `--sandbox` / `--no-sandbox` | `--sandbox` | run each iteration in an isolated git worktree under `.huginn/worktrees/` (see [Sandboxing](#sandboxing-git-worktrees)); `--no-sandbox` runs iterations in place |
| `--resume` | — | resume from saved state; fails if no saved state exists (plain re-runs auto-resume anyway) |
| `--force-restart` | — | discard saved state and start over |
| `--ignore-plan-changes` | — | resume even if plan/spec/adr changed |
| `--tui \| --headless` | auto | interactive dashboard vs stdout logs |
| `--port <n>` | free port | port for the internal `opencode serve` |
| `--server-timeout <ms>` | `60000` | server startup timeout |
| `--phase-timeout <ms>` | `1200000` (20 min) | hard deadline per phase step; on expiry the step is interrupted, retried up to `--max-retries`, then escalated. `0` disables |

## Model configuration

`run` and `live` no longer require `--thinker`/`--executor`. Models are resolved in strict
precedence order, first non-empty value wins, independently per role:

1. CLI flag — `--thinker <m>` / `--executor <m>`
2. project config — `<project>/.huginn/config.json`
3. user config — `~/.huginn/config.json`
4. environment — `HUGINN_THINKER_MODEL` / `HUGINN_EXECUTOR_MODEL`
5. defaults — thinker `anthropic/claude-opus-4-5`, executor `opencode/gpt-5.1-codex`

The project config file is a JSON object with three documented keys:

```json
{
  "thinker": "anthropic/claude-opus-4-5",
  "executor": "opencode/gpt-5.1-codex",
  "mode": "auto"
}
```

- `thinker` / `executor` are model strings (`provider/model`); `mode` is `auto` or `supervised`.
- Unknown keys are preserved verbatim, so third-party tooling can keep its own settings alongside.
- The project file overrides the user file key-by-key; a missing file is treated as empty and a
  malformed one is ignored with a warning (never fatal), falling back to the next layer.
- Writes are atomic and symlink-hardened (`.huginn/` is created `0o700`, the config `0o600`).

## Sandboxing (git worktrees)

By default (`--sandbox`), each iteration runs in an isolated git worktree so your editor stays on
the primary branch while the agent works:

- The worktree lives at `<project>/.huginn/worktrees/task-iter-<N>` on an ephemeral branch
  `huginn/task-iter-<N>`; `node_modules` and `.env` are symlinked in from the project root.
- `EXECUTE`, `VALIDATE_STEP`, `TEST_MODULE` and every `FIX_*` phase run against the sandbox.
- On iteration success the sandbox commits are integrated into your active branch
  (`git merge --ff-only`, falling back to `git cherry-pick`) and the worktree + branch are removed.
- On abort or a phase error the sandbox is discarded and your working tree is never touched. If
  promotion conflicts, the primary tree is restored and the `huginn/task-iter-<N>` branch is **kept**
  so the work is recoverable by hand.
- `--no-sandbox` runs iterations in place, exactly as before.

Stale worktrees from a crashed run are reclaimed at the start of the next run, and `SIGINT`/`SIGTERM`
trigger a best-effort cleanup.

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
plus the run-mode flags `--mode`, `--permissions`, `--max-retries`, `--sandbox`/`--no-sandbox`,
`--port`, `--server-timeout`, `--phase-timeout`, `--tui | --headless`. In headless mode the chat
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

Muninn exposes its memory engine directly to AI coding agents (Claude Code, Cursor, OpenCode, Windsurf) through a standard Model Context Protocol (MCP) server:

- **Transport**: JSON-RPC 2.0 communication over standard input/output (`stdio`) powered by `StdioServerTransport` from `@modelcontextprotocol/sdk`.
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

## Environment variables

All optional:

| Variable | Type | Default | Effect |
|---|---|---|---|
| `HUGINN_TEMPLATES_DIR` | path | auto-detected (walk up from module location) | Where `templates/` is read from — works from `src/`, `dist/`, `scripts/`. |
| `HUGINN_OPENCODE_CONFIG_DIR` | path | `~/.config/opencode` | Install destination for agents/commands; also where the update-check cache lives. |
| `HUGINN_THINKER_MODEL` | model string | `anthropic/claude-opus-4-5` | Fallback thinker model when neither flag nor config sets one. |
| `HUGINN_EXECUTOR_MODEL` | model string | `opencode/gpt-5.1-codex` | Fallback executor model when neither flag nor config sets one. |
| `HUGINN_AGENT_<ID>_MCP_PATH` | colon-separated paths | registry default | Override the MCP config path(s) for a `huginn setup` target. |
| `HUGINN_AGENT_<ID>_RULES_PATH` / `HUGINN_AGENT_RULES_PATH` | path | registry default | Override the rules file path for a `huginn setup` target (or all targets). |
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
npm test              # full test suite (bun test unit tests + vitest muninn suite)
bun test              # run core unit tests via bun test
vitest run            # run muninn database, service, mcp, and command tests
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
