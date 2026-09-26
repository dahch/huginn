# Plan: Muninn Engine (Phase 1)

## Iteration 1 — Database Layer & SQLite FTS5 Schema
modules: src/muninn/db/

Implement the foundational SQLite persistence layer with full FTS5 support:
1. Create `src/muninn/db/schema.sql` defining:
   - `projects` table (id, name, git_remote, root_path, created_at)
   - `observations` table (id, project_id, category with CHECK constraint, title, content, topic_key, created_at, updated_at, FOREIGN KEY project_id CASCADE)
   - `observations_fts` virtual table using FTS5 (title, content, topic_key, content='observations', content_rowid='rowid')
   - Triggers `obs_ai`, `obs_ad`, and `obs_au` for automatic FTS5 synchronization
   - `entities` table (id, project_id, entity_type with CHECK constraint, identifier, file_path, FOREIGN KEY project_id CASCADE)
   - `observation_entities` table (observation_id, entity_id, PRIMARY KEY, FOREIGN KEY cascades)
2. Create `src/muninn/db/client.ts`:
   - `resolveDatabasePath(customPath?: string)`: resolves to `<git_root>/.huginn/muninn.db` if in a git repo, or falls back to `~/.huginn/muninn.db`.
   - `getDatabase(dbPath?: string)`: creates/opens `better-sqlite3` instance, configures `PRAGMA journal_mode = WAL;`, `PRAGMA foreign_keys = ON;`, executes `schema.sql` automatically, and provides project bootstrapping helper `ensureProject(db, rootPath)`.
3. Add comprehensive unit tests in `test/muninn/db.test.ts` verifying path resolution, table and trigger creation, automatic FTS5 sync, and foreign key cascades.

## Iteration 2 — Memory Service & Persistence Engine
modules: src/muninn/service/

Implement `MemoryService` in `src/muninn/service/memory-service.ts`:
1. `saveObservation({ category, title, content, topicKey, symbols })`:
   - Validates category against allowed values (`decision`, `convention`, `discovery`, `bugfix`, `architecture`).
   - Inserts observation within a transaction.
   - Idempotently creates entities for provided symbols and records links in `observation_entities`.
   - Returns the saved observation with linked symbols.
2. `search({ query, category, limit })`:
   - Sanitizes search query for SQLite FTS5 syntax safety.
   - Executes query against `observations_fts` with BM25 rank scoring (`bm25(observations_fts)`).
   - Filters by category when specified and limits results (default: 10).
   - Fetches and attaches associated entities for each matching observation.
3. `getContext({ limit, category, topicKey })`:
   - Retrieves recent observations ordered by `updated_at DESC`.
   - Attaches linked entities.
4. `linkSymbol(observationId, symbol)`:
   - Links or creates an entity and associates it with the observation.
5. `getStats()`:
   - Returns aggregate counts of projects, observations, entities, and links.
6. `syncToDisk(targetPath?)` & `importFromDisk(sourcePath?)`:
   - Streams observations and entities to/from `.huginn/memories.jsonl` idempotently.
7. Add unit tests in `test/muninn/service.test.ts` covering all service methods, ranking, edge cases, and JSONL import/export.

## Iteration 3 — MCP Server (Model Context Protocol)
modules: src/muninn/mcp/

Implement the Model Context Protocol (MCP) server in `src/muninn/mcp/server.ts`:
1. Initialize `Server` from `@modelcontextprotocol/sdk/server/index.js` with metadata name `"muninn-memory"` and version `"1.0.0"`.
2. Register tools with Zod schemas:
   - `muninn_save`: category, title, content, topicKey, symbols.
   - `muninn_search`: query, category, limit.
   - `muninn_context`: limit, category, topicKey.
   - `muninn_link_symbol`: observationId, symbol.
   - `muninn_stats`: no arguments.
3. Provide `startMcpServer(options?)` using `StdioServerTransport` for JSON-RPC 2.0 communication over stdio.
4. Add integration tests in `test/muninn/mcp.test.ts` verifying tool listing and tool execution.

## Iteration 4 — CLI Commands Integration & Test Verification
modules: src/commands/, src/

Integrate Muninn into the Huginn CLI and configure test execution:
1. Create `src/commands/memory.ts`:
   - `handleMemoryCommand(subcommand, args)`:
     * `huginn memory init`: initializes SQLite database and reports status and path.
     * `huginn memory search <query>`: executes search and outputs formatted results with ranks and entities.
     * `huginn memory sync [--import]`: exports to or imports from `.huginn/memories.jsonl`.
   - `handleMcpCommand(subcommand, args)`:
     * `huginn mcp run`: starts the stdio MCP server.
2. Update `src/cli.ts` to route `memory` and `mcp` commands and update help/usage output.
3. Create `vitest.config.ts` targeting `test/**/*.test.ts`.
4. Ensure `npm run test` and `bun test` pass 100% in green across all existing and new test suites.
