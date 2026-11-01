# Spec: Muninn Engine — Persistent Semantic and Symbol Memory

> **Scope note (Muninn extraction).** REQ-1…REQ-13 describe the memory engine, its MCP server,
the AST indexer and the compiler-contract verifier. Those now ship in the
[`@dahch/muninn`](https://github.com/dahch/muninn) package (published on npm as `0.1.0`, consumed as
`^0.1.0`): the paths `src/muninn/**`, `src/contracts/**`, `test/muninn/**` and `test/contracts/**`
below name **that package's** tree, not this repository. `huginn memory`, `huginn check` and
`huginn mcp run` remain thin wrappers over the same library, so the CLI surface and the
`.huginn/muninn.db` location are unchanged. Every other requirement in this file is implemented
here, and its paths are current.

## 1. Executive Summary

Muninn is the persistent semantic and code-symbol memory subsystem for Huginn and modern AI coding agents (Claude Code, Cursor, Devin, OpenCode). While Huginn represents thought and orchestration, Muninn represents memory. Muninn records developer decisions, conventions, discoveries, bug fixes, and architectural notes in an embedded SQLite database enhanced with full-text search (FTS5) and code entity graph linkage. It exposes a native Model Context Protocol (MCP) server over stdio, providing agents with deterministic, topological context retrieval without relying on remote embedding APIs or external servers.

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
- **AC-10.5**: All test suites pass cleanly via `npm test` (`bun test src && vitest run`), enforced during package publishing via `prepublishOnly` (`bun run build && npm run test && bun run typecheck`).

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
- **AC-15.1 (Targets)**: the target ids are `cursor`, `claude`, `opencode`, `devin`, `qwen`, `codex`, `agy`, `kimi`, `pi`, `commandcode`, `omp`, `mcode`, `mimo`, plus the aggregate `all`. An unknown `--agent` value prints usage and exits `1`. `huginn setup --list` prints the registry (id, label, config path(s), rules file, format) without writing anything.
- **AC-15.2 (MCP registration registry)**: the server entry `muninn` (command `huginn mcp run --project <projectPath>`) is registered per target in the target's declared path(s), using the declared format:
  | id | label | MCP config path(s) | format |
  |---|---|---|---|
  | `cursor` | Cursor | `<project>/.cursor/mcp.json`, `<home>/.cursor/mcp.json` | `mcpServers` |
  | `claude` | Claude Code / Desktop | `<project>/.mcp.json`, `<home>/.claude.json`, `<home>/.claude/claude_desktop_config.json` | `mcpServers` |
  | `opencode` | OpenCode | `<home>/.config/opencode/opencode.json` (honors `HUGINN_OPENCODE_CONFIG_DIR`) | `opencode` (`mcp` key) |
  | `devin` | Devin (formerly `windsurf`) | `<project>/.devin/mcp_config.json`, `<home>/.config/devin/mcp_config.json` | `mcpServers` |
  | `qwen` | Qwen Code | `<home>/.qwen/settings.json` | `mcpServers` |
  | `codex` | OpenAI Codex CLI | `<home>/.codex/config.toml` | `toml` (`[mcp_servers.muninn]`) |
  | `agy` | Antigravity CLI (agy) | `<home>/.gemini/config/mcp_config.json`, `<project>/.agents/mcp_config.json` | `mcpServers` |
  | `kimi` | Kimi Code CLI | `<home>/.kimi-code/mcp.json`, `<project>/.kimi/mcp.json` | `mcpServers` |
  | `pi` | Pi coding agent | `<home>/.pi/agent/mcp.json`, `<project>/.pi/mcp.json` | `mcpServers` |
  | `commandcode` | Command Code | `<home>/.commandcode/mcp.json`, `<project>/.mcp.json` | `mcpServers` |
  | `omp` | Oh My Pi | `<home>/.omp/mcp.json`, `<project>/.omp/mcp.json` | `mcpServers` |
  | `mcode` | MiniMax Code | `<project>/.mcp.json` | `mcpServers` |
  | `mimo` | MiMo Code | `<home>/.config/mimocode/mimocode.json` | `opencode` (`mcp` key) |
- **AC-15.3 (Portable fallback)**: `setup` always writes a standard `mcpServers` file at `<home>/.huginn/mcp.json` so any tool accepting a `--mcp-config-file`/ad-hoc JSON (e.g. Kimi, Pi) can be pointed at it, independent of the target registry.
- **AC-15.4 (Idempotency & preservation)**: registration merges into existing config, preserves all unrelated keys and sibling servers, and re-running produces byte-identical output (no duplicate entries). `--force` overwrites the managed `muninn` entry if a conflicting one exists; without `--force` a differing existing `muninn` entry is left untouched and reported as skipped.
- **AC-15.5 (Rules injection)**: injects a marked block delimited by `<!-- huginn:muninn-rules:start -->` / `<!-- huginn:muninn-rules:end -->` into the target's declared rules file — `CLAUDE.md` (claude), `.cursorrules` (cursor), `.windsurf/rules/muninn.md` (devin, which kept Windsurf's rules root), `QWEN.md` (qwen), and `AGENTS.md` (opencode, codex, agy, kimi, pi, commandcode, omp, mcode, mimo). The block must instruct the LLM to call `muninn_context` and `muninn_inspect_symbol` before designing changes, and `muninn_verify_contract` before emitting any final code. Re-running replaces only the marked block, leaving surrounding user content intact.
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
- **AC-17.4 (Promotion)**: `promoteSandbox` integrates the sandbox commits into the user's active branch via `git merge --ff-only <branch>` when fast-forward is possible; otherwise, when the integration range carries a merge commit (the promotion-repair path merges the primary into the preserved branch), via `git merge --no-ff <branch>`; otherwise via `git cherry-pick <baseCommit>..<branch>`. It returns `{ promoted: boolean; method: "ff" | "merge" | "cherry-pick" | "none"; commits: string[] }`. It then removes the worktree with `git worktree remove --force`; on a **successful** integration it also deletes the branch with `git branch -D`, while on a **conflict** (`promoted: false`) it restores the primary tree with `git merge --abort` or `git cherry-pick --abort` (whichever is in flight) and **keeps** the `huginn/task-iter-<N>` branch so the sandbox work remains recoverable. A zero-commit sandbox returns `method: "none"` (a legitimate no-op, not a conflict).
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
> **Superseded by REQ-67.** The engines now consume `RuntimePort`/`RuntimeSession`. `IAgentRuntime` remains the CLI-shaped adapter contract behind `getAgentRuntime` and the shape `asRuntimePort` bridges; the requirements below record the interface as it was introduced.
- **AC-22.1 (Runtime Abstraction)**: Defines `IAgentRuntime`:
  - `id: AgentTarget` (`opencode`, `claude`, `codex`, `omp`, `commandcode`, `qwen`, `kimi`, `pi`, `cursor`, `devin`, `agy`, `mcode`, `mimo`).
  - `name: string` (display label).
  - `isAvailable(): Promise<boolean>` (detects CLI binary on `PATH` or daemon availability).
  - `getAvailableModels(): Promise<ModelInfo[]>` (returns supported or authenticated models).
  - `getMcpStatus(): Promise<McpStatusReport>` (reports connected MCP servers and tools).
  - `createSession(options: SessionOptions): Promise<IAgentSession>` (creates stateful execution session with `prompt`, `runCommand`, `abort`).
  - `readonly sessionHistory?: boolean` (Phase 8: `true` when the backend keeps the conversation server-side — only `opencode`; every subprocess runtime declares `false`, which is also how `undefined` is read).
- **AC-22.2 (Built-in Adapters)**:
  - `OpencodeRuntimeAdapter`: Wraps `opencode serve` and `@opencode-ai/sdk`.
  - `ClaudeRuntimeAdapter`: Integrates with Claude Code CLI via subshell or stdio JSON-RPC.
  - `CodexRuntimeAdapter`: Integrates with OpenAI Codex CLI.
  - `OmpRuntimeAdapter`: Integrates with Oh My Pi (`omp`) CLI.
  - `CommandCodeRuntimeAdapter`: Integrates with Command Code CLI.
  - `QwenRuntimeAdapter`: Integrates with Qwen Code CLI.
  - `KimiRuntimeAdapter`, `PiRuntimeAdapter`, `DevinRuntimeAdapter`, `McodeRuntimeAdapter`, `MimoRuntimeAdapter`: first-class adapters for the CLIs whose non-interactive form needs its own shape (kimi's `-p <prompt>`, pi's `-p` + stdin, devin's `--prompt-file`, mcode's `exec --input -`, mimo's `run`).
  - `GenericSubprocessRuntimeAdapter`: Configurable stdio adapter for `agy`, `cursor` and custom agent binaries.
- **AC-22.3 (Runtime Registry & Resolution)**: `getAgentRuntime(id)` instantiates the requested runtime adapter. Precedence: `--agent <id>` CLI flag → project `.huginn/config.json` (`agent`) → user `~/.huginn/config.json` → `HUGINN_AGENT` → auto-detection of the first installed binary in `AGENT_TARGETS` order → default `opencode`. A persisted/`HUGINN_AGENT` target that was **removed** (`gemini`, `windsurf`) warns and falls through to detection instead of throwing.
- **AC-22.4 (Hot Runtime Switching)**: In Live mode, typing `/agent <id>` or using the agent picker switches the active execution runtime for subsequent prompts without restarting Huginn.

### REQ-23: Interactive Model & Provider Selector & Persistence
Huginn must discover available models from the active runtime and provide interactive selection and persistence.
- **AC-23.1 (Provider & Model Auto-Discovery)**: At startup or upon opening the model picker, Huginn queries `runtime.getAvailableModels()`. Models display provider badges, model names, IDs, and descriptions. *(**Superseded by AC-27.7**: an empty or failed discovery no longer falls back to `DEFAULT_FALLBACK_MODELS` — the picker shows an honest empty/error state carrying the discovery `reason`.)*
- **AC-23.2 (Interactive 3-Step Modal (`ModelPickerModal`))**: Renders an interactive 3-step modal directly over the TUI:
  - *Step 1 (Thinker)*: Select reasoning/architecture model with live search filter and custom fallback.
  - *Step 2 (Executor)*: Select implementation/gate model.
  - *Step 3 (Save Preferences)*: Select persistence destination (`[1] Project Default`, `[2] Global Default`, `[3] Session Only`).
  - Enforces `provider/model` format for free-text ids on runtimes whose catalog is fully qualified, displaying inline error banners on invalid input. *(Amended by AC-27.3/AC-27.5: a model chosen from the catalog is accepted verbatim, and runtimes that expose bare ids — e.g. `agy`, Command Code — accept a bare free-text id too, since they resolve the short name themselves.)*
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
- **AC-24.1 (MCP Status Badge & Non-Blocking Polling)**: The TUI displays a live MCP indicator (the run dashboard's header and, in the live console, the side panel — AC-77.1):
  - `MCP: 🟢 <count> active (<tools> tools)` when all servers are connected.
  - `MCP: 🟡 degraded` when any server reports error or degraded status.
  - `MCP: 🟡 timeout` when polling exceeds deadline.
  - `MCP: ⚪ 0 active` when no servers are registered or report is null.
  - *(Superseded by AC-32.4 / AC-76.1: the current badge says `<n> connected`, `<n> configured` or `none` and attributes the agent; the console paints `✓` / `!` / `·` instead of the pictographs.)*
  - Periodic polling (15s intervals) in `Dashboard` and `LiveDashboard` is bounded by a strict 1500 ms non-blocking timeout via `Promise.race` in `fetchMcpStatusWithTimeout`, protecting the Ink render loop from slow, hanging, or disconnected MCP servers.
- **AC-24.2 (Interactive `/mcp` Inspector Modal (`McpInspectorModal`))**: In Live mode, typing `/mcp` opens an interactive two-pane inspector modal:
  - *Left Pane (Servers)*: Lists connected MCP servers with connection status (`[connected]`, `[error]`, `[disconnected]`), transport (`[stdio]`, `[sse]`, `[file]`), and roundtrip latency in ms.
  - *Right Pane (Tools Detail)*: Lists exposed tools for the selected server with tool names and descriptions. Implements paginated windowing (10 visible tools with `▲ ... more above` and `▼ ... more below` scroll markers) to prevent modal height overflow.
  - *Keyboard Navigation & State Bridge*: `[↑/↓]` or `[k/j]` navigates items, `[Tab]` or `[Enter]` toggles focus between servers and tools panes, and `[Esc]` closes the modal. *(Amended by AC-75.2: `Enter` is a selector-only key and no longer moves this inspector's focus; `Tab` remains its pane switch.)* Uses `stateRef` bridge pattern to guarantee fresh state references in `useInput` under React 19 / Ink.
  - *Terminal Sanitization (`SEC-001`)*: Sanitizes all server names, tool descriptions, and error strings via `sanitizeTerminalText` to strip ANSI escape sequences and non-printable control characters, mitigating terminal injection and cursor hijacking.
- **AC-24.3 (Project-Level MCP Declaration & Safe Auto-Discovery)**: Huginn automatically discovers and loads `<project>/.huginn/mcp.json` alongside target agent configuration paths:
  - Supports `mcpServers`, `mcp`, and `servers` configuration sections.
  - Rejects files exceeding 1MB or non-regular files (`SEC-002`).
  - Strips prototype pollution keys (`__proto__`, `constructor`, `prototype`) during JSON parsing (`SEC-003`).

### REQ-25: Extensible Skills System & Live Slash Commands
Huginn must support modular project skills and interactive slash commands in the live environment.
- **AC-25.1 (Skill Discovery)**: Scans `.huginn/skills/*.md` and `.opencode/skills/*.md` (`.huginn` wins on id collision). Each skill defines metadata (name, description, triggers) and reusable prompt instructions; a file without frontmatter falls back to its basename and first paragraph, and three built-in skills (`audit`, `refactor`, `explain`) are appended when not shadowed (`includeBuiltins`). Discovery and reads are hardened against untrusted repositories: symlinked skill directories are rejected (`lstat` + `realpath` containment), files are read with `O_NOFOLLOW` and capped at 1 MB, prototype-pollution keys are skipped, and every parsed field is terminal-sanitized.
- **AC-25.2 (Live Slash Commands)**: The Live input bar intercepts slash commands before model dispatch; an unknown `/…` command is rejected with a system message and never forwarded to the model:
  - `/help`: Displays modal with command reference, shortcuts, and active configuration.
  - `/agent [id]`: Lists the registered runtimes (marking the active one), or hot-switches to the specified agent runtime (fails closed if it is unavailable).
  - `/models [model]`: Opens the model picker (`/models` or `/model`), or sets thinker/executor inline (`/model <thinker> [executor]`).
  - `/mcp [id]`: Opens MCP server inspector, optionally preselecting a server by id.
  - `/skills`: Lists available skills and previews their instructions; `/skill <name>` executes a skill resolved by id, name or trigger.
  - `/status`: Displays comprehensive status (git branch, clean/dirty tree, worktree sandbox, active runtime, thinker/executor models, Muninn entity/observation counts).
  - `/clear`: Clears conversation scrollback in TUI.
  - `/draft`: Executes scope extraction and drafts `spec.md`, `adr.md`, `plan.md` (alias `/go`).
  - `/quit`: Gracefully exits with a two-step confirmation (alias `/abort`).

### REQ-26: CLI Ergonomics, `huginn init` & Help Hierarchy
The CLI must offer clear, structured commands and a frictionless initialization wizard.
- **AC-26.1 (`huginn init`)**: Guided interactive wizard that:
  - Detects git repository and package manager.
  - Scans installed agent CLIs (`opencode`, `claude`, `codex`, `omp`).
  - Prompts developer to choose default agent and preferred models.
  - Registers Muninn MCP (`huginn setup`) and creates initial `.huginn/config.json`.
- **AC-26.2 (Streamlined Help)**: `huginn --help` presents a concise, visually grouped summary (Core commands: `live`, `run`, `init`, `setup`, `doctor`). Advanced technical options are cleanly categorized or surfaced via `huginn --help --all`.
- **AC-26.3 (Every subcommand owns its help)**: `huginn <cmd> --help` answers with that
  subcommand's usage instead of the global overview — `init` prints the wizard's flags and steps,
  `setup`, `doctor`, `memory`, `mcp`, `runtime`, `config` and `check` print their own usage,
  `promote` prints its recovery flags, and `run`, `live`, `plan` and `install` print the full
  `usage()` reference. The global interception answers only a bare `--help`/`-h`, `huginn help`,
  `huginn init --help` and an unknown command; every help surface prints the banner and exits 0.

---

# Spec: Runtime Fidelity, Discoverability & Live Diagnostics (Phase 6)

## 9. Executive Summary & Goals

Phase 6 fixes what a real, hand-driven session on this machine proved to be broken. Verified defects: (a) **model discovery is fake or unusable** — `OpencodeRuntimeAdapter.getAvailableModels()` returns **8 195** models (every provider in the models.dev catalog) instead of the **581** belonging to the 10 `connected` providers, and silently substitutes two hardcoded models on any failure or empty result; every other adapter returns a static literal (Command Code returns one `commandcode/default` while its real CLI offers **82** models via `commandcode --list-models`); `validateModels` in `src/cli.ts` reads `.all` from `config.providers()`, which returns `.providers`, so it warns spuriously on every opencode run; and model selection is emitted as a `HUGINN_MODEL` env var that no subprocess CLI reads. (b) The **TUI is undiscoverable** — typing `/` produces plain text with no suggestion list, and the `submit()` dispatcher and the `HelpModal` cheat sheet have drifted apart. (c) The **brand is wrong** — the header renders an eagle emoji (`🦅`) although Huginn is a raven. (d) **MCP/Muninn status lies** — subprocess adapters fabricate `status: "connected"` from config files, so a dead server keeps a green badge, and the MCP server's stdio lifecycle has no EOF/EPIPE handling.

### Goals
- **Truthful model discovery**: every adapter reports the models the runtime can actually use, or an explicit empty/error state — never a fabricated catalog — and the selected model reaches the CLI through the flag it actually understands.
- **Discoverability by construction**: a single command registry drives both execution and an inline `/` autocomplete overlay, so the UI can never advertise a command the dispatcher does not implement.
- **Identity**: an ASCII raven/wordmark header that reads as *Huginn*, not a generic emoji.
- **Honest live status**: MCP/Muninn health reflects a real probe (or is explicitly reported as unverifiable), recovers from transient daemon death, and surfaces errors instead of swallowing them.
- **Fluid feedback**: every user action produces a visible, sanitized result (success, progress, or error) in the TUI.

### Non-Goals
- Reworking the engine's phase pipeline, sandboxing, or the Muninn SQLite schema.
- Adding new agent runtimes or new slash commands beyond those already specified in Phase 5.
- Changing the `provider/model` id format used on the wire.

---

## 10. Functional Requirements (Phase 6)

### REQ-27: Truthful Cross-Runtime Model Discovery & Selection
`IAgentRuntime.getAvailableModels()` must return the models the active runtime can actually use, and the chosen model must be passed to the runtime through its native mechanism.
- **AC-27.1 (opencode — connected providers only)**: `OpencodeRuntimeAdapter.getAvailableModels()` must return models drawn **only from providers listed in the `connected` set** of `client.provider.list()`. Verified contract: the response is `{ all: Provider[], default, connected: string[] }`; filtering `all` to `connected` yields **581** models on this machine, byte-identical to `opencode models`. Models from unconnected providers (e.g. the 7 614 catalog-only models) must not be offered.
- **AC-27.2 (opencode — CLI fallback)**: when the SDK client is unreachable (daemon not started, request throws), discovery must fall back to parsing `opencode models` output (one `provider/model` per line). No hardcoded model may be returned on failure; an empty result must be reported as empty.
- **AC-27.3 (commandcode — real catalog)**: `CommandCodeRuntimeAdapter.getAvailableModels()` must parse `commandcode --list-models` (verified format: a header line `Available models  ·  N models`, provider group headings on their own line, then indented `provider/model` + description rows, followed by a trailing help/docs footer that must be ignored). The id column preserves the CLI's exact spelling (bare ids such as `claude-sonnet-5` remain bare; the full `provider/model` form is used when present).
- **AC-27.4 (generic adapters)**: `GenericSubprocessRuntimeAdapter` gains a declarative, per-runtime model-listing command (argv + parser) so every runtime reports its real catalog where its CLI supports listing. Where a CLI exposes no listing mechanism, the adapter must return an **empty** result with a `reason`, not the previous literal placeholder list; the picker then offers free-text entry. The reason is carried by an optional `getModelCatalog(): Promise<{ models, reason? }>` member on `IAgentRuntime` (the picker prefers it and renders `reason` in place of the generic empty copy), and a subprocess listing failure must distinguish a missing binary, a non-zero exit (with the first stderr line), a timeout and empty output. Verified listing mechanisms on this machine: `opencode models` (and the connected-provider SDK path) → 581, `commandcode --list-models` → 82, `omp models` → 192 (`<provider> (<count>)` sections + box-drawing table), `agy models` → 14 (`id<TAB>name` TSV, non-TSV preamble ignored), `devin models list`, `mimo models`, `pi --list-models`, `kimi provider list --json`; `claude`, `qwen`, `codex` and `cursor` expose none.
- **AC-27.5 (native model selection)**: the selected model must be forwarded through the flag the CLI documents: opencode via the SDK model ref, and subprocess runtimes via a per-runtime `--model`/`-m` argument (replacing the current `HUGINN_MODEL` env var, which no subprocess CLI reads). The env var may be retained only as an additional hint, never the sole channel.
- **AC-27.6 (provider validation)**: `validateModels` must read the provider list from the correct field (`config.providers()` returns `{ providers, default }`, not `{ all }`), so the "provider is not in the configured provider list" warning fires only when a provider is genuinely absent.
- **AC-27.7 (picker honesty & scale)**: `ModelPickerModal` must (i) render a distinct "no models discovered from <runtime> — type an id and press Enter" state instead of substituting `DEFAULT_FALLBACK_MODELS`, (ii) surface a discovery error verbatim (sanitized), and (iii) stay responsive for large catalogs (~600–8 000 entries) via incremental rendering + filter, with per-runtime seed values for thinker/executor rather than opencode-centric constants.
- **AC-27.8 (realistic verification)**: discovery tests must exercise the real parsing paths — a local HTTP server serving a captured `GET /provider` payload for opencode, and captured `--list-models`/`models` CLI fixtures for commandcode/opencode — not only hand-written mocks. Parser tests must be derived from the actual tool output captured on this machine.

### REQ-28: Discoverable Slash-Command Palette
The Live input bar must show, interactively, what the user can type.
- **AC-28.1 (single registry)**: a single exported command registry (`id`, `aliases`, `argHint`, `description`, `category`) is the source of truth for both `submit()` dispatch and the help/autocomplete UI. `HelpModal`'s cheat sheet and the palette must be generated from it, and a drift-guard test must fail if a dispatched command is absent from the registry (or vice versa).
- **AC-28.2 (trigger & filtering)**: typing `/` at the start of an empty-or-partial input opens an inline suggestion overlay directly beneath the input row; further typing filters by id/alias substring; accepting inserts the command **without submitting** — the canonical id plus a trailing space when it takes arguments (the overlay row already displayed the argument hint), and the id alone otherwise.
- **AC-28.3 (key handling while open)**: with the overlay visible, `↑`/`↓` move the highlight — and `j`/`k` do the same, but only while the draft is exactly `/` (otherwise `j`/`k` are ordinary filter characters, since typing `/k…` must remain possible); `Tab` accepts, `Enter` submits (or accepts a partial), `Esc` dismisses the overlay without aborting the session. These bindings take precedence over the existing focus-toggle (`Tab`) and scroll-trap (`↑`/`↓`) handlers **only while the overlay is open**, and a draft with no matches (e.g. `/nope`) does not count as open.
- **AC-28.4 (layout safety)**: the overlay must not overflow the terminal — it is height-bounded (≤6 visible rows with scroll markers, shrinking further on short terminals) and included in the layout height budget so chat/stream cards never overflow; the cards share whatever remains, shrinking rather than spilling the frame.
- **AC-28.5 (non-regression)**: every command documented in Phase 5 (`/help`, `/agent`, `/models`/`/model`, `/mcp`, `/skills`/`/skill`, `/status`, `/clear`, `/draft`/`/go`, `/quit`/`/abort`) remains dispatchable, and unknown `/…` input is still answered with a system message rather than forwarded to the model.

### REQ-29: Raven Identity & TUI Presence
The interface must read as Huginn the raven, with real brand presence.
- **AC-29.1 (no eagle)**: no eagle emoji (`🦅`) may remain anywhere in the source; the top-left header of both `LiveDashboard` and `Dashboard` renders an ASCII raven/wordmark treatment instead.
- **AC-29.2 (shared brand component)**: a single reusable component (`src/tui/RavenHeader` or equivalent) renders the raven mark plus the wordmark, and is used by both dashboards so the two headers cannot diverge.
- **AC-29.3 (non-blocking across sizes)**: the ASCII mark degrades gracefully on narrow terminals (wordmark-only fallback) and never consumes so many rows that the chat/stream viewport collapses.
- **AC-29.4 (presence, not decoration)**: the header additionally surfaces live, useful context (the live stage, thinker/executor and the project), so the personality comes from meaningful feedback rather than a lone glyph. *(Amended by AC-77.1: the runtime name and the MCP badge moved to the side panel; the header is identity plus ephemeral state.)*

### REQ-30: Honest MCP/Muninn Liveness & Recovery
MCP status must reflect reality and survive transient failure.
- **AC-30.1 (no fabricated status)**: `GenericSubprocessRuntimeAdapter.getMcpStatus()` must stop reporting `status: "connected"` for servers it merely found in a config file. Discovered-but-unprobed servers are reported as `unknown` (rendered distinctly as `MCP: ⚪ n configured` by `formatMcpBadge`, and the report is `healthy: false` / `unverified: true`), and a real probe is used where the runtime offers one (opencode).
- **AC-30.2 (error propagation)**: when `runtime.getMcpStatus()` throws, the report must carry `degraded: true` and the error message (sanitized) so `formatMcpBadge` renders `MCP: 🟡 error`, not an ambiguous `⚪ 0 active`.
- **AC-30.3 (stdio lifecycle hardening)**: `huginn mcp run` must (i) install a `process.stdout` `'error'` handler so an EPIPE from a closed parent pipe cannot crash the server, (ii) bridge stdin `'end'`/`'close'` to `transport.onclose` so the process exits when the parent goes away, (iii) assign `server.onerror` to log protocol failures instead of discarding them, and (iv) bound `send()` so a broken pipe fails a pending request instead of hanging forever.
- **AC-30.4 (daemon supervision)**: `startServer` (opencode) must supervise the child after the initial health check — if it exits mid-session, the failure is logged and the runtime reports a recoverable error; where feasible a restart is attempted, and the TUI is notified.
- **AC-30.5 (Muninn diagnostics)**: the `/status` `Muninn Memory:` row (and `getDiagnostics`) must distinguish "unavailable/error" from "empty" — a failed DB open reports the error rather than `0 entities, 0 observations`; best-effort indexing failures (`phases.ts`) remain non-fatal but are logged at debug level rather than silent.

### REQ-31: Fluid Feedback & Intuitive DX
The TUI must make every action's outcome visible.
- **AC-31.1 (action feedback)**: each slash command and prompt emits an immediate, sanitized acknowledgement (busy indicator, result line, or error), so no input appears to do nothing.
- **AC-31.2 (actionable errors)**: errors shown to the user name the failing component and the suggested next step (e.g. "no models discovered from Command Code — try `/model <id>` or check the CLI"), never a bare stack fragment.
- **AC-31.3 (first-run guidance)**: an empty chat viewport shows a short, raven-flavoured hint list of what can be done (type `/` for commands, `/draft` to plan, `/mcp` to inspect), reinforcing the personality of REQ-29.
- **AC-31.4 (no silent stdout)**: nothing bypasses the alternate-screen log buffer while the TUI is mounted (consistent with AC-21.3).

---

## 11. Non-Functional Requirements (Phase 6)
- **NFR-6 (Discovery latency)**: `getAvailableModels()` must resolve within a bounded deadline (≤ 15 s — measured: `opencode models` ≈ 1.7 s, `commandcode --list-models` ≈ 3.5 s) and must never block the Ink render loop (discovery is async, the picker shows a cancellable loading state, and any spawned listing CLI is killed on expiry).
- **NFR-7 (Catalog scale)**: the picker must remain interactive with up to ~10 000 entries (bounded, incremental rendering), and discovery must not retain more than the needed `ModelInfo` fields.
- **NFR-8 (Type safety)**: strict TypeScript, no `any`; all parsed external CLI output is validated and sanitized (`sanitizeTerminalText`) before display.

---

# Spec: Per-Agent MCP Truth, Composer Ergonomics & Methodology Profiles (Phase 7)

## 12. Executive Summary & Goals

Phase 7 answers what a live session on this machine exposed. **MCP is per-agent** — Huginn holds no client; the active agent owns every connection — yet the UI reported an unattributed, unexplained number (`MCP: ⚪ 5 unverified`) and could print `undefined`. Verification proved every supported CLI can enumerate its own servers with status (`opencode mcp list` → `playwright/codegraph/engram` *connected*; `agy mcp list` → a 5-row table with `enabled`; `claude mcp list` health-checks; `qwen`/`commandcode` too), and that **Muninn works** end-to-end (7 tools; `muninn_save`/`search`/`stats` verified) but is not registered for every agent. The composer also lacked input history and presence, the stream panel assumed reasoning most frontier models no longer expose, `/agent` could only *list* runtimes (so "selecting agy" was impossible), `gemini` is a dead target whose `-p` requires an argument Huginn never passed, and agent questions only ever surfaced on opencode.

### Goals
- **Per-agent MCP truth**: enumerate the real servers of the *active agent* (CLI listing where available, config files otherwise), name them, attribute them to the agent, and say plainly that changes belong in the agent's config. Never render `undefined`; never present a bare number with no explanation.
- **Selectable runtimes**: an interactive `/agent` picker so switching (e.g. to `agy`) needs no memorised id.
- **A composer that feels like a composer**: ↑/↓ recall the session's previous submissions; the input row is visually the anchor of the view.
- **Honest panels**: rename `REFINEMENT CONVERSATION` → `Conversation`; collapse the agent-stream panel when no reasoning arrives.
- **Selectable methodology**: `profile` chooses the execution pipeline — `huginn` (default, the *Huginn Cycle*) plus SDD, ODD, RDD and Strict-TDD.
- **Agent-agnostic questions**: any runtime can ask the user, via a marked block that Huginn parses, presents and resumes; opencode keeps its native channel.
- **One brain, every agent**: Muninn is provisioned for whichever installed agents the user chooses (or all), is shared across runtimes because the database is project-scoped, and the `huginn` profile leans on it for context and evidence.

### Non-Goals
- Making Huginn itself an MCP client/host (agents own their connections).
- Re-implementing agent permission systems.
- Replacing the Thinker/Executor model split or the gate/verdict machinery.

---

## 13. Functional Requirements (Phase 7)

### REQ-32: Per-Agent MCP Enumeration & Honest Attribution
The MCP surface must name the active agent's servers, attribute them to it, and never show an unexplained number or `undefined`.
- **AC-32.1 (CLI enumeration)**: `IAgentRuntime` gains `listMcpServers(): Promise<McpServerListing[]>` where `McpServerListing = { name: string; transport?: string; status: "connected" | "enabled" | "disabled" | "pending" | "unknown"; detail?: string }`. Runtimes with a listing command use it — `opencode mcp list`, `claude mcp list`, `qwen mcp list`, `agy mcp list`, `commandcode mcp list`, `codex mcp list --json`, `devin mcp list`, `mimo mcp list` (verified formats; parsers exported and fixture-tested). Runtimes without one (`omp`, `kimi`, `pi`, `cursor`, `mcode`) fall back to config-file discovery with `status: "unknown"`.
- **AC-32.2 (honest status mapping)**: a status reported by the CLI maps to its true meaning — `connected`/`Connected`/`✔` → `connected` (probed); `enabled`/`configured`/`➜` → `enabled` (configured, **not** probed); `disabled` → `disabled`; `pending approval` → `pending`; anything unrecognised → `unknown`. `connected` is the only status that may be described as live.
- **AC-32.3 (attribution & expectation management)**: the `/mcp` panel must state which agent the list came from and that Huginn only observes it ("servers come from **&lt;agent&gt;** — add or change them with the agent's own config/CLI"). It must name Muninn explicitly when present, and when absent show the exact command that registers it (`huginn setup --agent <id>`).
- **AC-32.4 (no bare numbers, no `undefined`)**: the MCP badge must always be self-describing and attribute its source (e.g. `MCP: 🟢 3 connected · opencode`, `MCP: ⚪ 5 configured · agy`, `MCP: ⚪ none · claude`; the TUI paints those marks through `mcpBadgeText` as `✓`/`!`/`·`, REQ-76). *(Amended by AC-77.1: the badge's live-console home is the side panel, not the header.)* Every numeric field is nullish-coalesced; the literal string `undefined`/`NaN` must be impossible in any MCP surface (guarded by a test).
- **AC-32.5 (deeper truth where possible)**: where a CLI exposes per-server detail (`commandcode mcp list` shows scope/auth; `claude`/`qwen` health-check), that detail is shown; where it cannot be known, the UI says so explicitly ("status not reported by &lt;agent&gt;") rather than implying health.

### REQ-33: Interactive Runtime Picker
Switching runtimes must be selectable, not memorised.
- **AC-33.1**: `/agent` (no argument) opens an interactive picker listing every `AGENT_TARGETS` entry with an explicit availability marker (`✔` available / `— not installed`), the active one marked, and the highlighted entry's resolved binary path where detected. A failed switch leaves the picker open so another runtime can be chosen immediately.
- **AC-33.2**: ↑/↓ (and `j`/`k`) navigate, Enter switches (fails closed with an actionable message when `isAvailable()` is false), Esc cancels.
- **AC-33.3**: `/agent <id>` keeps working for power users, and the picker's selection path is covered by tests.

### REQ-34: Composer Ergonomics & Input History
The message composer must be the view's anchor and support recall.
- **AC-34.1 (history)**: when the palette is closed and the input is empty (or the caret is at the boundary), `↑` recalls the previous submitted input for the session and `↓` walks forward, ending at the empty draft. Recalled drafts are editable; history holds the last N (≥ 50) submissions and never stores slash commands' system-only state.
- **AC-34.2 (presence)**: the composer is visually distinct from the panels (e.g. its own accent border/background and a clearer prompt glyph), so it reads as the primary affordance at 80×24 and above.
- **AC-34.3 (no regressions)**: the palette's `↑`/`↓` navigation and the scroll bindings keep working while their mode applies.

### REQ-35: Honest Panels & Target Hygiene
- **AC-35.1**: `REFINEMENT CONVERSATION` is renamed to **`Conversation`** everywhere it is rendered or documented.
- **AC-35.2 (adaptive stream panel)**: the agent-output panel collapses automatically when the agent has emitted no reasoning/stream content for the session (its rows return to the conversation), and expands when content arrives; it is never shown as an empty bordered box.
- **AC-35.3 (remove the dead target)**: `gemini` is removed from `AGENT_TARGETS`/the registry (its non-interactive form needs `-p <arg>` and it is superseded by `agy`), and `windsurf` is renamed to `devin` (the CLI is now Devin; the target's rules/runtime plumbing — `.windsurf/rules/muninn.md`, `--permission-mode dangerous` — was carried over). Removing/renaming a target must not break persisted configs: `REMOVED_AGENT_TARGETS` (`gemini → agy`, `windsurf → devin`) makes `resolveAgent` warn and fall back to detection instead of throwing. Docs and tests are updated.

### REQ-36: Selectable Methodology Profiles
The execution cycle must be choosable, with the built-in cycle as the default.
- **AC-36.1 (naming)**: the default pipeline is named **Huginn Cycle** and identified as `profile: "huginn"`.
- **AC-36.2 (config surface)**: `RunConfig.profile` / `UserConfig.profile` (`"huginn" | "sdd" | "odd" | "rdd" | "strict-tdd"`, default `huginn`), a `--profile` CLI flag on both `run` and `live`, persisted via `huginn config set --profile`, and sanitized like `mode`.
- **AC-36.3 (pipeline as data)**: each profile is a `PipelineStep[]` over the existing phase vocabulary (reusing the current `PIPELINE` table shape), so `runPhase`/`runIteration` are unchanged. `--only-phase` validation, `MAIN_PHASES`-derived progress and `PHASE_LABEL` must reflect the active profile.
- **AC-36.4 (the four profiles)**:
  - `huginn` — spec-audit → execute → verify → validate-step → test-module → secure-check → review → doc-sync → commit-all (the deterministic `VERIFY` runs before any LLM audit; REQ-60…63 set the turn budget).
  - `sdd` — proposal/spec → design → tasks → apply → verify → archive: gates run against the spec artifacts and the run is only committed after verification.
  - `odd` — minimal: execute → test-module → commit-all (no heavy gates; for small daily changes).
  - `rdd` — receipt-driven: execute → test-module → validate-step producing a frozen *receipt* artifact whose `headCommit` and `treeHash` pin the commit range, → commit-all.
  - `strict-tdd` — tests first: a failing-test step before execute, then execute, then the test/validate gates, with a **frozen worktree snapshot** recorded as evidence so a claim of "tests passed" cannot be hallucinated.
- **AC-36.5 (announced)**: the active profile is shown in `/status` and in the CLI/run banner, so the user always knows which methodology is running. *(Amended by AC-77.1: the live header carries the stage, the project and the models, not the profile.)*
- **AC-36.6 (no silent degradation)**: a profile that cannot run (missing template/prompt) fails closed with an actionable message rather than silently falling back to `huginn`.

### REQ-37: Agent-Agnostic Question Protocol
Any runtime must be able to ask the user, and the decision UI must honor real options.
- **AC-37.1 (marked block)**: a subprocess agent may emit a block delimited by `<<<HUGINN_QUESTION>>>` … `<<<END_HUGINN_QUESTION>>>` containing JSON matching `QuestionItem[]` (question, header, options[{label, description}], multiple, custom). Huginn parses it out of the agent's output, removes it from the displayed text, presents it, and resumes the session in a follow-up turn with the chosen answer(s) — all runtimes, no protocol changes needed.
- **AC-37.2 (native channel preserved)**: opencode's `question.asked`/`permission.asked` path keeps working (gated by `permissions: ask`), and both paths produce the same `DecisionRequest` shape.
- **AC-37.3 (real options in the UI)**: `DecisionModal` renders `questionItems` — one row per option with its description — instead of only "accept the recommended option", and it keeps its natural height so no option is clipped by the frame. Keys: a digit `1`-`9` picks that option verbatim, `Enter` accepts the recommended one, `d` skips, `Esc` aborts; a key that matches nothing produces a visible hint rather than being swallowed. A block carrying several questions is asked **one modal at a time**, with a `(i/n)` counter, and each chosen answer is paired with its own question. *De-scoped in this iteration, recorded deliberately:* `multiple` (multi-select) and `custom` (free-text entry) are parsed but **not** honoured, and there is no arrow-key selection — a future iteration that needs them must amend this AC rather than assume it.
- **AC-37.4 (fail-closed & visible)**: an unparseable, oversized, unclosed or empty block is surfaced as a warning (with the raw payload sanitized and clipped) rather than dropped, and an unclosed block never truncates the rest of the reply; every block in the output is stripped, so no raw marker reaches the transcript; an options-less question degrades to accept-or-skip; and a pending question that goes unanswered aborts the turn after a bounded deadline instead of hanging.
- **AC-37.5 (portability)**: the protocol is documented for users (how to make their agent ask), and a shared contract test proves the parser works for a synthetic subprocess agent and that opencode's native path still routes through the same modal.

### REQ-38: Muninn Provisioning & Agent-Independent Memory
Muninn is Huginn's primary brain and its differentiator: memory must not belong to any agent.
- **AC-38.1 (one brain, many agents)**: the Muninn database is **project-scoped** (`<project>/.huginn/muninn.db`, resolved from the git root/remote — see ADR-20), never agent-scoped. Switching runtime, or running two different agents against the same project, must read and write the *same* memory; the engine must never key memory by `runtime.id`. This is asserted by a test that switches runtime mid-session and observes identical stats.
- **AC-38.2 (the user chooses the agents)**: the user decides which agents share the brain. `huginn setup --status` lists every supported agent with whether it is installed and whether it already registers Muninn (plus the exact fix command); the selection is `--agent <id1,id2|all>` (comma-separated; `all` is the default) and `--installed` **filters** that selection to the agents whose CLI is present (never widening it), reporting exactly which were skipped as not installed. An unknown name — alone or inside a list — is rejected with a non-zero exit.
- **AC-38.3 (registration mechanism)**: provisioning writes each agent's config through the existing hardened integrator (`registerMcpForTarget`: atomic, symlink-safe, unrelated keys and sibling servers preserved, `0o600`), which stays the **single** mechanism. *Verified decision (2026-09-28):* a native-first path was evaluated and rejected — `opencode mcp add` takes no command positional (it prompts interactively for a stdio server) and `commandcode mcp add` accepts only `url` for http, so neither is scriptable; only `claude`/`qwen`/`agy` could be driven non-interactively. Shelling out would therefore need per-CLI special cases for strictly less safety than the file writer the agents already read. A registration that already exists is a no-op, never a duplicate, and a config that cannot be parsed is reported rather than silently rewritten.
- **AC-38.4 (visible provisioning state)**: `huginn doctor` and the `/mcp` panel show a **provisioning matrix** — agent × (installed? · Muninn registered? · source of truth) — with the exact command to fix any gap (`huginn setup --agent <id>`).
- **AC-38.5 (profiles use the brain)**: every profile that audits or verifies — `huginn` above all — requires Muninn: the injected rules block mandates `muninn_context`/`muninn_inspect_symbol` before changes and `muninn_verify_contract` before final code, and a gate may not pass on a claim that contradicting Muninn evidence refutes.
- **AC-38.6 (safety & reviewability)**: provisioning is idempotent and preserves existing entries and unrelated keys. `--dry-run` computes the **identical** report (what would be registered, skipped as conflicting, and which rules files would change) and writes **nothing** — a preview must never mutate a third-party config. `--installed` guarantees an uninstalled agent is never touched; the bare default covers every registered target and says so in its usage text (it is the only mode that writes for absent agents, and it is explicit rather than implicit).

---

## 14. Non-Functional Requirements (Phase 7)
- **NFR-9 (MCP listing latency)**: `listMcpServers()` resolves within 5 s and never blocks the render loop; `claude mcp list` health-checks, so it is bounded and cancellable.
- **NFR-10 (No fabricated UI text)**: no MCP or profile surface may render `undefined`, `NaN`, or an unattributed count; a guard test asserts the literal tokens are absent from the built output of those surfaces.
- **NFR-11 (Config compatibility)**: profiles and the `gemini` removal are backward compatible with existing `.huginn/config.json` and `~/.huginn/config.json` files.

---

## 15. Authoritative CLI enumeration reference (verified on this machine)
| CLI | Command | Verified shape |
|---|---|---|
| opencode | `opencode mcp list` | box-drawing list: `● ✓ <name> connected` + command line; trailing `N server(s)` |
| claude | `claude mcp list` | `<name>: <command> - ✔ Connected` (health-checks; may be slow) |
| qwen | `qwen mcp list` | `<✓> <name>: <command> (<transport>) - Connected` |
| agy | `agy mcp list` | TSV table `NAME TYPE STATUS COMMAND/URL` (`enabled`/`disabled`) |
| commandcode | `commandcode mcp list` | table `NAME TYPE SCOPE AUTH STATUS` + `Total: N server(s)` |
| codex | `codex mcp list --json` | JSON document with per-server `enabled`/`discovered`/`auth_status` |
| devin | `devin mcp list` | `• <name>` rows with an indented `Command:`/`URL:` detail line; `✗ <name> (disabled)` marks a disabled server |
| mimo | `mimo mcp list` | opencode-style listing (its `mcp` container is opencode's own format) |
| omp / kimi / pi / cursor / mcode | *(none)* | config-file discovery, `status: "unknown"` |

---

# Spec: Huginn-Owned Cycle, Git Bootstrap, Per-Runtime Permissions & Persisted Live Sessions (Phase 8)

## 16. Executive Summary & Goals

Phase 8 removes the last dependencies the cycle had on *things outside the binary* and makes the live
session a durable artefact. Verified facts behind it: the cycle delegated its gates to slash commands
and subagents that had to be copied into `~/.config/opencode` (and that subprocess runtimes could not
resolve at all); `run`/`plan`/`live` refused to start in any directory that was not already a git
repository; a subprocess runtime had no way to answer a permission prompt, so `--permissions ask|deny`
silently ran it fully auto-approved; live conversations lived only in memory and were lost on restart
or on the handoff to the cycle (and a one-shot CLI saw no history at all); and the TUI hard-coded chalk
colour names — including a `color="white"` chat body that is invisible on a white terminal.

The implementation plan for this branch numbers its requirements `REQ-1`…`REQ-12` locally (the ids in
the source comments); this document keeps its own global numbering and records the local id next to
each requirement so both remain traceable.

### Goals
- **A pipeline huginn owns**: every step prompt is composed by huginn itself, so behaviour no longer
  depends on what is installed in the user's agent config.
- **No git prerequisite**: a directory outside every work tree is bootstrapped instead of rejected.
- **Honest permissions per runtime**: each subprocess CLI is launched with its own auto-approval flag,
  and `ask`/`deny` fail closed where they cannot be honoured.
- **Complete, current runtime support**: the registry reflects the CLIs that exist (Devin replaces
  Windsurf; MiniMax Code and MiMo Code join; kimi/pi/codex get their real non-interactive shapes).
- **A live session that survives**: persisted transcripts, resumable sessions, reattached opencode
  sessions, and a replayed transcript for runtimes with no history.
- **A legible console**: a semantic theme, a real composer (cursor + multiline), a context side panel
  and an empty-state hero.

### Non-Goals
- Re-implementing agent permission systems, or supporting `ask`/`deny` for a CLI that cannot ask.
- Changing the phase vocabulary, the pipeline-as-data model or the worktree sandboxing model.
- Storing live-session state inside `<project>/.harness/` (the handoff clears it).

---

## 17. Functional Requirements (Phase 8)

### REQ-39: Git Bootstrap Instead of a Hard Repository Prerequisite (plan REQ-5)
`run`, `plan` and `live` must accept any directory and make it usable as a huginn project.
- **AC-39.1 (Work-tree detection)**: membership is decided by `git rev-parse --is-inside-work-tree`
  (`probeGitRepo`/`gitRepoState`, `src/engine/diff.ts`), which returns one of `work-tree`,
  `not-a-repo` or `error`. A subdirectory, a linked worktree and a symlinked checkout all report
  `work-tree`; a bare repository and `.git` itself report `not-a-repo` (they have no work tree).
- **AC-39.2 (Fail closed on an unclassifiable path)**: a failure that is *not* git's own
  "not a git repository" (dubious ownership, permissions, git missing) is `error`: the command prints
  the reason and exits `1` **without** mutating the directory.
- **AC-39.3 (Bootstrap)**: `ensureGitRepository` (`src/engine/gitRepo.ts`) runs `git init -b main`,
  writes a default `.gitignore` when the project has none (`node_modules/`, `dist/`, `build/`,
  `.harness/`, `.huginn/`, `*.log`, `coverage/`, `.DS_Store`, `.env`), guarantees a committable
  identity (a missing **or empty** `user.email`/`user.name` is filled in with `--local`
  `huginn@localhost` / `huginn`, never touching the user's global config), and creates the bootstrap
  commit `chore: initialize repository` (`git commit --no-gpg-sign`, so a globally enabled
  `commit.gpgsign` cannot make onboarding fail) over `.gitignore`, so the engine always has a `HEAD`
  to diff against. The `.gitignore` write is name- and link-guarded: the path is `lstat`ed without
  following the final component (a pre-existing file — or a *dangling* symlink — is left strictly
  alone) and then created with the exclusive `wx` flag at mode `0o600`.
- **AC-39.4 (`--no-git-init`)**: with `--no-git-init` (a boolean flag) a non-repository exits `1` with
  the previous message (`"<path>" is not a git repository.`). A successful bootstrap prints a dim
  notice naming the branch, the `.gitignore` and the commit.
- **AC-39.5 (Onboarding consistency)**: `huginn init` reports git state through the same
  `isGitRepo()` predicate and stays informational (it prints a `git init` tip; it never initializes).

### REQ-40: The Cycle Owns Its Step Instructions (plan REQ-7)
No step may depend on an installed opencode slash command or subagent.
- **AC-40.1 (Embedded roles & instructions)**: the role texts and task bodies live in
  `src/engine/steps/instructions.ts` (inlined, never read from disk) and are composed per step by
  `src/engine/steps/prompts.ts`; `src/engine/steps/context.ts` provides the shared helpers
  (bounded file reads, git capture, untrusted-data embedding, the audit/fidelity verdict contracts),
  and `src/engine/steps/types.ts` defines `StepContext`.
- **AC-40.2 (One seam, plain prompts)**: `promptWithContext` (`src/engine/phases.ts`) is the only path
  a step takes: the composed text is sent as a **prompt** through the active `IAgentSession`, with the
  only `agent` ever named being opencode's built-in `build` (used by `EXECUTE` and the **application**
  half of every `FIX_*` phase; the architect's `DIAGNOSE` turn is a plain read-only prompt). No
  `runCommand` carries a huginn step, so a subprocess runtime behaves identically.
- **AC-40.9 (Brain vs. Hands)**: a blocked gate is never repaired by the thinker's tool loop. Attempt 1
  of a tactical gate (`FIX_VERIFY`/`FIX_TEST`) is applied directly by the executor from the console
  output and the judge's `actionItems`; an architectural gate or a repeat failure first runs
  `DIAGNOSE` on the thinker in read-only mode (same `treeHash` guard as the auditors) and the executor
  then applies its `Remediation Plan`. Each phase runs in its own clean session (`withPhaseSession`),
  closed when the step ends.
- **AC-40.3 (Single-report `VALIDATE_STEP`)**: `validateStep` runs ONE spec-auditor increment audit
  answering acceptance coverage and spec fidelity against the diff, ending on both mandatory
  `### Overall fidelity:` and `### Audit status:` lines. QA and security are not re-run here: they are
  their own phases (`TEST_MODULE`, `SECURE_CHECK`). The literal composition is `validateStepPrompt`.
- **AC-40.4 (Deterministic, fail-closed verdict)**: `computeValidateVerdict(report)` requires both
  conclusion lines (empty report or a missing marker → `blocked`; any blocked → `blocked`; any warning
  → `warning`; two green lines → `pass`). The whole-body fidelity fallback is only consulted when the
  report actually talks about fidelity, so an `### Audit status:` line cannot be read as a green
  fidelity verdict. `enforceValidateVerdict` rewrites the report's gate/handoff lines so exactly one
  coherent verdict remains, and the effective verdict travels structurally as `authoritativeVerdict`,
  which `CycleEngine` prefers over parsing the report text.
- **AC-40.5 (Read-only audit guard)**: the auditor phases (`SPEC_AUDIT`, `VALIDATE_STEP`,
  `SECURE_CHECK`, `REVIEW`) are marked `readOnly` in the pipeline; the engine hashes the working tree
  before and after the step (`treeHash`, `src/engine/receipts.ts`) and, when the signature is missing
  or changed, forces `blocked` (`readOnlyTreeViolation`), discarding the phase's own verdict.
- **AC-40.6 (Prompt injection containment)**: every repository-derived fragment embedded in a prompt
  (docs, git output, module names, reports) is bounded (60 000 characters, with an explicit truncation
  marker), terminal-sanitized, fence-neutralised and wrapped in a `<<<BEGIN/END UNTRUSTED-<nonce> …>>>`
  block whose nonce the content cannot guess. A `!`git …`` interpolation an embedded template carries
  is resolved by huginn through a subcommand allowlist (`diff`, `log`, `status`, `ls-files`, `show`),
  rejects write/exec flags, and supports only `head`/`sort` pipes.

### REQ-41: No Installer — Prompts Are Built In (plan REQ-8)
- **AC-41.1**: `src/setup/install.ts`, `scripts/postinstall.ts` and the `templates/` tree are removed,
  along with the `postinstall` script and the `HUGINN_TEMPLATES_DIR` override.
- **AC-41.2**: `huginn install` remains a known command and prints the no-op notice
  (`[huginn] agents and step prompts are built in; there is nothing to install.`) before exiting `0`
  (`src/commands/install.ts`), so a script calling it keeps working.
- **AC-41.3 (Shared primitives move, not vanish)**: the prompt seam lives in `src/util/prompt.ts`
  (`promptLine`/`promptYesNo` + `PromptIo`) and the opencode config dir resolver in
  `src/setup/opencodeConfig.ts` (`getOpencodeConfigDir`, honoring `HUGINN_OPENCODE_CONFIG_DIR`).

### REQ-42: Per-Runtime Permission Auto-Approval with Fail-Closed `ask`/`deny` (plan REQ-10)
A subprocess runtime closes stdin after the prompt, so it can never consult huginn mid-turn.
- **AC-42.1 (Per-runtime auto-approval flag)**: every subprocess runtime starts with the CLI's own
  switch (`SUBPROCESS_PERMISSION_ARGS` in `src/engine/agent/registry.ts`): `claude`
  `--dangerously-skip-permissions`, `codex` `--dangerously-bypass-approvals-and-sandbox`, `qwen` `-y`,
  `omp` `--auto-approve`, `commandcode` `--yolo`, `devin` `--permission-mode dangerous`, `agy`
  `--dangerously-skip-permissions`, `mcode` `--permission full`, `mimo` `--yolo`, `cursor` `-f`,
  `pi` `--approve` (announced as *assumed*: project-resource trust, not tool auto-approval), and
  **kimi no flag at all** (its prompt mode rejects every permission switch and forces its own auto
  mode). Each flag lives next to its adapter and the registry reuses the same array instance, so the
  table and the runtime cannot drift.
- **AC-42.2 (Fail closed)**: `assertPortPermissionModeSupported` makes `run`/`live` **exit 1** when
  `--permissions ask|deny` is requested for a runtime whose `capabilities.permissions` is `none`,
  naming it and the supported alternative; `LiveEngine.switchRuntime` refuses the same combination.
  An invalid `--permissions` value (e.g. `denn`) exits 1 instead of falling back to `auto`.
- **AC-42.3 (opencode keeps the native path)**: opencode honours `auto`/`ask`/`deny` through its
  native `RuntimePort`: the session's `onPermission` (built by `permissionHandlerFor`) answers the
  backend, and it is the only driver that declares `permissions: "interactive"`.

### REQ-43: Runtime Lineup — Devin, MiniMax Code, MiMo Code, and the Real CLI Shapes (plan REQ-11)
- **AC-43.1 (13 targets)**: `AGENT_TARGETS` is `cursor`, `claude`, `opencode`, `devin`, `qwen`,
  `codex`, `agy`, `kimi`, `pi`, `commandcode`, `omp`, `mcode`, `mimo`; `AGENT_BINARIES` declares each
  target's executable name(s), and `detectAvailableAgents()`/`resolveAgent()` scan them in registry
  order.
- **AC-43.2 (`windsurf` → `devin`)**: the target is renamed and gains a first-class
  `DevinRuntimeAdapter` — print mode (`-p --respect-workspace-trust false`) with the prompt passed via
  `--prompt-file`, `devin models list` for discovery and `devin mcp list` for MCP enumeration.
  `REMOVED_AGENT_TARGETS` maps `windsurf → devin` (and `gemini → agy`), so a stale config warns and
  falls through to detection.
- **AC-43.3 (`mcode` / `mimo`)**: `mcode` (MiniMax Code) is a single-shot CLI (`exec --input -`,
  `--permission full`) with **no** model listing and **no** `mcp` command — both honestly absent;
  `mimo` (MiMo Code) is the opencode-style one (`run` reads the prompt from stdin, `mimo models` and
  `mimo mcp list`, an opencode-format `mcp` container), with its registry path at
  `<home>/.config/mimocode/mimocode.json` and the project `.mcp.json` used for `mcode`.
- **AC-43.4 (`kimi` / `pi` / `codex`)**: the three adapters are wired to their verified non-interactive
  forms — kimi passes the prompt as the `-p <prompt>` flag value (no stdin channel, no
  `--prompt-file`, no permission flags) and discovers models via `kimi provider list --json`; pi uses
  `-p` with the prompt on stdin, `--model`, `pi --list-models` and the assumed (project-trust)
  `--approve`; codex passes the model with `-m` and enumerates servers with
  `codex mcp list --json` while exposing no model listing.

### REQ-44: Live Context, Persisted Sessions & Resume (plan REQ-1/2/4)
- **AC-44.1 (`sessionHistory`)**: `IAgentRuntime.sessionHistory` declares whether the backend keeps the
  conversation server-side — `true` for opencode only; every subprocess adapter declares `false`, and
  `undefined` is read as "does not keep history", so context is re-sent rather than silently dropped.
- **AC-44.2 (Bounded, delimited transcript)**: for a history-less runtime each turn carries a
  transcript of the conversation (`formatTranscript`) capped at 12 turns / 12 000 characters with an
  explicit omission marker, sanitized and wrapped in a non-forgeable
  `<<<BEGIN/END UNTRUSTED TRANSCRIPT-<nonce>>>` block; the current ask is never part of it.
- **AC-44.3 (Persisted sessions)**: the live conversation is written to
  `<project>/.huginn/live/sessions.json` (`src/state/liveSession.ts`) — never inside `.harness/` —
  atomically (exclusive temp + `renameSync`), mode `0o600`, the `live/` directory `0o700`, with every
  path component symlink-checked and the resolved directory contained in the project root. Caps:
  200 messages per session, 20 sessions per project, 20 000 characters per message, 8 MB for the whole
  store, enforced on **write** as well as on read (the store is shrunk to fit, announcing what it
  drops). Reads are fail-open: a missing/corrupt/oversized/linked file yields `[]` and a warning, and
  every field (including ids and timestamps) is terminal-sanitized on the way in and out.
  `<project>/.huginn/.gitignore` holds `*`, so the state never dirties the working tree.
- **AC-44.4 (The handoff does not wipe it)**: the reset that precedes the cycle handoff clears
  `.harness/` only; the live session survives, so a post-cycle conversation continues where it left
  off and the conversation view is rehydrated from the engine instead of going blank.
- **AC-44.5 (Resume flags)**: `--session <id>` is the strongest request, `--continue`/`-c` adopts the
  project's most recently updated session (saying so and starting fresh when there is none), and
  `--list-sessions`/`-sl` prints the stored sessions (id, `updatedAt`, runtime, message count, title)
  and exits `0` before any permission check, git bootstrap, runtime or TUI is touched. A bare
  `--session` with no id exits `1`. Without a flag a **new** session always starts.
- **AC-44.6 (Reattach)**: a resumed conversation reattaches to its stored `opencodeSessionId` when that
  session still exists on the server (probed through the client), so the prior turns come from the
  server rather than being replayed; when it is gone the transcript is replayed instead, and the
  outcome is announced rather than silently ignored.

### REQ-45: Onboarding Model Picker (plan REQ-9)
- **AC-45.1**: step 4 of `huginn init` asks the chosen runtime for its catalog (`getModelCatalog()`,
  through the shared `discoverModelCatalog` helper so the wizard and `ModelPickerModal` cannot drift)
  and presents a **numbered picker** of `provider/model` ids (with the catalog description when one
  exists).
- **AC-45.2**: a current value is preserved as the preselection — a real catalog id is used as-is and
  an explicit `--thinker`/`--executor` flag the catalog does not list is kept verbatim, so pressing
  Enter never silently overrides it; a default absent from the catalog seeds from the catalog
  (thinker → first model, executor → second) so the two pickers do not land on the same model.
- **AC-45.3 (Honest fallback)**: with no catalog (or an empty one carrying a `reason`) the wizard falls
  back to plain text entry and prints the sanitized reason, so a runtime that cannot list models is
  never a dead end.

### REQ-46: Composer with a Cursor and Multiline Growth (plan REQ-6)
- **AC-46.1**: the live composer is a real editor: `←`/`→` move the caret by character (word-wise with
  `⌥`/Ctrl), `Home`/`End` jump to the ends of the caret's *visual* row, `Backspace`/`Delete` act at the
  caret (word-wise with `⌥`/Ctrl), and typed text is inserted at the caret
  (`src/tui/composer.ts` + `LiveDashboard`'s `useInput` handlers).
- **AC-46.2**: the draft soft-wraps and grows up to `MAX_INPUT_ROWS = 6` rows, after which the composer
  scrolls internally; the caret is painted inside the row (`cursorLineParts` draws the `▏` glyph in a
  free column and over the character it covers when the row is full), so no content is pushed off the
  row and the frame budget is unchanged.

### REQ-47: Semantic Theme, Live Context Panel & Empty-State Hero (plan REQ-12)
- **AC-47.1 (Theme tokens)**: `src/tui/theme.ts` exposes one semantic palette (`text`, `muted`,
  `border`, `borderFocus`, `accent`, `ok`, `warn`, `danger`, `info`, `thinker`, `executor`, `system`,
  `brand`) which every TUI component reads instead of a chalk colour name; no `color="white"` remains.
  Modes are `light`, `dark` and `auto` (default, memoised on the raw environment), pinned with
  `HUGINN_THEME`; `auto` never assumes a dark background (it uses the legible palette and sniffs
  `COLORFGBG` when present), and a non-empty `NO_COLOR` clears every token and gates `dimColor`.
- **AC-47.2 (Live context panel)**: `src/tui/InfoPanel.tsx` renders a compact **LIVE CONTEXT** column
  beside the conversation on wide terminals (≥ 100 columns, ≥ 8 spare rows, leaving the cards at least
  44 columns). Its rows are grouped into `SESSION` (agent, MCP badge, conversation size),
  `REPO` (git branch/tree state and worktree sandbox) and `MEMORY` (Muninn counts) sections, plus one
  stage-appropriate tip anchored to the bottom of the box by a flexible spacer. A section with no data
  is not drawn at all — `slicePanelLines` keeps a header only while a row follows it — so no heading
  is left over an empty group. It lives inside the region the cards already own, so it can never push
  the composer, palette or footer off the frame; narrower terminals do not render it at all.
  `test/tui/infoPanel.test.ts` covers the geometry, the section order, the anchored tip, the clipping
  of a hostile value and the rows the panel must not invent (AC-30.5). *(Amended by AC-77.2: the
  live stage is no longer a panel row; it lives in the header badge.)*
- **AC-47.3 (Empty-state hero)**: `src/tui/LiveHero.tsx` renders the raven brand plus the first-run
  guidance inside the conversation card when the conversation is empty, sharing the header's art
  (`buildRavenArtRows`, REQ-29) and the console's hint list (`EMPTY_CHAT_HINTS`), sliced to the rows
  the card really has.
- **AC-47.4 (Session summaries, no fabrication)**: `src/tui/sessionContext.ts` derives the panel's
  environment strings from what the engine reported — a counter with nothing to count renders
  `""` rather than `0`, and an unreadable Muninn database reports its sanitized error instead of
  looking empty (AC-30.5). The summaries carry no colour; the TUI picks the token. *(Amended by
  AC-77.2: the header no longer repeats these summaries.)*

### REQ-48: Containment of repository-controlled input (plan item 10)

Nothing a repository controls may reach a file, a program or an instruction channel unfiltered.
- **AC-48.1 (Delimited, bounded prompts)**: every repository-derived fragment embedded in a prompt is
  sanitized, fence-neutralised, capped at `MAX_EMBEDDED_OUTPUT` (60 000 characters, with an explicit
  truncation marker) and wrapped in a `<<<BEGIN/END UNTRUSTED-<nonce> …>>>` block whose nonce is fresh
  per block (`embedUntrusted`, `src/engine/steps/context.ts`), which the architecture-drafting prompts
  of `plan` mode reuse (`untrustedBlock`, `src/engine/planMode.ts`).
- **AC-48.2 (Document paths)**: every document read or write goes through `checkDocPath`/`assertDocPath`
  (`src/util/docPath.ts`). A **symlinked final component is always refused** (never followed, read or
  overwritten, including for an explicitly configured out-of-project path); when the path is lexically
  inside the project root, its `realpath`ed form must stay inside the `realpath`ed root (so a symlinked
  *parent* is caught too); a path that does not exist yet is decided on its nearest existing ancestor.
- **AC-48.3 (Hardened git)**: every `git` invocation is prefixed with
  `--no-pager -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=/dev/null`
  (`GIT_GLOBAL_HARDENING`); diff-producing subcommands additionally receive
  `--no-ext-diff --no-textconv` immediately after the subcommand **and** at the end of the option argv
  (last-one-wins protection, SEC-001b); the bounded runner (`gitBounded`) enforces a subcommand
  allowlist (`status`, `diff`, `log`, `show`, `ls-files`, `rev-parse`) and rejects
  `-c`, `--output`, `--exec-path`, `--upload-pack`, `--config-env`, `--git-dir`, `--work-tree`,
  `--no-index`, `--ext-diff`, `--textconv` and `-O` (`FORBIDDEN_GIT_ARG`, `src/engine/diff.ts`).
- **AC-48.4 (Persisted identities)**: a stored live-session id must match `LIVE_ID_PATTERN`
  (1–128 characters of `[A-Za-z0-9._:-]`, at least one alphanumeric) or the session is dropped, and
  every identity field is terminal-sanitized on the way in and out (AC-44.3, AC-44.6).

---

## 18. Non-Functional Requirements (Phase 8)
- **NFR-12 (Deterministic gates)**: a huginn-run gate's verdict is computed by huginn, not read from
  the model's prose (`authoritativeVerdict`), and a read-only phase that mutated the tree can never
  pass (`readOnlyTreeViolation` fails closed on a missing signature too).
- **NFR-13 (Bounded prompts)**: no repository-derived fragment enters a prompt unbounded — file reads
  are capped at 60 000 characters (and read through a regular-file check so a FIFO/device is refused),
  git captures have a 4 s timeout and a byte ceiling, and the transcript is capped at 12 turns /
  12 000 characters.
- **NFR-14 (Durable, contained live state)**: live sessions survive restarts and handoffs, are written
  atomically with owner-only permissions, are capped in messages/sessions/characters/bytes on both the
  read and the write path, are refused through a symlinked path, and never appear in `git status`.

---

# Spec: Run Integrity, Honest Surfaces & a Coherent Terminal Language (Phase 8)

## 19. Executive Summary & Goals

A real `huginn run` on a five-iteration project completed iteration 1, produced four commits in its
sandbox, then reported `🛑 ABORTED` with an **empty project directory**. The work was neither lost nor
incomplete — it was stranded on `huginn/task-iter-1` by a promotion failure the run surfaced as an
abort. The same run left a `projects` row for *huginn itself* in the project's Muninn database, and
the dashboard's output panel stayed at `(waiting for agent stream / tool executions...)` for the whole
run because the active runtime has no event channel. Phase 8 fixes the integrity bugs first, then
makes every surface tell the truth.

### Goals
- A completed iteration's work is never silently stranded or discarded: a failed integration is
  recoverable, non-destructive, and reported as what it is.
- One project root governs Muninn — the `--project` root selects both the database file and the
  project record, so a runtime can never attribute one project's data to another.
- The run dashboard never shows a dead panel: a runtime that cannot stream shows the phase's real
  report, and an idle raven state otherwise.
- One semantic, single-width glyph language for phase status across the TUI and `.harness/PROGRESS.md`.
- The raven's presence follows the run — a mood, a one-row brand rung and a stage-tinted conversation
  — and the frame never reserves rows for chrome that is not on screen.
- Sessions and methodology profiles are discoverable and selectable in-session.

### Non-Goals
- Real-time token streaming from subprocess runtimes (a PTY/incremental channel); the fallback is the
  per-phase report, not live tokens.
- Changing the gate marker literals (`### Overall gate: 🟢/🟡/🔴`) — they are a three-way contract.
- Retroactively repairing mis-attributed databases; the fix prevents the mis-attribution and `doctor`
  reports it.

## 20. Functional Requirements (Phase 8)

### REQ-49: A completed iteration is never stranded or silently discarded
- **AC-49.1 (Collision resolution, non-destructive)**: before integrating a sandbox,
  `promoteSandbox` (`src/engine/worktree.ts`) detects the paths that would be overwritten because they
  are **untracked in the primary tree** (`git ls-files --others --exclude-standard` ∩
  `git diff --name-only <base>..<branch>`) and backs each one up to
  `<project>/.huginn/promotion-backup/<stamp>/<relPath>` (content and mode preserved) before removing
  the working-tree copy so the integration can proceed.
- **AC-49.2 (Recoverable failure)**: when neither `merge --ff-only`, `merge --no-ff` (a merge-commit
  range) nor `cherry-pick` integrates the branch, the primary tree is restored to its pre-promotion
  state — every backed-up file is put back — and the branch `huginn/task-iter-<N>` is **preserved**
  (never deleted) for manual recovery.
- **AC-49.3 (Honest outcome)**: a promotion failure is recorded structurally as
  `state.promotion = { status: "conflict" | "failed", branch, backups?, detail? }` and is **not**
  reported as an abort; `renderProgressMarkdown` renders a promotion failure distinctly and names the
  preserved branch, and `🛑 ABORTED` is reserved for a genuine abort.
- **AC-49.4 (Backups reported)**: a successful integration that moved local changes aside — untracked
  files **or** tracked files with staged/unstaged modifications — returns the backup directory in
  `PromoteResult.backups`, logs it, and records a `manifest.json` inside it, so the files (and a
  tracked deletion) are discoverable.
- **AC-49.5 (Deterministic recovery)**: `huginn promote --retry` (and `[t]` in the live post-cycle
  prompt) reopens the preserved branch at the iteration's **integration base** — the merge base with
  the primary HEAD or `state.iterationBaseCommit`, never the branch tip — and re-runs the same
  integration with **no model turn**. On success it indexes the symbols, records the iteration in
  Muninn, advances `state.currentIteration` and clears the resume cursor; on failure it keeps the
  branch and the primary tree untouched. An adopted sandbox (`attachSandbox`) promotes from that same
  base, so a resumed iteration's commits are integrated rather than discarded.
- **AC-49.6 (Conflict-only assisted repair)**: `huginn promote --repair` (and `[p]`) is offered only
  when `state.promotion.status === "conflict"`; a `failed` record names the index problem and points
  at `--retry` instead. The repair merges the primary HEAD into the preserved branch inside a
  worktree with `--no-commit --no-ff`, diagnoses on the thinker (read-only, discarded on a working-tree
  mutation), applies on the executor with `agent: "build"`, commits the merge only when no conflict
  markers or unmerged paths remain, runs the iteration's `Verification:` commands in that worktree and
  promotes only on a passing verdict. It makes **one** attempt: a failure aborts the merge (or resets
  the branch to its pre-merge tip) and preserves the branch. The recovery options are advertised to
  every surface through `DecisionRequest.choices`, and an option a request did not offer is a no-op.

### REQ-50: One root for Muninn — the database and the project record agree
- **AC-50.1 (One root)**: the database file and the project row are resolved from the same root: the
  `--project` root when given, otherwise the git root of the process's start directory.
  `getDatabase(dbPath?, startDir?)` forwards `startDir` to `resolveDatabasePath`, and `MemoryService`
  opens the database with the same `projectRoot` it uses for `ensureProject`.
- **AC-50.2 (No cross-project writes)**: running a Muninn command (`mcp run`, `memory index/search/
  sync`) with `--project X` from a working directory inside `Y` writes to `X/.huginn/muninn.db` and
  creates only `X`'s project row; nothing is written into `Y`'s database.
- **AC-50.3 (Diagnosis, not destruction)**: `huginn doctor` reports foreign `projects` rows in the
  project's database (a `root_path` that is not the project root) with the exact fix, and deletes
  nothing.

### REQ-51: The run output panel is never dead
- **AC-51.1 (Report fallback)**: when no stream content has arrived and a phase has finished, the
  `run` dashboard renders the tail of that phase's real report text instead of a waiting placeholder.
- **AC-51.2 (Idle raven state)**: when nothing has arrived and no phase has finished, the panel renders
  a small two-raven ASCII composition (Huginn and Muninn) beside a rotating raven-voiced phrase,
  clipped to the card's rows.
- **AC-51.3 (Honest capability)**: the panel states the active runtime and that live streaming depends
  on it — the note appears only for runtimes that cannot stream, driven by a capability flag on
  `IAgentRuntime` rather than a hardcoded id list.
- **AC-51.4 (Layout discipline)**: the idle/report body never exceeds the card's allocated rows at
  80×24; nothing is fabricated to fill a row.

### REQ-52: A single semantic glyph language for phase status
- **AC-52.1 (One table)**: every phase/status glyph is defined once (`src/tui/glyphs.ts`) and consumed
  by both the TUI and `.harness/PROGRESS.md`.
- **AC-52.2 (Single width)**: the glyphs are printable, single-width characters (ASCII/box-drawing) —
  no emoji in the pipeline grid, the status column, the last-result pill or the phase rows of
  `PROGRESS.md`.
- **AC-52.3 (Contract preserved)**: the gate marker literals and the verdict parsers are untouched; a
  drift-guard test asserts the rendered display strings contain no emoji while the gate literals remain
  present in the engine sources.
- **AC-52.4 (Theme intact)**: glyph colour still resolves through the semantic theme tokens, and
  `NO_COLOR` behaviour is unchanged.

### REQ-53: Sessions are a documented surface in `--help`
- **AC-53.1 (A Sessions section)**: `huginn --help` explains the live-session store
  (`<project>/.huginn/live/sessions.json`), the three flags (`--continue`/`-c`, `--session <id>`,
  `--list-sessions`/`-sl`) and their precedence, and the reattach semantics.
- **AC-53.2 (Concise help points to it)**: `huginn --help` (concise) names the section, and the
  drift guard asserts every token it advertises exists in the full reference.

### REQ-54: Methodology profiles are selectable in-session
- **AC-54.1 (Picker)**: `/profile` opens a picker listing every profile from `PROFILES` with its
  display name, one-line description and an active marker; `↑/↓`/`j`/`k`, `Enter`, `Esc`.
- **AC-54.2 (Direct set, fail closed)**: `/profile <id>` validates against `PROFILE_NAMES` and fails
  closed with an actionable message on an unknown id, changing nothing.
- **AC-54.3 (Persisted scope)**: a change can be kept for the session, the project
  (`.huginn/config.json`) or globally (`~/.huginn/config.json`), through the existing config writers.
- **AC-54.4 (No silent no-op)**: after the build has handed off to the cycle, the console states that
  the new profile applies to the next cycle.
- **AC-54.5 (Discoverable)**: the command registry, the cheat sheet and the live context panel all
  surface the profile.

## 21. Non-Functional Requirements (Phase 8)
- **NFR-15 (Never destroy uncommitted work)**: no promotion or cleanup path may delete a user file, an
  iteration's commits, or a preserved branch without an explicit, reported backup.
- **NFR-16 (Attribution integrity)**: a Muninn database may contain rows only for the projects that
  resolved to it; a foreign row is a diagnosed defect, never a silent side effect.
- **NFR-17 (Honest surfaces)**: no surface reports a success, an abort, or an emptiness the engine did
  not actually produce — a stranded iteration, a foreign row and a dead panel are all named.


## 22. Functional Requirements (Increment Execution)

This section closes the gap between “the plan has iterations” and “every iteration is a usable,
testable increment”. It is deliberately about *how* huginn plans, verifies and persists an iteration,
not about adding another methodology profile.

### REQ-55: Plan drafting produces runnable, testable increments
- **AC-55.1 (Increment contract)**: `planPrompt` and `remainingPlanPrompt`
  (`src/engine/planMode.ts`) carry the shared `INCREMENT_CONTRACT`: every iteration delivers
  observable behavior, leaves the app runnable and the tests green, has no forward dependency, and
  the first iteration includes the smallest runnable hello-world of the product.
- **AC-55.2 (Machine-readable sections)**: the plan output contract requires `**Goal:**`,
  `**Acceptance criteria:**` (one or more `- [ ]` items) and a fenced `**Verification:**` block with
  one non-interactive command per line. `parsePlan` extracts them into
  `Iteration.goal`/`acceptanceCriteria`/`verification` and keeps the body as the verbatim executor
  prompt.
- **AC-55.3 (Draft validation)**: `validateDraftFormat("plan", …)` rejects a newly drafted plan whose
  iterations lack any of the three sections. Plans already on disk without them remain loadable and
  executable.
- **AC-55.4 (Execution sees the contract)**: `executePrompt`, `testModulePrompt` and the QA audit
  prompt include the goal, criteria and verification commands, wrapped as untrusted plan data.

### REQ-56: Verification is deterministic, not a model opinion
- **AC-56.1 (A real phase)**: the `VERIFY` phase (`src/engine/verify.ts`, `verifyIteration`) runs the
  iteration's `Verification:` commands inside the sandbox and gates on their real exit codes, with a
  per-command deadline and process-group termination.
- **AC-56.2 (Blocking and fixing)**: a non-zero exit or timeout makes the phase `blocked`, and the
  `FIX_VERIFY` turn receives the report. A pass requires every command to exit 0.
- **AC-56.3 (Compatibility and opt-out)**: a plan with no `Verification:` section passes with an
  explicit note. `--no-verify` / `"verify": false` disables execution without failing the run.
- **AC-56.4 (Every profile)**: `huginn`, `sdd`, `odd`, `rdd` and `strict-tdd` all run `VERIFY` before
  `COMMIT_ALL`; `strict-tdd` runs it after its second `TEST_MODULE`.
- **AC-56.5 (No silent no-op)**: the phase writes a report under `.harness/reports/`, including each
  command, its exit code, duration and the bounded stdout/stderr.

### REQ-57: A successful iteration is an atomic, durable increment
- **AC-57.1 (Checkpoint before promotion)**: `COMMIT_ALL` is deterministic by default (REQ-63) and
  commits through the same hardened `commitAllPending` seam; after the phase loop and before
  promotion, `WorktreeManager.commitPendingChanges` still commits anything left uncommitted — the
  checkpoint is the backstop for `commit: "agent"`, not a second commit path.
- **AC-57.2 (Never discard uncommitted work)**: a sandbox with uncommitted changes and no commits is
  a failed promotion; the worktree is preserved and named in the error instead of being deleted.
- **AC-57.3 (Stop means last functional state)**: aborting or stopping mid-iteration discards the
  sandbox and leaves the primary tree at the last promoted increment. `--no-sandbox` warns that it
  cannot offer this guarantee.
- **AC-57.4 (Harness-authored commit)**: the checkpoint uses `GIT_AUTHOR_*`/`GIT_COMMITTER_*` and
  `--no-gpg-sign`, so a missing identity or signing key cannot lose the increment; the hardened
  `git()` seam still refuses user-supplied `-c`.
- **AC-57.5 (Tracked local changes are parked, not silently overwritten)**: before integration,
  `promoteSandbox` also parks tracked primary-tree paths that the branch changes and that have staged
  or unstaged modifications: the user's content (or deletion) is backed up under
  `.huginn/promotion-backup/<stamp>/` with a `manifest.json`, and the index/worktree is reset to
  `HEAD` so `git merge`/`git cherry-pick` can proceed. A successful promotion names the backup in the
  run log and the live post-cycle prompt.
- **AC-57.6 (Exact rollback, fail closed on partial staging)**: when integration still conflicts,
  every parked tracked file is restored with its content/mode and its staged/unstaged state
  (`git add` / `git rm --cached`). A partially staged file or a staged *new* file is refused
  (`failure: "failed"`, branch preserved) instead of guessing its index state.

### REQ-58: The native pi driver reports its own MCP servers
- **AC-58.1 (Port surface)**: `RuntimePort` exposes optional `listMcpServers()` and `mcpStatus()`;
  `toRuntimePort` forwards them for the CLI-only targets, and a driver that cannot see MCP (or omits
  them) still yields `unverified: true` through `fetchMcpStatusWithTimeout`, never a fabricated
  healthy report.
- **AC-58.2 (Real listing + fast fallback)**: the pi driver runs `pi mcp list --json` in the project
  directory (bounded), parses `{ servers: [{ name, state, transport, scope, source, tools }] }` and
  maps `connected`/`disabled`/`error`/`pending` honestly; `mcpStatus()` reads
  `~/.pi/agent/mcp.json` and `<project>/.pi/mcp.json` as the config fallback.
- **AC-58.3 (Badge truth)**: `reportFromListings` sums the reported tool counts, so the badge can say
  `MCP: 🟢 2 connected (214 tools) · pi`; config-only discovery says `⚪ n configured`, never `none`
  while pi has servers, and a failed server is `🟡 error` (degraded), never live.
- **AC-58.4 (Timeout honesty)**: when a slow listing outruns the poll, `fetchMcpStatusWithTimeout`
  uses the reserved budget for config discovery instead of showing a bare timeout.

### REQ-59: Agent-owned resources are documented, not proxied
- **AC-59.1 (`pi` in-process)**: the README/AGENTS documentation states that the pi SDK's resource
  loader supplies pi's own MCP config, skills and `AGENTS.md`; huginn observes and reports them but
  does not re-declare or re-connect them.
- **AC-59.2 (Subprocess runtimes)**: the same documentation states that each CLI loads its own
  resources, and that huginn's `.huginn/skills`/`.opencode/skills` are a live-console feature and are
  not injected into the pipeline prompts.

---

## Phase 9 — Turn budget

An iteration must not pay the expensive model, or a second model, for work that a deterministic
checker or the role itself can settle. The clean `huginn` iteration costs **7 turns on the first
iteration and 6 afterwards** (down from 14).

### REQ-60: Each audit verdicts itself; the judge runs only when it can act
- **AC-60.1 (Own status line)**: `TEST_MODULE`, `SECURE_CHECK` and `REVIEW` end on exactly one
  `### Audit status: 🟢 PASS | 🟡 WARN | 🔴 BLOCKED` line (`auditStatusContract()`), with the role's
  illustrative skeleton explicitly not a template.
- **AC-60.2 (On-demand judge)**: `gateDecision` (`src/engine/cycle.ts`) skips `judgePhase` when the
  marker is `pass`; it runs for `warning`/`blocked` (to extract structured `actionItems`) and for a
  missing marker (fail closed). A non-blocking test-first run never judges.
- **AC-60.3 (Under-report screen)**: `parseAuditGateVerdict` escalates the marker only from the exact
  gate vocabulary (`### Overall gate:` and the three handoff phrases), never from bare emoji that every
  role template ships (REV-102). A report may never downgrade its own marker.
- **AC-60.4 (Structural precedence)**: huginn's `forcedVerdict`/`authoritativeVerdict` still outranks
  the marker, and the `audit-status` gate never writes `authoritativeVerdict`.

### REQ-61: `VALIDATE_STEP` is one increment audit
- **AC-61.1 (One prompt)**: `validateStep` issues exactly one prompt (`validateStepPrompt`) and
  `computeValidateVerdict(report)` merges its two mandatory markers.
- **AC-61.2 (No duplicated phases)**: qa and security are not re-run inside `VALIDATE_STEP`; their
  phases own them.
- **AC-61.3 (Debuggable)**: `--only-phase VALIDATE_STEP` runs exactly that one prompt.

### REQ-62: The whole-document spec audit runs once per cycle
- **AC-62.1 (Hash guard)**: `specAuditNeeded` consults `state.specAudit.docHash`
  (`computePlanHash([spec, adr, plan])`); greenfield skips, the first iteration audits, a changed
  contract re-audits, `--only-phase SPEC_AUDIT` forces it.
- **AC-62.2 (Never launder a failure)**: only a `pass`/`warning` audit is memoized; a blocked audit is
  always re-run.
- **AC-62.3 (Honest skip)**: a skip records `verdict: "skipped"` with the reason and short hash in the
  history and the log, does not touch `phaseAttempts`, and is counted as done by receipts/PROGRESS.

### REQ-63: `COMMIT_ALL` is deterministic by default
- **AC-63.1 (No model turn)**: `commitAllDeterministic` derives
  `feat|fix|docs(<scope>): <subject>` and a `Harness iteration N/M (<profile>).` body from the
  iteration and the changed paths; no plan text enters the permanent history.
- **AC-63.2 (One hardened seam)**: it and the pre-promotion checkpoint both call `commitAllPending`
  (harness identity, `--no-gpg-sign`, no `-c`); a git failure is reported in the phase and re-attempted
  by the checkpoint, which fails closed.
- **AC-63.3 (Opt-in agent commit)**: `ProfileSpec.commit`, `.huginn/config.json` and `--commit agent`
  restore the model-authored semantic grouping; `pendingChanges` passes `-uall` so a new directory
  yields its files.

### REQ-64: Architectural decisions live in memory
- **AC-64.1 (ADR → decision)**: `plan` and `live` persist every `## ADR-N` section as an
  observation with `category: "decision"` and `topicKey: "adr-<n>"`, through
  `src/engine/memory/adr.ts`.
- **AC-64.2 (Idempotent)**: re-saving the same ADR updates the single row instead of duplicating it
  (the schema has no unique `topic_key`, so the upsert deletes and re-inserts inside one transaction;
  the FTS index and entity links follow).
- **AC-64.3 (Read containment)**: the ADR file is read through `readFileBounded` (symlink and
  project-escape screened), and only file paths the indexer already knows are linked.
- **AC-64.4 (Backfill)**: `huginn memory decisions [--adr …] [--dry-run]` seeds an existing ADR file, resolving the conventional name case-insensitively (`adr.md`, then `ADR.md`).

### REQ-65: Each promoted increment is curated
- **AC-65.1 (One observation)**: after a successful promotion (and after in-place indexing) huginn
  writes one observation keyed `iter-<n>` containing the goal, acceptance criteria, verification
  commands, changed files, the verdict map and the commit.
- **AC-65.2 (Category)**: a clean increment is `architecture`; one that needed a warning or a skipped
  phase is `discovery`.
- **AC-65.3 (Fail-open)**: a memory failure never fails the iteration or the promotion, and a skipped
  curation is only reported under `HUGINN_DEBUG`.

### REQ-66: Prompts receive bounded, retrieved context
- **AC-66.1 (Retrieval)**: `EXECUTE`, `SPEC_AUDIT` and `VALIDATE_STEP` receive
  `retrieveIncrementContext`: recent decisions, observations matched by short BM25 queries plus the
  ones linked to the iteration's modules, and the module symbols — capped at ~8 KB and wrapped as
  untrusted data.
- **AC-66.2 (Read-only safety)**: retrieval requires an explicit `dbPath` and refuses a missing
  database; it never calls `resolveDatabasePath` and never creates the file.
- **AC-66.3 (Plan audit bound)**: `SPEC_AUDIT` embeds the plan's iteration index plus the current
  increment (≤24 KB), with the bounded whole-file embed as the fallback.
- **AC-66.4 (Kill switch)**: `HUGINN_MEMORY=0` disables retrieval; writers are unaffected.

### REQ-67: One runtime port for every driver
- **AC-67.1 (Engines consume the port)**: `CycleEngine`, `LiveEngine`, the judge and every phase
  call `session.prompt(request)` on a `RuntimePort` `RuntimeSession`. A legacy `IAgentRuntime`
  passed by a test or embedder is bridged once, at construction (`asRuntimePort`).
- **AC-67.2 (Native opencode driver)**: `drivers/opencode.ts` owns one SSE subscription, fans
  text/reasoning/tool/usage events to the sessions that own them, answers permissions through
  `onPermission` (deny when absent, auto only when the run asked) and questions through
  `onQuestion`, and exposes `start`/`endpoint`/`resumeSession`/`probeSession`/`abortSession`.
- **AC-67.3 (One event mapper)**: `src/engine/runtimeEvents.ts` is the only `RuntimeEvent → engine
  bus` mapping; a one-shot driver's single text event is suppressed and `done` emits nothing.
- **AC-67.4 (Usage telemetry)**: a driver that reports tokens/cost emits `usage`; the engine
  accumulates `state.usage`, `PROGRESS.md` and both footers render it only when measured.
- **AC-67.5 (No reverse bridge)**: `toLegacyRuntime`/`getEngineRuntime` are gone;
  `getRuntimePort`/`getEnginePort` is what executes and `getAgentRuntime` remains the CLI-shaped
  provisioning/argv view. `legacyCapabilities` never claims streaming or structured events.

### REQ-68: The decision modal and feedback channel share the single-width alphabet
- **AC-68.1 (One decision table)**: `DECISION_GLYPHS` (`approve` `+`, `question` `?`, `warn` `!`,
  `done` `*`) lives in `src/tui/glyphs.ts`, and `decisionGlyph(kind)` resolves every `DecisionKind`
  to one of its marks. Each entry is a single printable, single-column, **ASCII** code point
  (code point ≤ `0x7f`) and is covered by the same guardian test as `STATUS_GLYPHS`. The marks are
  deliberately non-letter characters, so they cannot collide with the modal's `[a]`/`[d]` hints.
- **AC-68.2 (Pure title)**: `DecisionModal` composes its title with the exported pure function
  `decisionTitle(req: DecisionRequest): string` in `src/tui/decision.ts`; every `DecisionKind`
  (approve, scope failure, draft format, cycle finished, question, permission, spec deviation,
  gate) has an explicit title in an exhaustive `switch`, so a new kind cannot inherit the gate
  wording. All title kinds render without an emoji code point.
- **AC-68.3 (One feedback voice)**: `FEEDBACK_WARN` is `!`, `FEEDBACK_OK` is `✓` and `FEEDBACK_BUSY`
  is `…`; the feedback channel no longer uses a double-width warning sign anywhere in `src/tui/`,
  `test/tui/`, or the TUI interface sections of `README.md` and `DESIGN.md`.
- **AC-68.4 (Drift guard)**: a render test mounts `DecisionModal` for every title kind and fails if
  the title line contains `\p{Extended_Pictographic}` or if `stringWidth(line) !== line.length`.
- **AC-68.5 (Contracts untouched)**: the `### Overall gate:`/`### Overall fidelity:` literals, the
  producer stream markers (`⚡ ✓ ✗ 💭`), the engine/CLI warning outputs (including the
  `⚠️ REVIEW REQUESTED` handoff line, `HANDOFF_LINE_RE`, both verdict parsers and their fail-closed
  fallback) are all unchanged. Only huginn's own TUI display and feedback glyphs move.

### REQ-69: The decision modal buys only the rows it can pay for
- **AC-69.1 (Exact height)**: the modal's policy lives in `src/tui/decision.ts`:
  `decisionModalHeight(req?, maxRows?)` returns the exact number of rows `DecisionModal` paints,
  double border included, and `DECISION_MIN_ROWS` (5 = two border rows + one title + one body row +
  one key row) is the structural floor a dashboard reserves before a decision exists.
  `decisionBodyRowSpecs` and `decisionKeyRowSpecs` expose one plain entry per terminal row (rendered
  by `decisionBodyRows`/`decisionKeyRows` in `src/tui/DecisionModal.tsx`), so a newline in a message
  cannot steal a row the layout did not count. Neither dashboard imports the other's page module for
  the modal.
- **AC-69.2 (Frame budget)**: both dashboards derive `decisionMaxRows` from the rows left after
  their own fixed chrome (header, composer/footer, log tail, open palette, card floor) and pass it
  to the modal. The modal never paints more than that budget: it pays the double border, the title
  and the key footer first, buys the `… +N · ↑/↓` indicator only while a body row still fits, and
  windows the rest. A capped budget below `DECISION_MIN_ROWS` paints nothing at all — a title without
  the key footer would say what happened but not what to press.
- **AC-69.3 (Hidden rows are reachable)**: a windowed body scrolls with `↑`/`↓`, and the indicator
  names how many body rows are hidden. The live dashboard consumes those keys while a decision is
  open, so a scroll never resolves the decision or echoes "press a number"; a digit still answers
  the first question verbatim after scrolling.
- **AC-69.4 (Footer survives)**: a pending decision no longer pushes the composer or the footer off
  a short terminal. `test/tui/liveLayout.test.ts` and `test/tui/dashboard.test.ts` mount a tall
  question on 18- and 24-row frames and assert the frame's row count, the modal title and the key
  footer.
- **AC-69.5 (Drift guard)**: `test/tui/decisionModal.test.ts` compares `decisionModalHeight` with
  the rows Ink actually paints for every decision kind — a request that fits, one that must window,
  and budgets below the documented floor (which must draw nothing) — so a height literal can never
  drift from the real cost.

### REQ-70: Cards declare one chrome hierarchy and its exact cost
- **AC-70.1 (One cost table)**: `CARD_CHROME` and `cardChrome(tone)` live in `src/tui/Card.tsx`.
  `primary` and `secondary` each spend two border rows, one title row and four columns (a border
  plus `paddingX={1}` on each side); `tertiary` spends one title row and two columns for its `│ `
  rule, with no box at all. `rows` includes the title row, so a card that renders no title
  (`InfoPanel`) reserves `borderRows`, not `rows` — the declared cost is exact only when the card
  draws the title it paid for. The table is scoped to the card surfaces: the decision modal's
  double border now comes from the shared modal frame's `alert` tone (`Modal.tsx`), while the
  composer, palette and header borders keep their own labelled constants.
- **AC-70.2 (Card draws chrome only)**: `<Card tone title titleRight focused height width minHeight
  accentToken>` renders the border style its tone declares (`round`, `single` or none), exactly one
  clipped title row (both cells `wrap="truncate"`, `overflow="hidden"`) and a clipped body. It
  never scrolls, measures children or computes a height; the caller has already paid through
  `cardChrome(tone)`.
- **AC-70.3 (Tone map)**: the conversation is `primary`; the live stream, `InfoPanel`,
  `PipelineCard` and `StreamCard` are `secondary`; the log tail (`LogsCard`) is `tertiary`.
  `test/tui/card.test.ts` asserts each surface's declared tone.
- **AC-70.4 (Log tail is cheap)**: `LogsCard` costs `visibleLogs.length + 1` rows (title plus one
  line per entry) instead of `+ 3`, and both dashboards derive that budget from
  `cardChrome("tertiary").rows`, never a literal. The old five-row expectations move to three
  because the box is gone; the commit records that as an improvement, not a relaxed assertion.
- **AC-70.5 (Colour follows the hierarchy)**: an unfocused `primary` border uses `THEME.accent`
  (or the stage's `accentToken`); a focused card uses `THEME.borderFocus` whatever its tone; an
  unfocused `secondary` uses `THEME.border`; `tertiary` paints no border. Focus is also signalled in
  the title, so colour is never the only cue.
- **AC-70.6 (Drift guards)**: `test/tui/card.test.ts` pins the table, the exact painted height per
  tone, the borderless tertiary card, `LogsCard`'s row cost and the six surface→tone mappings;
  `test/tui/cardColors.test.ts` renders with colour forced on and asserts the border escape Ink
  actually emits for the accent, `borderFocus`, quiet-border and borderless cases.

### REQ-71: The live console's layout is a keyboard surface and the idle log tail gives its rows back
- **AC-71.1 (Layout keys belong to the focused card)**: `LiveDashboard` resolves `z`, `Ctrl+↑`,
  `Ctrl+↓` and `L` only while a card owns the focus, never from the composer — there `z` and `L` are
  ordinary draft text and the chord stays out of the terminal, so typing can never rearrange the
  frame. `z` maximizes the focused card and `z` again restores the remembered split;
  `Ctrl+↑`/`Ctrl+↓` move that split by `SPLIT_RATIO_STEP` (0.08) through the pure
  `adjustSplitRatio`/`clampSplitRatio`, clamped to `[SPLIT_RATIO_MIN 0.30, SPLIT_RATIO_MAX 0.80]`
  around `DEFAULT_SPLIT_RATIO` (0.58).
- **AC-71.2 (A maximized card is the only card)**: the pure `liveCardHeights` gives a maximized card
  every available row and zero to the other one, which is then not rendered; releasing the maximized
  state restores the exact ratio in force before it. `nextFocus` walks only visible surfaces (a
  collapsed stream, a maximized-away conversation), so `Tab` never lands on a card the layout hid.
- **AC-71.3 (The log tail is ephemeral and pinnable)**: after `LOG_AUTO_COLLAPSE_MS` (60 s) without a
  new event the tail collapses and returns its rows to the conversation; a new log reopens it, an
  `error` still present in the visible tail keeps it open, and an error that has scrolled out does
  not disable the timer for the rest of the session. `[L]` (card focus only) pins the tail open and
  disables the timer; releasing the pin starts a fresh minute instead of collapsing the same instant.
- **AC-71.4 (Hidden state is announced)**: the footer advertises the collapsed tail as
  `[L] logs · N (card focus)`, where `N` counts **every** hidden entry (`logsCollapsed ?
  logs.length : 0`), not just the visible window. A visible tail still costs
  `visibleLogs.length + cardChrome("tertiary").rows` (AC-70.4).
- **AC-71.5 (Drift guards)**: `test/tui/liveLayout.test.ts` drives the real keyboard path — `z` typed
  into the composer stays text, `z`/`Ctrl+↑`/`Ctrl+↓`/`L` from a card change the layout, one step up
  and one down return the same ratio, the idle timer collapses the tail and `L` reopens it, a pinned
  tail outlives every timeout and collapses again one minute after release, a visible error keeps it
  open while a stale one does not, the advertised count is the whole tail, and 100×30 keeps at least
  six conversation body rows with the logs collapsed.

### REQ-72: The transcript is navigable, searchable and copyable from the keyboard
- **AC-72.1 (`g`/`G` jump the focused transcript)**: from the conversation or the agent stream,
  `g` scrolls to the first row and `G` to the last; from the composer they are ordinary draft
  letters. The keys are matched as bare input (`!key.ctrl && !key.meta`), so a chord such as
  `Ctrl+G` is never a jump.
- **AC-72.2 (Search opens from any focus and preserves the draft)**: `Ctrl+F` opens transcript search
  from any focus and while a turn is busy. The composer shows `find ❯ ` with the query instead of
  the draft; `Esc` or `Ctrl+F` again closes search, restores the exact draft, and search mode keeps
  the command palette from taking over. Every key search consumes also cancels an armed two-step
  `Esc` abort, so `Esc` → `Ctrl+F` → `Esc` → `Esc` warns again instead of aborting. Query input is
  sanitized and Ctrl/Meta chords never become query text.
- **AC-72.3 (Matches are messages, and navigation is honest)**: `findMatches`/`matchLabel` in
  `src/tui/search.ts` match case-insensitively by message (never by wrapped row); an empty or
  whitespace-only query has no hits. `↑`/`↓` wrap through the hit list, Backspace rewinds the
  selection to the first hit, and Enter jumps to the selected message's first painted row
  (`messageStartRow`) and closes search; Enter with no hits closes without moving. The conversation
  card's own title prints `match n/m` while a search has hits and prints no position when it has
  none.
- **AC-72.4 (Search mode is visible in the chrome)**: the search composer paints its border with
  `THEME.warn`, the footer advertises the match count and the `↑/↓`, Enter and Esc keys, and the
  ordinary focused composer keeps `THEME.borderFocus`. `test/tui/transcriptSearchColors.test.ts`
  asserts the ANSI border Ink actually emits, not only the rendered text.
- **AC-72.5 (Copy is best-effort OSC 52 with a sanitized, bounded payload)**: from the conversation
  card, `y` copies the newest assistant message through OSC 52 and emits one honest notice naming
  the channel and its limits; it copies nothing from the agent stream and stays ordinary draft text
  in the composer. `src/tui/clipboard.ts` strips terminal control sequences before base64 encoding,
  rejects a raw payload above `CLIPBOARD_MAX_BYTES` (100 000 UTF-8 bytes) before sanitizing it,
  re-checks the sanitized size, and writes to the output stream passed by the caller rather than a
  global `process.stdout`. An oversized message produces a "too large" warning, never a truncated
  sequence.
- **AC-72.6 (Drift guards and discoverability)**: `src/tui/search.test.ts` and
  `src/tui/clipboard.test.ts` cover the pure match/label and OSC 52 helpers;
  `test/tui/transcriptNavigation.test.ts` drives the real keys, the draft restoration, the
  message jump, the copy path and the Esc/search interaction; `test/tui/helpModal.test.ts` keeps
  `/help` and the README shortcut table naming the same keys and behaviour. `MODULE_MAP.md`,
  `DESIGN.md`, `ADR.md` (ADR-68) and `AGENTS.md` document the navigation, search and copy surfaces.

### REQ-73: The raven carries the run's state and the frame pays only for what is on screen
- **AC-73.1 (Moods share the mark's grid)**: `RAVEN_MOODS` and `ravenMark(mood)`
  (`src/brand.ts`) expose exactly `idle` (`o`), `thinking` (`O`) and `sleeping` (`-`). Every mood has
  the idle mark's rows, leading spaces, width and printable-ASCII alphabet, and only the beak cell
  differs, so switching mood reflows nothing. `RavenHeader`/`buildRavenArtRows` and
  `LiveHero`/`heroPlan` accept the optional mood (default `idle`); the live console draws `thinking`
  while a turn is in flight and `idle` otherwise. The one-row compact brand is fixed at the idle
  head — a narrow frame cannot claim a mood it has no row to draw.
- **AC-73.2 (A one-row rung before plain text)**: `COMPACT_BRAND` (`<(o  HUGINN`) and
  `COMPACT_BRAND_WIDTH` (`src/tui/RavenHeader.tsx`) sit between the wordmark and the plain-text
  fallback in both `ravenHeaderPlan` and `heroPlan`. The five-row art still needs
  `reservedRows + HEADER_BORDER_ROWS + RAVEN_ART_ROWS + contextRows`; the compact rung needs only
  `HEADER_BORDER_ROWS + 1 + contextRows` and spends one row, and plain `HUGINN` text remains the
  fallback when even that does not fit. The hero uses the same order and steps from full/wordmark to
  compact when the art would starve the first-run guidance, so a short card keeps both its brand and
  its advice.
- **AC-73.3 (Only on-screen chrome is reserved)**: `LiveDashboard` exports
  `VIEWPORT_RESERVED_ROWS_CLOSED` (`CARD_MIN_ROWS * 2 + INPUT_HEIGHT + FOOTER_HEIGHT`) and
  `VIEWPORT_RESERVED_ROWS_OPEN` (closed plus `MAX_SUGGESTION_ROWS` and `PALETTE_BORDER_ROWS`), and
  adds `MODAL_COMPACT_RESERVE_ROWS` (`RAVEN_ART_ROWS - 1`) while a full-screen modal is open. The
  header plan is derived from the figure in force, so opening the palette may shrink the header and
  closing it returns the art; no surface charges rows for a state the user cannot see.
- **AC-73.4 (The active stage owns the conversation's accent)**: while a turn is in flight the live
  conversation card's `primary` border uses the stage's `STAGE_LABEL` token (`accent` refine, `warn`
  draft, `thinker` approve, `executor` execute) through `Card`'s `accentToken`; at idle it returns to
  `accent`. Focus still wins: a focused card uses `THEME.borderFocus`.
- **AC-73.5 (The pipeline is a rail that names the increment)**: the run dashboard's `PipelineCard`
  prints `iter n/m` in its title row via `Card`'s `titleRight`, never as a body row, and draws one
  connector per phase (`├─`, the last one `└─`, a `FIX_*` round `   └─` under the phase it repairs).
  The status glyph stays before the connector, so the current phase keeps its spinner and a finished
  one its verdict mark, and the card's height is unchanged by the rail.
- **AC-73.6 (Drift guards)**: `src/brand.test.ts` pins the three moods, their shared grid and the
  single changed cell; `test/tui/glyphs.test.ts` keeps every mood single-width and emoji-free;
  `test/tui/ravenHeader.test.ts` covers the compact rung and the mood rendering;
  `test/tui/liveLayout.test.ts` covers the compact hero, the mood plumbing, the closed/open
  reservation and the 80×24/80×28 header plans; `test/tui/liveStageAccent.test.ts` asserts the busy
  stage accent's ANSI border; `test/tui/dashboard.test.ts` asserts the `iter n/m` title and the rail.
  `MODULE_MAP.md`, `DESIGN.md` (§32.11), `ADR.md` (ADR-69) and `AGENTS.md` document the moods, the
  compact rung, the visible-chrome reservation and the pipeline rail.

### REQ-74: Markdown renders tables, links and full-width rules inside the card
- **AC-74.1 (Rules follow their container)**: `markdownSegments(text, color, width)` draws a
  horizontal rule (`---`, `***`, `___`) and the code-fence header at exactly `width` display columns
  instead of a fixed literal. An unknown or non-finite width falls back to `DEFAULT_MARKDOWN_WIDTH`
  (80) and every width is clamped to at least one column, so a rule can neither be `repeat(0)` nor
  throw. `MarkdownLine` forwards the `width` prop; `MarkdownBlock` passes it to the line it renders
  and the dashboards hand that width down from `cardChrome`, so no renderer falls back to the
  80-column default on a real surface.
- **AC-74.2 (Links keep the label and name the URL)**: `inlineSegments` matches `[label](url)`
  before the emphasis tokens and emits the label underlined plus a dim ` ‹url›`; a malformed link
  (`[a](b c)`, `[a]()`, `[label](not a url)`, `[no url]`) stays literal text. The underline is a
  segment flag, so `wrapSegments` keeps it across a wrap and a heading's bold does not drop it.
- **AC-74.3 (Tables are formatted as one block)**: `isTableHeader(lines, i)` recognises a header
  only when the next line is a `|---|` separator (alignment colons and rows without outer pipes
  included); `tableBlockEnd` spans the contiguous pipe rows and stops at the first blank or non-pipe
  line. `tableBlock(rows, width)` returns exactly one styled row per input row: columns are padded to
  the widest cell of every content row, `" │ "` separators are dim, the header row is bold, the
  `|---|` line is drawn as `─`, an overlong cell is truncated with `…` inside its column, and each
  row is clipped to `width`. It accepts raw markdown strings or already-split cells, and a width
  that cannot hold the column gaps still yields exactly one clipped row per input row (a stub of the
  separators, or nothing at all) instead of overflowing. Table cells are plain text — inline markup
  inside a cell is not styled yet (`test/tui/markdownTable.test.ts` records that as a `todo`, not as
  behaviour).
- **AC-74.4 (One renderer owns the block)**: `MarkdownBlock({ lines, width, colorFor?, wrap?,
  maxRows? })` walks a buffer, hands every contiguous table block to `tableBlock` and every other
  line to `MarkdownLine`, and keeps the last `maxRows` **rendered** rows, so clipping a report can no
  longer cut a table header off before its rows. The run dashboard renders both the stream buffer
  and the last-phase report through it; the live chat formats the contiguous tables in its
  conversation at the card's body width, and its stream card uses the same block renderer.
- **AC-74.5 (The width is the frame's, not a literal)**: `Dashboard` derives the stream column as
  `floor((columns - VIEW_OUTER_INSET) * (verbose ? 0.65 : 0.58))`, `StreamCard` subtracts
  `cardChrome("secondary").columns`, and the live conversation subtracts
  `cardChrome("primary").columns` plus its body indent. A `---` in a report is therefore one row of
  the card's exact body width at any terminal size, instead of a 40-column literal that either
  floated short of the border or wrapped into a second row and corrupted the row budget.
- **AC-74.6 (Drift guards)**: `test/tui/markdown.test.ts` (width-aware rules, links and malformed
  links, plus the `<MarkdownLine` width scan over the renderer and both dashboards),
  `test/tui/markdownTable.test.ts` (block detection, one row per input, alignment, truncation,
  double-width glyphs, ragged rows, and the real `Dashboard` frame) and
  `test/tui/liveMarkdownTable.test.ts` (the live chat paints aligned rows with no raw pipes, inside
  the conversation card) hold the contract.

### REQ-75: The console modals share one frame and one key grammar, and the footer names the focused surface
- **AC-75.1 (One frame)**: `src/tui/Modal.tsx` is the only console modal frame. Every
  `*Modal.tsx` renders through `<Modal>` and none of them owns a `borderStyle`. `tone="alert"`
  draws the single `double` border with `THEME.warn`; every other tone draws a `round` box with
  `THEME.accent` unless the caller overrides `borderColor`. The frame owns exactly one clipped
  bold title row, an optional muted subtitle row and a `hint` key footer (one muted clipped row
  for the console modals; a `ReactNode` hint keeps the decision surface's own row specs and
  colours), fixes `paddingX={1}`, `flexShrink={0}` and `overflow="hidden"`, and leaves `height`,
  `width`, `minHeight`, `paddingY` and the children to the caller. It never calls `useInput`.
- **AC-75.2 (One key grammar)**: `MODAL_KEY_CONTRACT` exports the literals the handlers use:
  `close: "Esc"`, `quickClose: ["HelpModal", "SkillsModal"]`,
  `confirm: ["AgentPickerModal", "ProfilePickerModal", "ModelPickerModal"]`, `move: "↑/↓"` and
  `vimMove: "k/j"`. `Esc` closes all six console modals without exception; `q` closes only
  `HelpModal` and `SkillsModal`; `Enter` confirms/selects only in the three selectors and never
  closes a modal (`SkillsModal` may use it for its own execute action, which is not a generic
  confirm); `Tab` switches panes only in `SkillsModal` and `McpInspectorModal` (`Enter`
  deliberately does not move the inspector's focus); `p`/`g` persist only in
  `ProfilePickerModal`; `k`/`j` move only where they already did, and `ModelPickerModal` keeps
  them as filter text on its search steps. The decision surface shares the frame and its `alert`
  tone but keeps its own answer keys and body windowing.
- **AC-75.3 (The footer speaks for the focused surface)**: `footerHints(input)` in
  `src/tui/footer.ts` is pure and returns `{ left, right }`; `src/tui/footerHints.ts` re-exports
  the same implementation. `left` carries the keys of the **focused** surface (`FooterFocus` =
  `composer`, `chat`, `stream` or `run`): composer history/send, conversation and stream
  scroll/search/jump, conversation-only `[y] Copy`, and the run dashboard's `[Space]` pause/resume,
  `[q/Esc]` abort, `[v]` verbose and page/arrow scrolling. The palette replaces the left cell;
  transcript search replaces it with the find prompt, match count and Enter/Esc keys; a busy turn
  appends `[Esc] Abort`; a maximized card flips Maximize/Restore; a collapsed log tail prefixes
  `[L] logs · N (card focus)`. `right` keeps token usage — or the run
  dashboard's decision notice; the live stage is the header badge's fact and is never a footer
  value (AC-77.3). Neither dashboard may re-inline these literals.
- **AC-75.4 (The footer never exceeds the terminal)**: when `columns` is finite and positive,
  `footerHints` clamps the right cell first through `headerValue` (so the usage figure survives),
  spends one column for the separator only when the right cell is non-empty, and gives the left
  cell the remaining budget. A negative/fractional hit count is floored to zero, a fractional
  width is floored rather than sliced, and a right cell that fills the terminal leaves the left
  with no negative budget. `src/tui/footer.test.ts` asserts the 100-column case.
- **AC-75.5 (Drift guards)**: `test/tui/modalContract.test.ts` mounts all six console modals and
  proves the `Esc` footer and close, the `q` quick-close set, the `Enter` selector set, the
  inspector's Tab-only pane switch, `k`/`j` only where they were accepted, the absence of a
  modal-owned `borderStyle`, the one-title/one-footer row contract, and the README/DESIGN
  paragraphs that name the same grammar. `src/tui/footer.test.ts` covers the focus-specific keys,
  search, hidden-log count, run keys, clamping and purity.

### REQ-76: Console chrome speaks one measured alphabet, and a clamped value says so
The console must never paint a double-width pictograph or silently crop a value it could not fit.
- **AC-76.1 (MCP badge mapping)**: `mcpBadgeText(badge)` (`src/tui/sessionContext.ts`) is the TUI's
  presentation of the engine's `formatMcpBadge` output. It strips pictographs and variation
  selectors, collapses the whitespace they leave behind, and re-inserts one measured status mark
  right after `MCP: ` through `MCP_STATUS_GLYPHS` (`healthy` → `STATUS_GLYPHS.pass` `✓`, `degraded`
  → `STATUS_GLYPHS.warning` `!`, `unknown` → `STATUS_GLYPHS.pending` `·`), so the engine's
  `MCP: 🟢 2 connected · pi` is painted as `MCP: ✓ 2 connected · pi`. `formatMcpBadge` and its
  engine contract are untouched; the run header and `InfoPanel` pass the mapped text (the live
  header no longer carries the badge, AC-77.1).
- **AC-76.2 (a badge always names itself)**: a badge carrying only a mark still renders its label
  (`MCP: 🟢` → `MCP: ✓`; an empty report → `MCP: ·`), a badge the engine sent without the label is
  repaired to `MCP: <mark> …`, and an unknown status falls back to `pending` rather than dropping
  the mark.
- **AC-76.3 (truncation is announced and measured)**: `headerValue(value, maxWidth)`
  (`src/tui/RavenHeader.tsx`) sanitizes and collapses whitespace, then clamps in **display
  columns** (`stringWidth`), never code units. A value that fits is returned intact; a value that
  does not keeps its head and spends its last column on `TRUNCATION_ELLIPSIS` (`…`); a value cut
  in a one-column budget is the mark alone; a zero, negative, fractional-below-one or `NaN` budget
  returns `""`; and `Infinity` keeps the value whole. A double-width glyph is never split, so the
  result never paints wider than the budget it was given. The footer inherits the contract, so a
  clamped left or right cell ends in `…` instead of a silent crop.
- **AC-76.4 (the side panel pays for its values)**: `SIDE_PANEL_WIDTH` = 36 columns
  (`src/tui/InfoPanel.tsx`), so at the 100-column threshold the panel's value column is
  `36 − cardChrome("secondary").columns (4) − PANEL_LABEL_COLUMNS (9) = 23` columns — wide enough
  for the longest real values (`⎇ upgrade/ui-ux · dirty`, `2.3k entities · 76 obs`) to paint whole.
  `memoryStat` formats both Muninn counters through `formatCount` (`840`, `1.4k`, `12k`). The
  threshold still leaves the conversation its floor: `36 + 1 gap + 44 = 81 ≤ 100 − 2` inset.
- **AC-76.5 (drift guards)**: `test/tui/sessionContext.test.ts` covers the badge mapping and
  `formatCount`; `test/tui/ravenHeader.test.ts` covers intact values, the ellipsis, the degenerate
  budgets, `Infinity`, double-width glyphs and a frame scan of both dashboards that fails on a
  pictograph or a double-width row;
  `test/tui/infoPanel.test.ts` and `test/tui/liveLayout.test.ts` pin the panel width and the
  23-column value budget; `src/tui/footer.test.ts` proves a clamped footer cell ends in `…`.

### REQ-77: One home per fact — header identity, panel environment, footer keys
Every live-session fact must appear on exactly one surface, so the header, the panel and the footer
cannot disagree or spend each other's columns.
- **AC-77.1 (the header is identity and ephemeral state)**: `LiveHeader` row 1 is
  `[<spinner> <STAGE>]` plus the project path; row 2 is the two active models and nothing else. It
  does not render the MCP badge, the runtime name, git, the worktree sandbox or the conversation
  counter. `LIVE_HEADER_CONTEXT_ROWS` stays `2`, so the header's height and every budget derived
  from it (`VIEWPORT_RESERVED_ROWS_CLOSED`/`_OPEN`, card heights, the decision modal) do not move;
  the project path inherits the columns the badge and the runtime used to spend, and a 100×30 test
  proves a long path is painted whole instead of shortened.
- **AC-77.2 (the panel is the environment)**: `PanelData`/`panelLines` no longer render a `stage`
  row (and drop the `stageLabel`/`stageToken`/`busy`/`spinner` fields only it consumed). The panel
  keeps `agent`, the attributed mapped MCP badge, `git`, `sandbox`, `muninn`, `ctx` and the
  bottom-anchored `TIP`. `gitStat(git, maxWidth?)` pays for the `clean`/`dirty` suffix before it
  clamps the branch, because the panel is the only surface that reports the working-tree state;
  without `maxWidth` its historic `GIT_BRANCH_COLUMNS` cap is unchanged. When the budget cannot pay
  for `⎇ … · dirty` at all, `gitStat` returns `""` and the row is dropped rather than printed
  without the fact it reports.
- **AC-77.3 (the footer is the keys)**: `FooterHintInput` no longer accepts `stage`; `footerHints`
  returns the focused surface's keys on the left and `usage` on the right (the run dashboard keeps
  its decision notice there). No live footer renders `stage: <LABEL>`: the stage is the header
  badge's fact. `sessionStat` — the header-only join — is deleted with its test rather than left as
  dead code.
- **AC-77.4 (the tests state the new rule)**: the two `test/tui/liveLayout.test.ts` assertions that
  fixed the old duplication are rewritten, not deleted or relaxed: one asserts a single `⎇`
  occurrence in the panel and none on the header's models row; the other asserts the conversation
  counter appears exactly once, in the panel. The footer assertions in the TUI suites assert the
  header's `[<spinner> <STAGE>]` badge and the absence of `stage:`. `src/tui/footer.test.ts` and
  `test/tui/infoPanel.test.ts` pin the new policy, and `test/tui/liveLayout.test.ts` holds the
  100×30 project-path regression.

---

## Appendix — module map

The module → requirement lookup table lives in [MODULE_MAP.md](./MODULE_MAP.md). It replaced
`SPEC_ORCHESTRATOR.md`, whose second REQ numbering collided with this ledger's.

