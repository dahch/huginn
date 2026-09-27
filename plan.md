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

# Plan: Live-First Entrypoint, Universal Agent Integrator & Git Worktree Sandboxing (Phase 3)

## Iteration 9 — Persistent Model Configuration & Live-First Default Entrypoint
modules: src/config.ts, src/cli.ts, src/engine/liveMode.ts, test/engine/

Implement REQ-14 (SPEC.md §5) exactly. The repo is a Bun/TypeScript CLI (`src/cli.ts` is the bin, `src/config.ts` holds `RunConfig`). Tests: `src/**/*.test.ts` run under `bun test`; `test/**/*.test.ts` run under `vitest run` (config `vitest.config.ts`). `test/` uses Node-style imports; `src/` uses `bun:test`. Keep strict TypeScript (no `any`), ESM, `.js` extension on relative imports.

1. Extend `src/config.ts`:
   - Add `export interface UserConfig { thinker?: string; executor?: string; mode?: "auto" | "supervised"; [key: string]: unknown }`.
   - Add `export interface ModelSources { flagThinker?: string; flagExecutor?: string; projectConfig?: UserConfig; userConfig?: UserConfig; env?: Record<string, string | undefined> }`.
   - Add `export const DEFAULT_THINKER_MODEL = "anthropic/claude-opus-4-5"` and `export const DEFAULT_EXECUTOR_MODEL = "opencode/gpt-5.1-codex"`.
   - Add `export function resolveModelsFromConfig(sources: ModelSources): { thinker: string; executor: string }` implementing precedence: CLI flag → project config → user config → env (`HUGINN_THINKER_MODEL`/`HUGINN_EXECUTOR_MODEL`) → documented default. Pure function; no env reads unless `sources.env` omitted (then read `process.env`).
   - Add `export function getProjectConfigPath(projectPath: string): string` (`.huginn/config.json`), `export function getUserConfigPath(homeDir = os.homedir()): string` (`~/.huginn/config.json`), `export function loadUserConfig(projectPath: string, homeDir?: string): UserConfig` (project file first, then user file; missing → `{}`; malformed JSON → warn to `console.warn` and ignore, never throw), and `export function saveUserConfig(projectPath: string, config: UserConfig): void` (atomic: mkdir `.huginn` mode 0o700, write `${path}.tmp` mode 0o600, `renameSync`; merge with existing keys preserving unknown keys).
   - Add `sandbox: boolean` to `RunConfig`.
2. Modify `src/cli.ts`:
   - Add `--sandbox` and `--no-sandbox` to `BOOLEAN_FLAGS`.
   - Change default routing in `main`: define `KNOWN_COMMANDS = new Set(["run","plan","live","install","memory","mcp","check","setup","doctor"])`. If `args._command` is a known command, keep current routing. Otherwise (undefined, or a free-text idea token) route to `runLive(args)`. `help`/`--help`/`-h` still print usage. Add `setup` and `doctor` routing stubs that call `handleSetupCommand`/`handleDoctorCommand` from `src/commands/setup.ts` (create the file in Iteration 10 — for this iteration, add the imports and routing; if the module does not exist yet, create a minimal `handleSetupCommand`/`handleDoctorCommand` that print `not implemented yet` so typecheck/tests pass, and Iteration 10 fills them in).
   - In `runLive` and `run`: make `--project` default to `canonicalize(process.cwd())`; resolve thinker/executor via `resolveModelsFromConfig` (flags + `loadUserConfig(projectPath)` + env) instead of hard-erroring when flags are missing. Keep the "not a git repository" error.
   - Set `cfg.sandbox = !args["--no-sandbox"]` (default true) on both `run` and `live` configs.
   - Update `usage()` text: document the live-first default, `setup`, `doctor`, `--sandbox`/`--no-sandbox`, and the config/env model resolution order/defaults.
3. Add `test/engine/config.test.ts` (vitest) covering: precedence order for every layer; defaults; malformed project config falls back to user config; `saveUserConfig` round-trips and preserves unknown keys; `loadUserConfig` prefers project over user. Use `mkdtempSync` temp dirs and injected `homeDir`; clean up in `afterAll`.
4. Verify: `bun test` and `bunx vitest run` both green; `bun run typecheck` zero errors.

## Iteration 10 — Universal Agent Integrator (`huginn setup`) & Config Hardening
modules: src/agents/, src/commands/setup.ts, src/cli.ts, src/config.ts, test/commands/, test/engine/

Implement REQ-15 (SPEC.md §5) and fix the two security findings from the Iteration 9 audit (SEC-901, SEC-902). Reuse the command-handler style of `src/commands/check.ts` (`handleCheckCommand(files, args)`).

1. **Harden `src/config.ts` (SEC-901 + SEC-902)**:
   - `saveUserConfig`: replace the predictable `${path}.tmp` write with an exclusive, symlink-safe temp: `lstatSync` the `.huginn` dir and throw if it is a symlink; create the temp with `openSync(tmp, "wx", 0o600)` (or `writeFileSync(..., { flag: "wx", mode: 0o600 })`) using a random suffix, `writeSync`/`closeSync`, then `renameSync`. Never follow a pre-existing symlink at the temp path (EEXIST is acceptable — retry once with a new random suffix).
   - `sanitizeConfig`: build the result with `Object.create(null)` and explicitly reject/`console.warn` the dangerous keys `__proto__`, `constructor`, `prototype` instead of assigning them.
   - Add tests for both in `test/engine/config.test.ts`: a symlinked `.huginn` dir is refused; a pre-existing symlink at the temp path is not followed; `__proto__` in config JSON does not pollute the returned object's prototype.
2. Create `src/agents/integrator.ts` with a **declarative registry**:
   - `export type AgentTarget = "cursor" | "claude" | "opencode" | "windsurf" | "gemini" | "qwen" | "codex" | "agy" | "kimi" | "pi" | "commandcode" | "omp";`
   - `export type McpFormat = "mcpServers" | "opencode" | "toml";`
   - `export interface AgentSpec { id: AgentTarget; label: string; format: McpFormat; /** path templates with {project}/{home} placeholders */ mcpPaths: string[]; rulesFile: string; }`
   - `export const AGENT_REGISTRY: Record<AgentTarget, AgentSpec>` with EXACTLY the rows in SPEC.md AC-15.2 (cursor/claude/opencode/windsurf/gemini/qwen/codex/agy/kimi/pi/commandcode/omp). `AGENT_TARGETS` = the registry keys.
   - `export const MUNINN_RULES_START` / `MUNINN_RULES_END` markers.
   - `export function resolveMcpPaths(target, opts: { projectPath: string; homeDir: string; opencodeConfigDir?: string; env?: Record<string,string|undefined> }): string[]` — expands `{project}`/`{home}` and applies `HUGINN_AGENT_<ID>_MCP_PATH` (colon-separated) override when set; `opencode` honors the injected opencode config dir.
   - `export function registerMcpForTarget(target, opts): MCPRegistration[]` — for each resolved path, merge the `muninn` entry in the target's `format`:
     - `mcpServers`: `{ mcpServers: { muninn: { command: "huginn", args: ["mcp","run","--project", projectPath] } } }`
     - `opencode`: `{ mcp: { muninn: { type: "local", command: ["huginn","mcp","run","--project", projectPath], enabled: true } } }`
     - `toml`: `[mcp_servers.muninn]` with `command = "huginn"` and `args = ["mcp","run","--project","<path>"]` (parse existing TOML structurally — do not string-append; preserve unrelated tables).
     Atomic, idempotent, unrelated keys preserved; without `--force` an existing differing `muninn` entry is skipped (reported); malformed existing JSON/TOML throws a descriptive per-target error without writing.
   - `export function writePortableMcpConfig(opts): { path: string; changed: boolean }` — always write a standard `mcpServers` file at `{home}/.huginn/mcp.json` (AC-15.3).
   - `export function injectRulesForTarget(target, opts): { path: string; changed: boolean }` — read the target's rules file (under `projectPath` for project-scoped rules; the registry names one file per target), insert/replace only the marked block with directive text requiring `muninn_context` + `muninn_inspect_symbol` before designing changes and `muninn_verify_contract` before emitting final code.
   - `export function listRegistry(): AgentSpec[]` for `--list`.
   - `export function setup(opts: { agent: AgentTarget | "all"; projectPath: string; homeDir?: string; force?: boolean; opencodeConfigDir?: string; env?: Record<string,string|undefined> }): SetupReport` returning `{ registrations: MCPRegistration[]; rules: Array<{ target; path; changed }>; portable: { path; changed } }`.
3. Create `src/commands/setup.ts`:
   - `export async function handleSetupCommand(args)`: parse `--agent` (default `all`), `--force`, `--list`, `--project` (default cwd), `--home` (test override). Unknown agent → red error + usage + `process.exitCode = 1`. `--list` prints the registry table (id, label, mcp paths, rules file, format). Otherwise print per-target MCP paths and rules file with ✔/•/skipped markers plus the portable fallback and a summary.
   - `export function printSetupUsage(): void`; keep a minimal `handleDoctorCommand` stub (Iteration 11 implements it).
4. Wire `src/cli.ts` routing (already added in Iteration 9; keep `setup`/`doctor` in `KNOWN_COMMANDS` and usage).
5. Add `test/commands/setup.test.ts` (vitest) with temp `projectPath` + `homeDir` + `opencodeConfigDir`: every registry target's files are created with the correct format/entry; TOML (codex) is parsed and preserved around the injected table; idempotency (second run `changed: false`, bytes identical); unrelated-key preservation; `--force`; multi-path targets (cursor/claude/agy add both paths); portable `mcp.json`; `HUGINN_AGENT_<ID>_MCP_PATH` override; rules block insertion + idempotent replacement; unknown agent exits non-zero.
6. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.


## Iteration 11 — Diagnostic Command (`huginn doctor`)
modules: src/commands/, src/cli.ts, test/commands/

Implement REQ-16 (SPEC.md §5).
1. Add to `src/commands/setup.ts` (or a new `src/commands/doctor.ts` with re-export from setup to keep CLI imports stable):
   - `export interface DoctorCheck { id: string; label: string; status: "ok" | "warn" | "fail"; detail: string; critical: boolean; }`
   - `export interface DoctorReport { checks: DoctorCheck[]; ok: boolean; }`
   - `export function runDoctorChecks(opts: { projectPath: string; homeDir?: string; opencodeConfigDir?: string; env?: Record<string,string|undefined> }): DoctorReport` using `node:child_process` `spawnSync` for `git --version`, `opencode --version`, `bun --version`, `node --version`. Per AC-16.2: **critical** = project is a git repo, a runtime (Bun or Node) is present, and the Muninn DB opens. `opencode` CLI presence and missing agent integrations are `warn`, not `fail`. Check `git rev-parse --is-inside-work-tree` in `projectPath`. Integration check: iterate `listRegistry()` + `resolveMcpPaths()` from `src/agents/integrator.ts` (read-only) and report how many targets already register `muninn` (count + list). Muninn health: construct `new MemoryService({ projectRoot: projectPath })`, call `getStats()`, then `close?.()` in try/finally; a failure marks the critical DB check `fail`.
   - `export async function handleDoctorCommand(args: Record<string,string|boolean|undefined>): Promise<void>`: run checks, print colorized `✔`/`✖`/`⚠` lines with details and a trailing verdict, set `process.exitCode = report.ok ? 0 : 1`. Support `--project`, `--home`, `--opencode-config-dir`.
2. Wire `src/cli.ts` routing to `handleDoctorCommand` (already routed in Iteration 9); ensure `usage()` documents `doctor`.
3. Add `test/commands/doctor.test.ts` (vitest): with a temporary initialized git repo and injected `homeDir`/`opencodeConfigDir`, assert `runDoctorChecks` returns an `ok` report whose git/runtime/Muninn checks are `ok`, that after `setup()` the integration check sees the registered targets, and that a non-repo directory marks the git-repo critical check `fail` with `report.ok === false`. Keep the Muninn DB inside the temp project (pass an explicit dbPath) so the real `.huginn/` is never touched.
4. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 12 — Git Worktree Sandbox Manager
modules: src/engine/worktree.ts, test/engine/

Implement REQ-17 AC-17.1–AC-17.5 (SPEC.md §5). Use the existing `git(projectPath, args)` helper from `src/engine/diff.ts` (it is dual-runtime Bun/Node safe) for all git calls.
1. Create `src/engine/worktree.ts`:
   - `export interface Sandbox { iteration: number; path: string; branch: string; projectRoot: string; baseCommit: string; }`
   - `export function sandboxBranch(iteration: number): string` → `huginn/task-iter-<N>`; `export function sandboxPath(projectRoot: string, iteration: number): string` → `<root>/.huginn/worktrees/task-iter-<N>`.
   - `export class WorktreeManager`:
     - `createSandbox(projectRoot: string, iteration: number): Sandbox`: resolves HEAD via `headCommit`, throws if branch already exists (`git show-ref --verify --quiet refs/heads/<branch>` code 0) or the path already exists; `mkdirSync(dirname(path), { recursive: true })`; runs `git worktree add -b <branch> <path> HEAD`; on failure throws with stderr; then `linkSharedDeps(projectRoot, path)`.
     - `linkSharedDeps(projectRoot, sandboxPath)`: for each of `node_modules`, `.env` present at root and absent at sandbox target, `symlinkSync(rootPath, sandboxTarget, "dir" | "file")` (mode depends on source type); catch and emit a warning, never throw.
     - `promoteSandbox(sandbox): PromoteResult`: record active branch via `git rev-parse --abbrev-ref HEAD` in `projectRoot`; compute commits `git log --format=%H <baseCommit>..<branch>`; attempt `git merge --ff-only <branch>` in `projectRoot`; if non-zero fall back to `git cherry-pick <baseCommit>..<branch>`. `method = "ff" | "cherry-pick" | "none"` (none when there are zero commits). Finally remove worktree (`git worktree remove --force <path>`, tolerant) and delete branch (`git branch -D <branch>`, tolerant). Return `{ promoted, method, commits }`.
     - `discardSandbox(sandbox): void`: `git worktree remove --force <path>` tolerant of missing path; `git branch -D <branch>` tolerant; never fails if already gone.
     - `listSandboxes(): Sandbox[]`: parse `git worktree list --porcelain` and keep only entries under `<projectRoot>/.huginn/worktrees/`.
     - `cleanupAll(): void`: discard every listed sandbox (used as a safety net).
2. Add `test/engine/worktree.test.ts` (vitest): create a temp git repo (`git init`, commit a file), then exercise: create → assert worktree dir + branch exist and `node_modules`/`.env` symlink when present; make a commit inside the sandbox → `promoteSandbox` fast-forwards the primary branch and removes the worktree/branch; a second run with an internal conflicting commit uses cherry-pick or reports the conflict without corrupting the primary branch; `discardSandbox` leaves the primary working tree untouched; creating twice with the same iteration fails closed; `listSandboxes`/`cleanupAll` behave. Use `spawnSync`/the `git` helper for assertions and clean up temp dirs.
3. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 13 — CycleEngine Sandbox Integration, Documentation & Final Quality Gate
modules: src/engine/cycle.ts, src/engine/phases.ts, SPEC.md, ADR.md, DESIGN.md, README.md, test/

Implement REQ-17 AC-17.6 and finish documentation.
1. Integrate `WorktreeManager` into `src/engine/cycle.ts`:
   - Construct a `WorktreeManager` (injectable for tests) when `cfg.sandbox` is true.
   - In `runIteration`, before building the `PhaseContext`, `createSandbox(projectPath, iteration.index)` and set the context `projectPath`, `baseCommit`, and doc paths (`specPath`/`adrPath`/`planPath`) to the sandbox equivalents (docs are read from the sandbox). `EXECUTE`, `VALIDATE_STEP`, `TEST_MODULE` and every `FIX_*` phase must operate on the sandbox path (they all read `ctx.projectPath`).
   - On iteration success, `promoteSandbox(sandbox)` during/after `COMMIT_ALL` and record the outcome to the event log; on abort or phase error, `discardSandbox(sandbox)` and never touch the primary tree.
   - When `cfg.sandbox` is false, keep the current behavior byte-for-byte.
   - Register a process-level cleanup so an unexpected exit attempts `cleanupAll()` best-effort.
2. Ensure `src/engine/phases.ts` `commitAll`/`validateStep` operate correctly when `ctx.projectPath` is a sandbox path (they already key off `ctx.projectPath`; confirm no absolute assumption on the primary repo and adjust `dbPath` default if needed).
3. Update docs to match the implemented reality:
   - `SPEC.md`: already contains the Phase 3 section (REQ-14–17) — reconcile any final naming differences.
   - `ADR.md`: ADR-19 is already present — keep as the source of truth.
   - `DESIGN.md`: add a section describing the live-first entrypoint, config resolution, the integrator file matrix, the doctor checks, and the worktree sandbox lifecycle (create → execute → promote/discard) with a small diagram/table.
   - `README.md`: document `huginn` defaulting to live, `huginn setup`, `huginn doctor`, the `.huginn/config.json` schema + env vars + defaults, and `--sandbox`/`--no-sandbox`.
4. Final quality gate: `npm test` (`bun test && vitest run`) 100% green, `bun run typecheck` zero errors, `bun run build` succeeds.
