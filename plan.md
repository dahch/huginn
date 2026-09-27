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

---

# Plan: Verified Execution Contracts & AST Symbol Indexer (Phase 2)

## Iteration 5 — TypeScript Compiler Contract Verifier
modules: src/contracts/

Implement the TypeScript Compiler verification contract module in `src/contracts/`:
1. Create `src/contracts/compiler.ts`:
   - `verifyTypeScriptContracts(projectRoot: string, filePaths?: string[])`:
     * Discover and load `tsconfig.json` using `ts.readConfigFile` and `ts.parseJsonConfigFileContent`. If absent, apply strict defaults (`strict: true`, `target: ES2022`, `moduleResolution: NodeNext`).
     * Instantiate `ts.createProgram` (or `ts.createIncrementalProgram`).
     * Collect pre-emit diagnostics via `ts.getPreEmitDiagnostics`.
     * Filter diagnostics exclusively to target `filePaths` (or all modified files if omitted).
     * Format visual snippets with line numbers, code frame, and ASCII carat underlines (`^^^^`).
     * Return `{ valid: boolean, errorsCount: number, diagnostics: FormattedDiagnostic[] }`.
   - Expose `TypeValidator` class and `formatDiagnosticsReport` helper.
2. Export module public API in `src/contracts/index.ts`.
3. Add unit test suite in `test/contracts/compiler.test.ts` covering clean compilation, syntax errors, type mismatches, missing tsconfig fallback, visual snippet rendering, and multi-file filtering.

## Iteration 6 — AST Symbol Graph & Topological Indexer
modules: src/muninn/db/, src/muninn/indexer/, src/muninn/service/

Implement AST symbol extraction and database graph relationships:
1. Update `src/muninn/db/schema.sql` and `SCHEMA_SQL` in `src/muninn/db/client.ts`:
   - Add `entity_dependencies` table with columns `source_entity_id`, `target_entity_id`, and `relation_type` (`CHECK(relation_type IN ('imports', 'calls', 'implements', 'extends', 'references'))`).
   - Add primary key `(source_entity_id, target_entity_id, relation_type)`.
   - Add cascading foreign keys to `entities(id) ON DELETE CASCADE`.
   - Add indices `idx_entity_deps_source` and `idx_entity_deps_target`.
2. Implement `src/muninn/indexer/ast-indexer.ts`:
   - `extractSymbolsFromSource(filePath: string, sourceText: string)`:
     * Parses AST with `ts.createSourceFile`.
     * Extracts functions (`ts.isFunctionDeclaration`), classes and methods (`ts.isClassDeclaration`, `ts.isMethodDeclaration`), interfaces (`ts.isInterfaceDeclaration`), type aliases (`ts.isTypeAliasDeclaration`), and imports (`ts.isImportDeclaration`).
     * Formats canonical identifiers `<relPath>::<symbolName>` and `<relPath>::<ClassName>.<methodName>`.
   - `indexFilesIntoMuninn(memoryService: IMemoryService, filePaths: string[])`:
     * Reads files from disk, extracts symbols and dependency relations, and persists them into `entities` and `entity_dependencies` inside an atomic transaction.
3. Extend `IMemoryService` and `MemoryService` in `src/muninn/service/memory-service.ts`:
   - Implement `inspectSymbol(symbol: string, projectId?: string)` returning symbol metadata, file path, incoming/outgoing dependencies, and attached observations.
4. Export indexer API in `src/muninn/indexer/index.ts`.
5. Add unit tests in `test/muninn/indexer.test.ts` covering AST symbol extraction, inheritance/imports tracking, database ingestion, cascading deletions, and `inspectSymbol`.

## Iteration 7 — MCP Extended Tools & CLI Check/Index Commands
modules: src/muninn/mcp/, src/commands/, src/cli.ts

Expose compiler verification and symbol indexing to agents and developers:
1. Update `src/muninn/mcp/server.ts`:
   - Register `muninn_inspect_symbol` tool:
     * Schema accepts `{ symbol: string, projectId?: string }` (supporting snake_case aliases).
     * Handler resolves entity via `inspectSymbol` and formats markdown/JSON summary.
   - Register `muninn_verify_contract` tool:
     * Schema accepts `{ files?: string[] }`.
     * Handler calls `verifyTypeScriptContracts` and returns realtime compiler diagnostics.
   - Update `TOOL_NAMES` array and tool count.
2. Implement CLI commands:
   - Create `src/commands/check.ts` handling `huginn check [files...]`:
     * Discovers target files or walks `src/`.
     * Runs `verifyTypeScriptContracts` and renders formatted output.
     * Sets `process.exitCode = 1` on errors.
   - Extend `src/commands/memory.ts`:
     * Add `huginn memory index [files...]` subcommand calling `indexFilesIntoMuninn`.
   - Update `src/cli.ts` to route `check` and update usage documentation.
3. Update MCP tests in `test/muninn/mcp.test.ts` to cover 7 registered tools and new tool handlers.

## Iteration 8 — Engine Pipeline Integration & Dual Runtime Quality Gate
modules: src/engine/, test/

Integrate contracts and indexing into Huginn's execution loop and ensure dual-runtime reliability:
1. Update `src/engine/phases.ts`:
   - In `validateStep`: Before or during test validation, run `verifyTypeScriptContracts` on iteration modules. If errors exist, fail closed with `blocked` verdict and inject formatted diagnostics for `FIX_VALIDATE`.
   - In `commitAll`: Run `indexFilesIntoMuninn` over iteration modified files (`git diff`) to keep Muninn's symbol graph up to date.
2. Update `src/engine/diff.ts`:
   - Ensure dual runtime portability: fallback to Node.js `child_process.spawnSync` when `Bun.spawnSync` is unavailable (e.g. running under Vitest/Node).
3. Verify test suite and typechecking:
   - Run `npm test` (`bun test && vitest run`) ensuring all tests pass 100% green.
   - Run `bun run typecheck` (`tsc --noEmit`) ensuring zero TypeScript errors.
   - Run `bun run build` ensuring successful bundle generation.
