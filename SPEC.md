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

### REQ-3: Observation Creation & Entity Linking
The memory service must provide `saveObservation` to store structured observations and optionally link them to code symbols in one atomic transaction.
- **AC-3.1**: Accepts `category` (must be `decision`, `convention`, `discovery`, `bugfix`, or `architecture`), `title`, `content`, optional `topicKey`, and optional array of `symbols`.
- **AC-3.2**: Each symbol specifies `name` or `identifier`, `type` (`file`, `function`, `class`, `interface`, `module`), and `filePath`.
- **AC-3.3**: Reuses existing entity records with the same identifier and project, or creates new ones.
- **AC-3.4**: Returns the saved observation with generated ID, timestamps, and linked entities.

### REQ-4: Full-Text Search with BM25 Ranking
The memory service must provide `search` querying `observations_fts` and ranking results by relevance.
- **AC-4.1**: Searches across `title`, `content`, and `topic_key` using SQLite FTS5 `MATCH`.
- **AC-4.2**: Results are ranked by BM25 relevance score (`bm25(observations_fts)`).
- **AC-4.3**: Supports optional filtering by `category` and configurable result `limit` (default: 10).
- **AC-4.4**: User queries are sanitized so special characters (e.g. `:`, `/`, `*`, `"`) do not cause FTS5 syntax errors.
- **AC-4.5**: Each returned result includes the observation details, rank score, and associated entities.

### REQ-5: Context Retrieval for Prompts
The memory service must provide `getContext` to retrieve relevant observations for prompt context injection.
- **AC-5.1**: Retrieves observations ordered by `updated_at DESC` up to `limit` (default: 20).
- **AC-5.2**: Supports optional filtering by `category` or `topicKey`.
- **AC-5.3**: Returns observations with their associated code symbols.

### REQ-6: Symbol Linking & Statistics
The memory service must support explicit symbol linking via `linkSymbol` and aggregate metrics via `getStats`.
- **AC-6.1**: `linkSymbol(observationId, symbol)` associates an entity with an observation idempotently.
- **AC-6.2**: `getStats()` returns counts for projects, observations, entities, and observation_entities.

### REQ-7: JSONL Disk Synchronization & Import
The memory service must allow exporting memories to `.huginn/memories.jsonl` and importing them from disk.
- **AC-7.1**: `syncToDisk(targetPath?)` exports all observations and linked entities as JSON lines into `.huginn/memories.jsonl` (or custom path).
- **AC-7.2**: `importFromDisk(sourcePath?)` reads `.huginn/memories.jsonl` and imports observations and entities idempotently without duplicate records.
- **AC-7.3**: Newly imported observations are automatically indexed in FTS5.

### REQ-8: Model Context Protocol (MCP) Server
An MCP server must expose Muninn tools via `@modelcontextprotocol/sdk` over `StdioServerTransport`.
- **AC-8.1**: Implements JSON-RPC 2.0 communication over stdio.
- **AC-8.2**: Registers `muninn_save` with Zod schema validation.
- **AC-8.3**: Registers `muninn_search` with Zod schema validation.
- **AC-8.4**: Registers `muninn_context` with Zod schema validation.
- **AC-8.5**: Registers `muninn_link_symbol` with Zod schema validation.
- **AC-8.6**: Registers `muninn_stats` with Zod schema validation.
- **AC-8.7**: Errors in tool execution return standard MCP tool error responses rather than crashing the transport.

### REQ-9: CLI Commands Integration
The Huginn CLI must expose memory operations and MCP runner.
- **AC-9.1**: `huginn memory init` initializes the database and ensures schema readiness.
- **AC-9.2**: `huginn memory search <query>` executes a search and displays formatted results in the console.
- **AC-9.3**: `huginn memory sync [--import]` exports to or imports from `.huginn/memories.jsonl`.
- **AC-9.4**: `huginn mcp run` launches the stdio MCP server process.

### REQ-10: Test Suite Coverage
The subsystem must have full unit and integration test coverage under `test/muninn/` executed with `vitest`.
- **AC-10.1**: Unit tests verify schema creation, FTS5 triggers, and connection handling in `test/muninn/db.test.ts`.
- **AC-10.2**: Unit tests verify `saveObservation`, BM25 `search`, `getContext`, `linkSymbol`, `getStats`, and JSONL sync in `test/muninn/service.test.ts`.
- **AC-10.3**: Integration tests verify MCP tool handlers and JSON-RPC dispatch in `test/muninn/mcp.test.ts`.
- **AC-10.4**: All tests pass cleanly (`npm run test`).

---

## 5. Non-Functional Requirements

- **NFR-1 (Performance)**: FTS5 BM25 queries against 10,000 observations must resolve in under 10ms.
- **NFR-2 (Reliability & Integrity)**: Database runs with SQLite Write-Ahead Logging (WAL), foreign key cascade enforcement, recursive triggers for FTS5 synchronization, a 5000ms busy timeout, and directory creation mode `0o700`.
- **NFR-3 (Zero Cloud Lock-in)**: Completely self-contained; zero network calls or external API keys required.
- **NFR-4 (Compatibility)**: Works seamlessly in Node.js (v20+) and Bun (v1.0+) environments on macOS, Linux, and Windows.
- **NFR-5 (Type Safety)**: 100% strict TypeScript types with no `any` and full Zod schema validation for runtime inputs.
