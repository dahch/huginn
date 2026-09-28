# Spec: Muninn Engine — Persistent Semantic and Symbol Memory

## 1. Executive Summary

Muninn is the persistent semantic and code-symbol memory subsystem for Huginn and modern AI coding agents (Claude Code, Cursor, Windsurf, OpenCode). While Huginn represents thought and orchestration, Muninn represents memory. Muninn records developer decisions, conventions, discoveries, bug fixes, and architectural notes in an embedded SQLite database enhanced with full-text search (FTS5) and code entity graph linkage. It exposes a native Model Context Protocol (MCP) server over stdio, providing agents with deterministic, topological context retrieval without relying on remote embedding APIs or external servers.

### Goals
- Provide local and project-scoped persistent memory using embedded SQLite with FTS5.
- Link plain-text observations to code entities (files, functions, classes, interfaces, modules) and AST symbols.
- Expose a standard Model Context Protocol (MCP) JSON-RPC 2.0 server over stdio for plug-and-play agent integration.
- Provide fast BM25 ranked full-text keyword and topic search.
- Enable portable, version-controllable memory sync via `.huginn/memories.jsonl`.
- Integrate seamlessly into Huginn's CLI (`huginn memory ...` and `huginn mcp run`).

### Non-Goals
- Cloud database hosting or remote synchronization services (outside Git/JSONL).
- Vector embeddings and vector databases (v1 focuses on BM25 FTS5 lexical ranking and symbol topology).
- Heavyweight AST language parsing in runtime (v1 accepts symbol identifiers passed by agents or tools).
- Modifying project source code directly.

---

## 2. Domain Model & Bounded Contexts

### Domain Entities

1. **Project (`projects`)**:
   - Represents the workspace or repository root.
   - Attributes: `id` (UUID/slug), `name` (string), `git_remote` (optional URL/identifier), `root_path` (absolute path), `created_at` (timestamp).

2. **Observation (`observations`)**:
   - A persistent memory item capturing a decision, convention, discovery, bugfix, or architectural note.
   - Attributes: `id` (UUID), `project_id` (foreign key to `projects`), `category` (enum: `decision`, `convention`, `discovery`, `bugfix`, `architecture`), `title` (string), `content` (markdown text), `topic_key` (optional string tag), `created_at` (timestamp), `updated_at` (timestamp).

3. **Entity / Code Symbol (`entities`)**:
   - A code symbol or file within a project.
   - Attributes: `id` (UUID), `project_id` (foreign key to `projects`), `entity_type` (enum: `file`, `function`, `class`, `interface`, `module`), `identifier` (e.g. `src/auth/jwt.ts::verifyToken`), `file_path` (string path).

4. **ObservationEntity (`observation_entities`)**:
   - Join relationship linking observations to code entities.
   - Attributes: `observation_id` (FK to `observations`), `entity_id` (FK to `entities`). Primary key: `(observation_id, entity_id)`.

5. **Observations Full-Text Index (`observations_fts`)**:
   - SQLite FTS5 virtual table indexing `title`, `content`, and `topic_key` with automatic triggers on `observations` (`obs_ai`, `obs_ad`, `obs_au`).

6. **Entity Dependency (`entity_dependencies`)**:
   - Topological relationship between code entities (imports, calls, implements, extends, references).
   - Attributes: `source_entity_id` (FK to `entities`), `target_entity_id` (FK to `entities`), `relation_type` (`imports`, `calls`, `implements`, `extends`, `references`). Primary key: `(source_entity_id, target_entity_id, relation_type)`. Foreign keys enforce cascading deletions (`ON DELETE CASCADE`).

---

## 3. Ports & Adapters Architecture

- **Primary / Driving Adapters:**
  - **CLI Adapter** (`src/commands/memory.ts` routed from `src/cli.ts`): Terminal interface for human developers.
  - **MCP Adapter** (`src/muninn/mcp/server.ts`): JSON-RPC 2.0 stdio server for LLM agents.
- **Application Core:**
  - **Memory Service** (`src/muninn/service/memory-service.ts`): Core business logic orchestrating observation persistence, FTS5 BM25 search, context formatting, entity linking, and JSONL disk sync.
- **Secondary / Driven Adapters:**
  - **SQLite Database Client** (`src/muninn/db/client.ts`): Embedded SQLite driver (`better-sqlite3`) managing connections, WAL mode, foreign keys, path resolution, and schema migrations.
  - **Disk Sync Adapter** (integrated in `MemoryService`): Streams memories to and from `.huginn/memories.jsonl`.

---

## 4. Functional Requirements

### REQ-1: Database Schema & FTS5 Indexing
The database must define relational tables for `projects`, `observations`, `entities`, and `observation_entities`, along with an FTS5 virtual table `observations_fts` and synchronization triggers.
- **AC-1.1**: The DDL in `src/muninn/db/schema.sql` creates all tables and indexes idempotently (`CREATE TABLE IF NOT EXISTS`, `CREATE VIRTUAL TABLE IF NOT EXISTS`).
- **AC-1.2**: Triggers `obs_ai`, `obs_ad`, and `obs_au` automatically synchronize additions, deletions, and updates in `observations` with `observations_fts`.
- **AC-1.3**: Foreign keys are strictly enforced with cascading deletions (`ON DELETE CASCADE`).
- **AC-1.4**: Schema constraints enforce domain integrity: `CHECK` constraints restrict observation `category` (`decision`, `convention`, `discovery`, `bugfix`, `architecture`) and `entity_type` (`file`, `function`, `class`, `interface`, `module`); `UNIQUE` constraints enforce distinct project `root_path` and `(project_id, identifier)` pairs on `entities`.
- **AC-1.5**: Required relational indexes are created: `idx_observations_project_id`, `idx_observations_updated_at`, `idx_observations_project_updated` on `(project_id, updated_at DESC, created_at DESC)`, `idx_projects_root_path`, `idx_entities_project_id`, `idx_entities_identifier`, `idx_entities_project_identifier`, and `idx_observation_entities_entity_id`.

### REQ-2: Database Connection, Pragmas & Auto-Migration
The client must initialize the SQLite connection, resolve database paths based on git repository presence, configure essential pragmas, and auto-apply migrations on startup.
- **AC-2.1**: If the current working directory (or any ancestor) is a git repository, the database file defaults to `<git_root>/.huginn/muninn.db`.
- **AC-2.2**: If no git repository is detected, the database file defaults to `~/.huginn/muninn.db`.
- **AC-2.3**: Custom database paths (including `:memory:` for testing) can be passed explicitly; empty string `""` falls back to default git-root or home directory resolution.
- **AC-2.4**: Parent directories are created automatically with secure permissions (`mode: 0o700`) if they do not exist.
- **AC-2.5**: Pragmas are configured upon connection:
  - `foreign_keys = ON`: Enforces referential integrity and cascading deletions.
  - `journal_mode = WAL`: Write-Ahead Logging for high concurrency and crash durability.
  - `busy_timeout = 5000`: 5000ms lock-acquisition wait timeout to avoid immediate lock errors.
  - `recursive_triggers = ON`: Ensures cascading row deletions trigger FTS5 cleanup hooks (`obs_ad`).
- **AC-2.6**: Schema migrations execute automatically if tables do not exist, loading from `schema.sql` on disk or falling back to embedded `SCHEMA_SQL`. Connection handles are cleanly closed if initialization fails.
- **AC-2.7**: `ensureProject(db, options?)` idempotently resolves or inserts project records; git remotes are inspected from `.git/config` and sanitized via `sanitizeGitRemote` to strip embedded basic auth credentials (`https://user:pass@host/...`).

### REQ-3: Observation Creation & Entity Linking (`saveObservation`)
The memory service must provide `saveObservation` to store structured observations and link them to code symbols in one atomic transaction.
- **AC-3.1**: Enforces category validation against `VALID_CATEGORIES` (`decision`, `convention`, `discovery`, `bugfix`, `architecture`), requiring non-empty string `title` and string `content`.
- **AC-3.2**: Symbol normalization via `normalizeSymbol`: handles string symbols (`path/to/file.ts`, `module::symbol`, `plainSymbol`), object shapes (`{ name, filePath, type, identifier }`), and snake_case aliases (`file_path`, `entity_type`), defaulting entity types (`file` when path provided, otherwise `module`), and safely handling corrupted or empty inputs.
- **AC-3.3**: Deduplicates symbols within the same observation, reuses existing entity records matching `(project_id, identifier)`, and creates join rows in `observation_entities`.
- **AC-3.4**: Executes all operations within an atomic `db.transaction()`, returning the persisted observation with its generated UUID, timestamps, and attached `entities`.

### REQ-4: Full-Text Search with BM25 Ranking (`search`)
The memory service must provide `search` querying `observations_fts` and ranking results by relevance.
- **AC-4.1**: Searches across `title`, `content`, and `topic_key` using SQLite FTS5 `MATCH`.
- **AC-4.2**: Results are ranked by BM25 relevance score (`bm25(observations_fts) ASC`), ordering most relevant results first.
- **AC-4.3**: Query sanitization via `sanitizeFtsQuery` extracts terms and quoted phrases, wraps terms in double quotes, preserves valid prefix queries (`"prefix"*`), and strips pure punctuation syntax operators to prevent FTS5 syntax errors. Empty or whitespace queries return an empty array without throwing.
- **AC-4.4**: Supports project scoping (defaults to `currentProject.id`, overridable by explicit `projectId` / `project_id`, or disabled with `allProjects: true`), and category filtering.
- **AC-4.5**: Result limits are clamped between `1` and `500` (default: `10`).
- **AC-4.6**: Each returned result includes the observation record, BM25 `rank`, and all attached `entities`.

### REQ-5: Context Retrieval for Prompts (`getContext`)
The memory service must provide `getContext` to retrieve relevant observations for prompt context injection.
- **AC-5.1**: Retrieves observations ordered chronologically by `updated_at DESC, created_at DESC`, utilizing `idx_observations_project_updated`.
- **AC-5.2**: Supports filtering by `category`, `topicKey` / `topic_key`, and `projectId` / `project_id` (or `allProjects: true`).
- **AC-5.3**: Limits are clamped between `1` and `500` (default: `20`).
- **AC-5.4**: Fetches and attaches linked entities in chunks of at most 500 observation IDs at a time to prevent exceeding SQLite parameter bounds.

### REQ-6: Symbol Linking & Statistics (`linkSymbol`, `getStats`)
The memory service must support explicit symbol linking via `linkSymbol` and aggregate metrics via `getStats`.
- **AC-6.1**: `linkSymbol` accepts object input (`{ observationId, symbol }`) or positional arguments `(observationId, symbol)`, normalizes the symbol, resolves or creates the entity, and idempotently creates the link (`INSERT OR IGNORE`) in an atomic transaction.
- **AC-6.2**: `getStats(projectId?)` returns metrics (`projects`, `observations`, `entities`, `links`), supporting global counts or project-specific scoping.

### REQ-7: JSONL Disk Synchronization & Import (`syncToDisk`, `importFromDisk`)
The memory service must allow exporting memories to `.huginn/memories.jsonl` and importing them from disk.
- **AC-7.1**: `syncToDisk(targetPath?, options?)` exports all observations with linked entities as JSON Lines (`.jsonl`), defaulting to `<project_root>/.huginn/memories.jsonl` (with fallback to git root or current working directory).
- **AC-7.2**: Atomic file write with mode `0o600`: writes export data to `<targetPath>.tmp` with mode `0o600` (`rw-------`), ensures permissions via `chmod`, and replaces the target file via atomic `renameSync`. Unlinks `.tmp` on failure.
- **AC-7.3**: `importFromDisk(sourcePath?)` reads JSON Lines from disk and idempotently imports observations and entities within a single transaction.
- **AC-7.4**: Strict record validation: verifies string types for `id`, `title`, and `content`, skipping malformed or blank lines.
- **AC-7.5**: Deduplication and fallback: skips existing observation IDs without overwriting, falls back to `currentProject.id` if referenced project ID is absent, defaults invalid categories to `'decision'`, and preserves custom entity IDs or creates new ones.
- **AC-7.6**: Newly imported observations trigger automatic FTS5 synchronization via database triggers.

### REQ-8: Model Context Protocol (MCP) Server Architecture & Tooling
An MCP server must expose Muninn tools via `@modelcontextprotocol/sdk` over `StdioServerTransport` adhering to JSON-RPC 2.0 specifications with Zod validation, payload bounds, argument normalization, and prototype pollution hardening.
- **AC-8.1 (Transport & Protocol)**: Implements standard JSON-RPC 2.0 communication over `stdio` using `StdioServerTransport`. Exposes factory helper `createMcpServer(serviceOrOptions?)` returning a configured `Server` and `startMcpServer(options?)` which instantiates and connects to `StdioServerTransport`.
- **AC-8.2 (`muninn_save` Tool)**: Registers `muninn_save` with `MuninnSaveSchema`. Requires valid enum `category` (`decision`, `convention`, `discovery`, `bugfix`, `architecture`), non-empty trimmed `title` (1–1,000 characters), and non-empty trimmed `content` (1–1,000,000 characters). Accepts optional `topicKey` (trimmed, max 256 characters) and optional `symbols` array (max 500 items, containing strings or `SymbolSchema` objects requiring at least one identifier property). Atomically saves observation and links entities, returning the complete observation object.
- **AC-8.3 (`muninn_search` Tool)**: Registers `muninn_search` with `MuninnSearchSchema`. Requires non-empty trimmed `query` (1–2,000 characters). Accepts optional `category` filter, optional `limit` (positive integer, 1–500, default: 10), and optional `allProjects` (boolean). Executes BM25-ranked full-text search and returns matching observations with relevance `rank` and linked entities.
- **AC-8.4 (`muninn_context` Tool)**: Registers `muninn_context` with `MuninnContextSchema`. Accepts optional `limit` (positive integer, 1–500, default: 20), optional `category` filter, optional trimmed `topicKey` (max 256 characters), and optional `allProjects` (boolean). Returns recent observations ordered chronologically (`updated_at DESC, created_at DESC`).
- **AC-8.5 (`muninn_link_symbol` Tool)**: Registers `muninn_link_symbol` with `MuninnLinkSymbolSchema`. Requires non-empty trimmed `observationId` and valid `symbol` (non-empty string or valid `SymbolSchema` object). Idempotently creates the link between observation and entity; returns `{ observation, entity }` or an MCP error response if the observation does not exist.
- **AC-8.6 (`muninn_stats` Tool)**: Registers `muninn_stats` with `MuninnStatsSchema`. Accepts optional `allProjects` (boolean). Returns aggregate counts for `projects`, `observations`, `entities`, and `links` scoped to the current project or across all workspaces.
- **AC-8.7 (Declarative `TOOL_REGISTRY` & `IMemoryService` Port)**: Tools are registered via a declarative dictionary `TOOL_REGISTRY: Record<string, ToolDefinition>` where each tool defines its `name`, `description`, `schema`, and `handler`. The server interacts with memory persistence exclusively through the `IMemoryService` interface, decoupling the protocol transport from concrete database and filesystem implementations.
- **AC-8.8 (Argument Normalization & Prototype Pollution Defense)**: All incoming tool arguments pass through `normalizeArgs`:
  - Prunes explicit `null` and `undefined` values so optional Zod parameters pass validation regardless of how client LLMs serialize omitted options.
  - Hardens against prototype pollution by skipping dangerous keys (`__proto__`, `constructor`, `prototype`).
  - Automatically maps `snake_case` aliases (`topic_key` -> `topicKey`, `observation_id` -> `observationId`, `all_projects` -> `allProjects`) to canonical property names.
- **AC-8.9 (Graceful Tool Error Handling & Zod Formatting)**: Errors during tool execution and schema validation are caught and formatted into human-readable error messages (`formatZodErrors`). Returns structured error objects `{ isError: true, content: [{ type: "text", text: ... }] }` without dropping the stdio JSON-RPC transport stream. Fatal SQLite errors (e.g. disk I/O, database corruption) are logged to stderr and rethrown.

### REQ-9: CLI Commands Integration & Subcommand Routing
The Huginn CLI must expose memory persistence management and the MCP stdio runner via `huginn memory` and `huginn mcp`, integrated through `src/commands/memory.ts` and `src/cli.ts`.
- **AC-9.1 (CLI Routing & Argument Parsing)**:
  - `src/cli.ts` routes top-level `memory` commands to `handleMemoryCommand` and `mcp` commands to `handleMcpCommand`.
  - `parseArgs(argv)` parses flags and captures multiple positionals in `_positionals: string[]` while maintaining backward-compatible `_positional`.
  - `BOOLEAN_FLAGS` set (`--yes`, `--force`, `--resume`, `--force-restart`, `--ignore-plan-changes`, `--tui`, `--headless`, `--import`, `--help`, `-h`) prevents boolean flags from mistakenly consuming trailing arguments or flags.
  - CLI runner in `import.meta.main` honors process exit codes (`process.exit(process.exitCode ?? 0)`).
- **AC-9.2 (`huginn memory init`)**:
  - Initializes the SQLite database and validates schema readiness via `MemoryService`.
  - Accepts optional `--db <path>` and `--project <path>` (or `--root <path>`).
  - Outputs formatted initialization status including database path, project name, root path, and table readiness, cleanly closing database handles in `finally`.
- **AC-9.3 (`huginn memory search <query>`)**:
  - Accepts search query as a positional argument (`huginn memory search <query>`) or via `--query <text>`. Disambiguates positional keywords so searching for the word "search" does not conflict with subcommand routing.
  - Validates query input: missing or whitespace-only queries log a formatted error (`chalk.red`) and cleanly set `process.exitCode = 1` without throwing unhandled exceptions.
  - Accepts optional `--category <cat>` filter, optional `--limit <n>` (floors fractional values via `Math.floor` and defaults invalid or negative limits to 10), and database/project path overrides.
  - Formats results with ANSI colors: category badge (`[CATEGORY]`), BM25 score (`(score: X.XXX)`), optional `Topic: <key>`, truncated content preview (clamped to 150 characters with newlines flattened), and linked symbols (`Symbols: <list>`).
- **AC-9.4 (`huginn memory sync [--import]`)**:
  - Exports observations to disk or imports them from disk when `--import` is present.
  - Target file defaults to `<project_root>/.huginn/memories.jsonl` (with fallback to git root or current working directory), overridable via `--file <path>` or positional filename. Disambiguates positional filenames named "sync".
  - Export logs count of synced memories and resolved file path.
  - Import (`--import`) logs number of imported memories and count of skipped duplicate memories.
- **AC-9.5 (`huginn mcp run`)**:
  - Launches the stdio MCP server process via `startMcpServer({ dbPath, projectRoot })`.
  - Strictly preserves stdout purity: outputs zero console logs during startup or execution to prevent corrupting JSON-RPC frames.
  - Keeps process alive while `StdioServerTransport` is connected (`transport.onclose`) and handles `SIGINT` / `SIGTERM` signals, cleanly disposing of the server and database connections upon termination.
- **AC-9.6 (Usage & Help Information)**:
  - `huginn memory` (without arguments or with `help`, `--help`, `-h`) displays detailed memory usage information via `printMemoryUsage()`.
  - `huginn mcp` (without arguments or with `help`, `--help`, `-h`) displays MCP runner usage via `printMcpUsage()`.
  - Unrecognized subcommands log a formatted error message, display usage, and set `process.exitCode = 1`.

### REQ-10: Test Suite Coverage & Verification
The subsystem must have full unit and integration test coverage under `test/muninn/` executed with `vitest` alongside Bun unit tests.
- **AC-10.1**: Unit tests verify schema creation, foreign key constraints, FTS5 triggers, pragmas, and connection handling in `test/muninn/db.test.ts`.
- **AC-10.2**: Unit tests verify `saveObservation`, BM25 `search`, `getContext`, `linkSymbol`, `getStats`, and JSONL sync/import in `test/muninn/service.test.ts`.
- **AC-10.3**: Integration tests verify MCP tool handlers, schema validation, argument normalization, and JSON-RPC dispatch in `test/muninn/mcp.test.ts`.
- **AC-10.4**: Integration and CLI unit tests verify argument parsing, multi-positional extraction, subcommand routing, search formatting, sync import/export, error exit codes, and signal teardown in `test/muninn/commands.test.ts`.
- **AC-10.5**: All test suites pass cleanly via `npm test` (`bun test && vitest run`), enforced during package publishing via `prepublishOnly` (`bun run build && npm run test && bun run typecheck`).

### REQ-11: Verified Execution Contracts via TypeScript Compiler API
The system must provide static typecheck and compiler diagnostic verification for affected files during the execution cycle and on demand.
- **AC-11.1**: `verifyTypeScriptContracts(projectRoot: string, filePaths?: string[])` in `src/contracts/compiler.ts` searches and parses `tsconfig.json` using `ts.readConfigFile` and `ts.parseJsonConfigFileContent`. If absent, applies safe strict defaults (`strict: true`, `target: ES2022`, `moduleResolution: NodeNext`).
- **AC-11.2**: Creates a TypeScript program (`ts.createProgram`) and extracts diagnostics via `ts.getPreEmitDiagnostics`.
- **AC-11.3**: Filters diagnostics exclusively to requested `filePaths` (or all modified files if omitted), preventing irrelevant codebase noise.
- **AC-11.4**: Returns structured result `{ valid: boolean, errorsCount: number, diagnostics: FormattedDiagnostic[] }`.
- **AC-11.5**: Each diagnostic includes `filePath`, `line`, `character`, `code` (e.g. `TS2322`), `category`, `message`, and an ASCII visual snippet with caret underlining (`^^^^`) highlighting the exact error span.
- **AC-11.6**: Exposes `TypeValidator` class and `formatDiagnosticsReport` helper for consumption by harness phases and CLI tools.

### REQ-12: Topological AST Symbol & Dependency Indexer
The system must extract code symbols and dependency relationships from source files using TypeScript AST traversal and persist them in Muninn.
- **AC-12.1**: `extractSymbolsFromSource(filePath: string, sourceText: string)` parses the AST using `ts.createSourceFile` and identifies:
  - Top-level and exported functions (`ts.isFunctionDeclaration`).
  - Classes and their public methods (`ts.isClassDeclaration`, `ts.isMethodDeclaration`).
  - Interfaces and type aliases (`ts.isInterfaceDeclaration`, `ts.isTypeAliasDeclaration`).
  - Import declarations (`ts.isImportDeclaration`), extracting imported module specifiers and symbols.
- **AC-12.2**: Formats canonical entity identifiers as `<relPath>::<symbolName>` (for top-level declarations) and `<relPath>::<ClassName>.<methodName>` (for class methods).
- **AC-12.3**: `indexFilesIntoMuninn(memoryService: IMemoryService, filePaths: string[])` reads source files from disk, extracts symbols and dependency edges (`imports`, `calls`, `implements`, `extends`, `references`), and persists them into `entities` and `entity_dependencies` within an atomic transaction.
- **AC-12.4**: Cascading deletes: removing an entity automatically cascades deletion to its outgoing and incoming rows in `entity_dependencies`.

### REQ-13: Pipeline Harness Integration, MCP Tools & CLI Extensions
The verification contracts and AST symbol indexer must integrate seamlessly into Huginn's execution loop, MCP server, and CLI commands.
- **AC-13.1**: In `src/engine/phases.ts` `validateStep`: Executes `verifyTypeScriptContracts` on iteration modules before or alongside test execution. If severe compilation errors exist, fails closed with `blocked` verdict and injects structured diagnostic feedback into the prompt context for `FIX_VALIDATE`.
- **AC-13.2**: In `src/engine/phases.ts` `commitAll` (or post-execution): Runs `indexFilesIntoMuninn` over iteration modified files (`git diff`) to keep Muninn's symbol graph continuously synchronized.
- **AC-13.3**: MCP Tool `muninn_inspect_symbol`: Registered in `TOOL_REGISTRY` with `MuninnInspectSymbolSchema`. Accepts `{ symbol: string, projectId?: string }`, resolves the entity, and returns entity metadata, source file path, incoming/outgoing dependencies from `entity_dependencies`, and linked observations.
- **AC-13.4**: MCP Tool `muninn_verify_contract`: Registered in `TOOL_REGISTRY` with `MuninnVerifyContractSchema`. Accepts optional `{ files?: string[] }`, runs `verifyTypeScriptContracts`, and returns realtime compiler diagnostics to autonomous agents.
- **AC-13.5**: CLI Command `huginn check [files...]`: Implemented in `src/commands/check.ts` and routed from `src/cli.ts`. Scans specified files or auto-discovers TypeScript sources in `src/`, validates contracts via `verifyTypeScriptContracts`, renders colorized error reports, and sets `process.exitCode = 1` on error.
- **AC-13.6**: CLI Command `huginn memory index [files...]`: Subcommand in `src/commands/memory.ts`. Scans specified files or project sources, extracts symbols and dependencies via `indexFilesIntoMuninn`, and reports indexed counts.
- **AC-13.7**: Dual Runtime Portability: All modules and test suites maintain 100% green status under both Node.js (via Vitest) and Bun (via `bun test`), with git diff spawning compatibility in `src/engine/diff.ts`.

---

## 5. Phase 3 — Live-First Entrypoint, Universal Agent Integrator & Git Worktree Sandboxing

### REQ-14: Persistent Model Configuration & Live-First Default Entrypoint
`huginn` invoked without a recognized subcommand must open the interactive `live` console by default, and model roles must resolve through a persistent configuration layer rather than mandatory flags.
- **AC-14.1 (Config discovery)**: `loadUserConfig(projectPath)` in `src/config.ts` reads `.huginn/config.json` in the project root, falling back to `~/.huginn/config.json`. The schema is `{ thinker?: string; executor?: string; mode?: "auto" | "supervised" }`, validated at runtime. A missing file yields `{}`; malformed JSON is ignored with a warning (fail-open on reads, never throws to the CLI).
- **AC-14.2 (Model resolution precedence)**: resolved in strict order — CLI flag (`--thinker` / `--executor`) → project `.huginn/config.json` → user `~/.huginn/config.json` → environment (`HUGINN_THINKER_MODEL` / `HUGINN_EXECUTOR_MODEL`) → documented defaults (`thinker` = `anthropic/claude-opus-4-5`, `executor` = `opencode/gpt-5.1-codex`). Resolution is a pure, exported function that accepts injectable sources so it is unit-testable without env mutation.
- **AC-14.3 (Config persistence)**: `saveUserConfig(projectPath, config)` atomically writes `.huginn/config.json` (write temp file with an exclusive `wx` create, `chmod 0o600`, symlink-safe `rename`), creating `.huginn/` with mode `0o700`. Unknown keys are preserved. The persistence layer is exposed on the CLI: `huginn config show` prints the effective resolved `thinker`/`executor` and which layer each came from; `huginn config set [--thinker <m>] [--executor <m>]` persists to the project `.huginn/config.json`, or to `~/.huginn/config.json` with `--global`.
- **AC-14.4 (Default routing)**: `main(argv)` routes to `runLive` when no known subcommand is present — including the case where the only positional token is a free-text idea (`huginn "crear módulo de pagos"`). Known subcommands (`run`, `plan`, `live`, `install`, `memory`, `mcp`, `check`, `setup`, `doctor`) keep their existing routing. `--help`/`-h` still print usage.
- **AC-14.5 (Defaults for live)**: when `--project` is omitted, `live` defaults to `canonicalize(process.cwd())`; when `--thinker`/`--executor` are omitted they are resolved from REQ-14.2 instead of producing a hard error. If the resolved project is not a git repository, the CLI errors clearly.
- **AC-14.6 (Sandbox flags)**: `--sandbox` / `--no-sandbox` are boolean flags consumed by `run` and `live` and stored in `RunConfig.sandbox` (default `true`).

### REQ-15: Universal Agent Integrator (`huginn setup`)
`huginn setup` must idempotently register the Muninn MCP server and inject agent directives into every supported agent, driven by a **declarative target registry** so new agents are a one-row addition.
- **AC-15.1 (Targets)**: the target ids are `cursor`, `claude`, `opencode`, `windsurf`, `gemini`, `qwen`, `codex`, `agy`, `kimi`, `pi`, `commandcode`, `omp`, plus the aggregate `all`. An unknown `--agent` value prints usage and exits `1`. `huginn setup --list` prints the registry (id, label, config path(s), rules file, format) without writing anything.
- **AC-15.2 (MCP registration registry)**: the server entry `muninn` (command `huginn mcp run --project <projectPath>`) is registered per target in the target's declared path(s), using the declared format:
  | id | label | MCP config path(s) | format |
  |---|---|---|---|
  | `cursor` | Cursor | `<project>/.cursor/mcp.json`, `<home>/.cursor/mcp.json` | `mcpServers` |
  | `claude` | Claude Code / Desktop | `<project>/.mcp.json`, `<home>/.claude.json`, `<home>/.claude/claude_desktop_config.json` | `mcpServers` |
  | `opencode` | OpenCode | `<home>/.config/opencode/opencode.json` (honors `HUGINN_OPENCODE_CONFIG_DIR`) | `opencode` (`mcp` key) |
  | `windsurf` | Windsurf | `<home>/.codeium/windsurf/mcp_config.json` | `mcpServers` |
  | `gemini` | Gemini CLI | `<home>/.gemini/settings.json` | `mcpServers` |
  | `qwen` | Qwen Code | `<home>/.qwen/settings.json` | `mcpServers` |
  | `codex` | OpenAI Codex CLI | `<home>/.codex/config.toml` | `toml` (`[mcp_servers.muninn]`) |
  | `agy` | Antigravity CLI (agy) | `<home>/.gemini/config/mcp_config.json`, `<project>/.agents/mcp_config.json` | `mcpServers` |
  | `kimi` | Kimi Code CLI | `<home>/.kimi-code/mcp.json`, `<project>/.kimi/mcp.json` | `mcpServers` |
  | `pi` | Pi coding agent | `<home>/.pi/mcp.json`, `<project>/.pi/mcp.json` | `mcpServers` |
  | `commandcode` | Command Code | `<home>/.commandcode/mcp.json`, `<project>/.commandcode/mcp.json` | `mcpServers` |
  | `omp` | Oh My Pi | `<home>/.omp/mcp.json`, `<project>/.omp/mcp.json` | `mcpServers` |
- **AC-15.3 (Portable fallback)**: `setup` always writes a standard `mcpServers` file at `<home>/.huginn/mcp.json` so any tool accepting a `--mcp-config-file`/ad-hoc JSON (e.g. Kimi, Pi) can be pointed at it, independent of the target registry.
- **AC-15.4 (Idempotency & preservation)**: registration merges into existing config, preserves all unrelated keys and sibling servers, and re-running produces byte-identical output (no duplicate entries). `--force` overwrites the managed `muninn` entry if a conflicting one exists; without `--force` a differing existing `muninn` entry is left untouched and reported as skipped.
- **AC-15.5 (Rules injection)**: injects a marked block delimited by `<!-- huginn:muninn-rules:start -->` / `<!-- huginn:muninn-rules:end -->` into the target's declared rules file — `CLAUDE.md` (claude), `.cursorrules` (cursor), `.windsurfrules` (windsurf), `GEMINI.md` (gemini), `QWEN.md` (qwen), and `AGENTS.md` (opencode, codex, agy, kimi, pi, commandcode, omp). The block must instruct the LLM to call `muninn_context` and `muninn_inspect_symbol` before designing changes, and `muninn_verify_contract` before emitting any final code. Re-running replaces only the marked block, leaving surrounding user content intact.
- **AC-15.6 (File safety)**: missing parent directories are created (`0o700`); an existing target keeps its current permission bits (a file the user hardened to `0o600` is never widened), while a new file is created `0o600` (MCP configs) or `0o644` (rules files); malformed existing JSON is reported as an error for that target without corrupting the file; writes are atomic and hardened against symlink swaps (temp created with the `wx` exclusive flag, never following a pre-existing symlink); TOML configs are parsed/merged structurally, not by naive string appends.
- **AC-15.7 (Home & path resolution)**: home-dependent paths use an injectable `homeDir` (default `os.homedir()`); each target's paths are overridable via `HUGINN_AGENT_<ID>_MCP_PATH` (colon-separated) and `HUGINN_AGENT_RULES_PATH`, so a non-canonical or moved config is fixable without a code change; tests never touch the real user home.

### REQ-16: Diagnostic Command (`huginn doctor`)
`huginn doctor` must verify the environment Huginn depends on.
- **AC-16.1 (Checks)**: reports on — git binary + current directory is a git repository; Bun runtime; Node runtime; `opencode` CLI on `PATH`; agent integration state (which of `.cursor/mcp.json`, `.claude.json`, `opencode.json`, `mcp_config.json` already register Muninn); and Muninn database health (open via `MemoryService` and read stats).
- **AC-16.2 (Reporting)**: prints one colorized line per check with a `✔` / `✖` / `⚠` marker and a short detail. Exit code is `0` when all critical checks pass (git repo, runtime, Muninn DB) and `1` otherwise; missing optional integrations are warnings, not failures.
- **AC-16.3 (Testability)**: `runDoctorChecks(options)` returns a structured `DoctorReport` (`{ checks: Array<{ id, label, status: "ok" | "warn" | "fail", detail }> }`) independent of console output, so it can be asserted in tests with injected `homeDir` / `projectPath`.

### REQ-17: Git Worktree Sandbox Isolation
The execution cycle must run each iteration in an isolated git worktree by default.
- **AC-17.1 (WorktreeManager API)**: `src/engine/worktree.ts` exports `WorktreeManager` with `createSandbox(projectRoot, iteration): Sandbox`, `promoteSandbox(sandbox): PromoteResult`, `discardSandbox(sandbox): void`, `listSandboxes(): Sandbox[]`, and `cleanupAll(): void`. A `Sandbox` is `{ iteration: number; path: string; branch: string; projectRoot: string; baseCommit: string }`.
- **AC-17.2 (Creation)**: `createSandbox` derives `branch = huginn/task-iter-<N>` and `path = <projectRoot>/.huginn/worktrees/task-iter-<N>`, then runs `git worktree add -b <branch> <path> HEAD`. It fails closed (throws) without mutating state when the branch or path already exists; `createSandbox` cleans up any stale entry first only when explicitly asked via `cleanupAll`.
- **AC-17.3 (Dependency symlinks)**: if `node_modules` and/or `.env` exist at `projectRoot`, a symlink is created inside the sandbox pointing at the root copy, unless a real file/dir already exists there (never overwrite). Symlink failures are non-fatal warnings.
- **AC-17.4 (Promotion)**: `promoteSandbox` integrates the sandbox commits into the user's active branch via `git merge --ff-only <branch>` when fast-forward is possible, otherwise `git cherry-pick <baseCommit>..<branch>`. It returns `{ promoted: boolean; method: "ff" | "cherry-pick" | "none"; commits: string[] }`. It then removes the worktree with `git worktree remove --force`; on a **successful** integration it also deletes the branch with `git branch -D`, while on a **conflict** (`promoted: false`) it restores the primary tree with `git cherry-pick --abort` and **keeps** the `huginn/task-iter-<N>` branch so the sandbox work remains recoverable. A zero-commit sandbox returns `method: "none"` (a legitimate no-op, not a conflict).
- **AC-17.5 (Discard)**: `discardSandbox` removes the worktree (`git worktree remove --force`, tolerating an already-removed path) and deletes the ephemeral branch, never touching the user's primary working tree. It is idempotent.
- **AC-17.6 (CycleEngine integration)**: `RunConfig.sandbox` (default `true`) gates the behavior. When enabled, `CycleEngine.runIteration` creates a sandbox and **binds every agent phase to it**: session creation and all `prompt`/`command` calls pass the sandbox directory via the opencode SDK `directory` query parameter, so `EXECUTE`, `VALIDATE_STEP`, `TEST_MODULE`, and all `FIX_*` phases (and the harness-side module inference, compiler contracts and git diff) operate *inside* the worktree, and `COMMIT_ALL` commits there. **Muninn durability exception**: the harness-side Muninn indexing *scans* the modified files from the worktree but *persists* entities/observations to the **PRIMARY** project database (`<primaryProjectRoot>/.huginn/muninn.db`, resolved from `RunConfig.projectPath` via `resolveDatabasePath`), because the worktree's own `.huginn/` is destroyed on promotion/discard — durable memory must outlive the sandbox (ADR-20). On success `promoteSandbox` integrates the commit into the primary branch. On abort or phase error the sandbox is discarded. A **conflict** during promotion fails the run closed (the iteration is not marked complete; the branch is preserved for recovery). When sandboxing is enabled but the repository has no `HEAD` commit yet, the engine falls back to in-place execution with a warning instead of failing.
- **AC-17.7 (Stale cleanup)**: pre-run `cleanupAll` reclaims both stale worktrees under `~/.huginn`-style `<project>/.huginn/worktrees/` **and** any leftover ephemeral `refs/heads/huginn/task-iter-*` branches, so a preserved conflict branch cannot block later runs.

---

## 6. Non-Functional Requirements

- **NFR-1 (Performance)**: FTS5 BM25 queries against 10,000 observations must resolve in under 10ms.
- **NFR-2 (Reliability & Integrity)**: Database runs with SQLite Write-Ahead Logging (WAL), foreign key cascade enforcement, recursive triggers for FTS5 synchronization, a 5000ms busy timeout, and directory creation mode `0o700`.
- **NFR-3 (Zero Cloud Lock-in)**: Completely self-contained; zero network calls or external API keys required.
- **NFR-4 (Compatibility)**: Works seamlessly in Node.js (v20+) and Bun (v1.0+) environments on macOS, Linux, and Windows.
- **NFR-5 (Type Safety)**: 100% strict TypeScript types with no `any` and full Zod schema validation for runtime inputs.

---

# Spec: Modern Multi-Agent Runtime, Fullscreen Terminal UI, Provider Agnosticism, MCP & Skills Ecosystem (Phase 5)

## 7. Executive Summary & Goals

Phase 5 elevates Huginn to modern industry standards (competing with and exceeding Gentle AI, OpenCode, and Claude Code). It eliminates vendor lock-in by decoupling Huginn from OpenCode through a universal Agent Runtime Adapter (`IAgentRuntime`), introduces an immersive fullscreen Terminal UI with Alternate Screen Buffer and responsive viewport adaptation (eliminating scroll leakage and uncontained output), adds interactive model/provider selection with persistent user defaults, provides live visibility into Model Context Protocol (MCP) health and tools, and introduces a dynamic project Skills and Slash Commands system.

### Goals
- **Universal Agent Runtime (`IAgentRuntime`)**: Support OpenCode, Claude Code, OpenAI Codex, Oh My Pi (`omp`), Command Code (`commandcode`), Qwen Code (`qwen`), and generic CLI/stdio agents agnostically.
- **Fullscreen Terminal UI ("Vida Propia")**: True terminal alternate screen buffer (`\x1b[?1049h`), 100% height and width viewport scaling without terminal scroll leakage, and silent background server log buffering.
- **Interactive Model & Provider Selection**: In-session `/models` command, automated provider scanning from active runtime, interactive terminal picker on unconfigured runs, and persistent "Save as default?" preference.
- **Live MCP Health & Tool Inspection**: Header status pill showing active MCP count and health, `/mcp` interactive inspector modal, and project-level `.huginn/mcp.json` support.
- **Project Skills & Rich Slash Commands**: Dynamic skill loading (`.huginn/skills/*.md`), in-session commands (`/help`, `/agent`, `/models`, `/mcp`, `/skills`, `/status`, `/clear`, `/draft`, `/quit`).
- **Guided CLI Ergonomics**: `huginn init` setup wizard, streamlined two-tier `--help` documentation.

### Non-Goals
- Re-implementing LLM inference or provider client SDKs from scratch (Huginn orchestrates agent runtimes and their native CLIs/APIs).
- Replacing Muninn's SQLite memory core (Muninn remains Huginn's authoritative persistent memory and symbol graph).

---

## 8. Functional Requirements (Phase 5)

### REQ-21: Fullscreen Terminal UI & Viewport Engine
The TUI must operate in an isolated Alternate Screen Buffer, scale dynamically to terminal rows and columns, and prevent console scroll leakage.
- **AC-21.1 (Alternate Screen Buffer & Exit Safety)**: Upon launching interactive TUI (`renderTui` or `renderLiveTui`), Huginn sends `\x1b[?1049h\x1b[H` to stdout to switch to the terminal alternate screen buffer, clearing previous shell history. To prevent cursor loss or orphaned terminal states if Node/Bun suffers an abrupt exit, `\x1b[?1049l\x1b[?25h` is registered in a synchronous `process.on("exit")` handler, `SIGINT`/`SIGTERM` handlers, and an absolute `try...finally` block, ensuring the primary screen and cursor visibility are always restored.
- **AC-21.2 (Responsive Dimensions Hook)**: The TUI subscribes to `process.stdout.on("resize")` via a custom `useTerminalSize()` hook. Layout components compute dynamic heights (`rows`) and widths (`columns`), expanding chat, stream, logs, or sidebars to utilize 100% of the terminal canvas without fixed line truncation or vertical overflow.
- **AC-21.3 (Zero Stdout Pollution & Hot Console Interception)**: Background startup logs (server initialization, provider checks, update notifications) and any runtime `console.log`, `console.warn`, or `console.error` emitted while the TUI is mounted are dynamically intercepted (via `patchConsole` / log redirection) and piped into an internal ring buffer (`ServerLogDrawer` / event stream). No raw text may be emitted directly to stdout while in the alternate screen buffer, preventing visual tearing.
- **AC-21.4 (Scroll Containment)**: Mouse wheel, page up/down, and arrow scrolling are trapped within the active focused card or modal. Scrolling within the TUI can never spill into the host terminal emulator scrollback buffer.
- **AC-21.5 (Stream Batching & Render Throttling)**: High-frequency agent output stream events (`phaseStream`) are throttled (flushed every 60ms) and capped with a 1,000-line ring buffer. This prevents Ink rerender thrashing, terminal flicker, and UI CPU spikes during rapid model token streaming while retaining full scrollback history up to the cap.


### REQ-22: Decoupled Multi-Agent Runtime Architecture (`IAgentRuntime`)
The execution cycle and live refinement loop must interact with AI coding agents strictly through an agnostic `IAgentRuntime` interface.
- **AC-22.1 (Runtime Abstraction)**: Defines `IAgentRuntime`:
  - `id: AgentTarget` (`opencode`, `claude`, `codex`, `omp`, `commandcode`, `qwen`, `kimi`, `pi`, etc.).
  - `name: string` (display label).
  - `isAvailable(): Promise<boolean>` (detects CLI binary on `PATH` or daemon availability).
  - `getAvailableModels(): Promise<ModelInfo[]>` (returns supported or authenticated models).
  - `getMcpStatus(): Promise<McpStatusReport>` (reports connected MCP servers and tools).
  - `createSession(options: SessionOptions): Promise<IAgentSession>` (creates stateful execution session with `prompt`, `runCommand`, `abort`).
- **AC-22.2 (Built-in Adapters)**:
  - `OpencodeRuntimeAdapter`: Wraps `opencode serve` and `@opencode-ai/sdk`.
  - `ClaudeRuntimeAdapter`: Integrates with Claude Code CLI via subshell or stdio JSON-RPC.
  - `CodexRuntimeAdapter`: Integrates with OpenAI Codex CLI.
  - `OmpRuntimeAdapter`: Integrates with Oh My Pi (`omp`) CLI.
  - `CommandCodeRuntimeAdapter`: Integrates with Command Code CLI.
  - `QwenRuntimeAdapter`: Integrates with Qwen Code CLI.
  - `GenericSubprocessRuntimeAdapter`: Configurable stdio adapter for Kimi, Pi, and custom agent binaries.
- **AC-22.3 (Runtime Registry & Resolution)**: `getAgentRuntime(id)` instantiates the requested runtime adapter. Precedence: `--agent <id>` CLI flag → project `.huginn/config.json` (`agent`) → user `~/.huginn/config.json` → auto-detection of installed binaries (`claude`, `opencode`, `codex`, `omp`) → default `opencode`.
- **AC-22.4 (Hot Runtime Switching)**: In Live mode, typing `/agent <id>` or using the agent picker switches the active execution runtime for subsequent prompts without restarting Huginn.

### REQ-23: Interactive Model & Provider Selector & Persistence
Huginn must discover available models from the active runtime and provide interactive selection and persistence.
- **AC-23.1 (Provider & Model Auto-Discovery)**: At startup or upon opening the model picker, Huginn queries `runtime.getAvailableModels()`. If the runtime is offline or returns an empty list, Huginn falls back to `DEFAULT_FALLBACK_MODELS`. Models display provider badges (`[Anthropic]`, `[OpenAI]`, `[Google]`, etc.), model names, IDs, and descriptions.
- **AC-23.2 (Interactive 3-Step Modal (`ModelPickerModal`))**: Renders an interactive 3-step modal directly over the TUI:
  - *Step 1 (Thinker)*: Select reasoning/architecture model with live search filter and custom fallback.
  - *Step 2 (Executor)*: Select implementation/gate model.
  - *Step 3 (Save Preferences)*: Select persistence destination (`[1] Project Default`, `[2] Global Default`, `[3] Session Only`).
  - Enforces `provider/model` format for both thinker and executor models, displaying inline error banners on invalid input.
  - Traps keyboard events (`↑`/`↓` / `k`/`j` to navigate, `1`/`2`/`3` direct scope pick, `Enter` to confirm, `Esc` to cancel), maintains scroll containment (6 visible items), and bridges inputs via `useRef` to eliminate React 19 / Ink memoization race conditions.
- **AC-23.3 (Multi-Scope Atomic Persistence)**:
  - *Project Default*: Saves to `<project>/.huginn/config.json` via `saveUserConfig`.
  - *Global Default*: Saves to `~/.huginn/config.json` (or `HUGINN_HOME`) via `saveGlobalUserConfig`.
  - *Session Only*: Updates `LiveEngine.updateModels({ thinker, executor })` in-memory without mutating configuration files on disk.
  - Disk persistence is atomic (write to `.tmp` then rename) and symlink-safe (`0o700` dir, `0o600` file), preserving any unknown JSON keys verbatim.
- **AC-23.4 (In-Session Slash Commands)**:
  - `/models` or `/model`: Opens `ModelPickerModal` in the Live TUI without disrupting existing chat scrollback or stream buffers.
  - `/model <thinker> [executor]`: Switches active models inline for the session. Validates `provider/model` syntax, updates `LiveEngine`, synchronizes header badges, and emits a system notification into `liveChat`.
- **AC-23.5 (CLI Flag & Pre-Flight Auto-Onboarding)**:
  - Accepts `--choose-model` CLI flag to trigger the model picker modal immediately upon startup in Live mode.
  - Pre-flight auto-onboarding check: If `thinker` or `executor` resolved from default configuration sources, Huginn probes `runtime.getAvailableModels()`. If the catalog is populated and neither default model is present, Huginn automatically enables `chooseModel` to prevent runtime provider errors.

### REQ-24: Unified Multi-MCP Monitoring & Inspector
Huginn must monitor and display the status of all connected Model Context Protocol (MCP) servers and their tools.
- **AC-24.1 (Header Status Badge & Non-Blocking Polling)**: The TUI header displays a live MCP indicator:
  - `MCP: 🟢 <count> active (<tools> tools)` when all servers are connected.
  - `MCP: 🟡 degraded` when any server reports error or degraded status.
  - `MCP: 🟡 timeout` when polling exceeds deadline.
  - `MCP: ⚪ 0 active` when no servers are registered or report is null.
  - Periodic polling (15s intervals) in `Dashboard` and `LiveDashboard` is bounded by a strict 1500 ms non-blocking timeout via `Promise.race` in `fetchMcpStatusWithTimeout`, protecting the Ink render loop from slow, hanging, or disconnected MCP servers.
- **AC-24.2 (Interactive `/mcp` Inspector Modal (`McpInspectorModal`))**: In Live mode, typing `/mcp` opens an interactive two-pane inspector modal:
  - *Left Pane (Servers)*: Lists connected MCP servers with connection status (`[connected]`, `[error]`, `[disconnected]`), transport (`[stdio]`, `[sse]`, `[file]`), and roundtrip latency in ms.
  - *Right Pane (Tools Detail)*: Lists exposed tools for the selected server with tool names and descriptions. Implements paginated windowing (10 visible tools with `▲ ... more above` and `▼ ... more below` scroll markers) to prevent modal height overflow.
  - *Keyboard Navigation & State Bridge*: `[↑/↓]` or `[k/j]` navigates items, `[Tab]` or `[Enter]` toggles focus between servers and tools panes, and `[Esc]` closes the modal. Uses `stateRef` bridge pattern to guarantee fresh state references in `useInput` under React 19 / Ink.
  - *Terminal Sanitization (`SEC-001`)*: Sanitizes all server names, tool descriptions, and error strings via `sanitizeTerminalText` to strip ANSI escape sequences and non-printable control characters, mitigating terminal injection and cursor hijacking.
- **AC-24.3 (Project-Level MCP Declaration & Safe Auto-Discovery)**: Huginn automatically discovers and loads `<project>/.huginn/mcp.json` alongside target agent configuration paths:
  - Supports `mcpServers`, `mcp`, and `servers` configuration sections.
  - Rejects files exceeding 1MB or non-regular files (`SEC-002`).
  - Strips prototype pollution keys (`__proto__`, `constructor`, `prototype`) during JSON parsing (`SEC-003`).

### REQ-25: Extensible Skills System & Live Slash Commands
Huginn must support modular project skills and interactive slash commands in the live environment.
- **AC-25.1 (Skill Discovery)**: Scans `.huginn/skills/*.md` and `.opencode/skills/*.md`. Each skill defines metadata (name, description, triggers) and reusable prompt instructions.
- **AC-25.2 (Live Slash Commands)**: The Live input bar intercepts slash commands before model dispatch:
  - `/help`: Displays modal with command reference, shortcuts, and active configuration.
  - `/agent [id]`: Opens agent picker or switches to specified agent.
  - `/models [model]`: Opens model picker or updates thinker/executor.
  - `/mcp [id]`: Opens MCP server inspector.
  - `/skills`: Lists available skills and previews their instructions.
  - `/status`: Displays comprehensive status (git branch, worktree sandbox, runtime, memory stats).
  - `/clear`: Clears conversation scrollback in TUI.
  - `/draft`: Executes scope extraction and drafts `spec.md`, `adr.md`, `plan.md`.
  - `/quit`: Gracefully exits with confirmation.

### REQ-26: CLI Ergonomics, `huginn init` & Help Hierarchy
The CLI must offer clear, structured commands and a frictionless initialization wizard.
- **AC-26.1 (`huginn init`)**: Guided interactive wizard that:
  - Detects git repository and package manager.
  - Scans installed agent CLIs (`opencode`, `claude`, `codex`, `omp`).
  - Prompts developer to choose default agent and preferred models.
  - Registers Muninn MCP (`huginn setup`) and creates initial `.huginn/config.json`.
- **AC-26.2 (Streamlined Help)**: `huginn --help` presents a concise, visually grouped summary (Core commands: `live`, `run`, `init`, `setup`, `doctor`). Advanced technical options are cleanly categorized or surfaced via `huginn --help --all`.
