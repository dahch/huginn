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
1. Adjust `src/engine/worktree.ts` for conflict-recoverability (SPEC AC-17.4): in `promoteSandbox`, when both `merge --ff-only` and `cherry-pick` fail, run `git cherry-pick --abort` to restore the primary tree, remove the worktree, but **keep the branch** `huginn/task-iter-<N>` (do NOT `git branch -D`) and return `{ promoted: false, method: "cherry-pick", commits }` with a warning naming the preserved branch. On the zero-commit (`none`) and successful (`ff`/`cherry-pick`) paths, still remove the worktree and delete the branch. Update `test/engine/worktree.test.ts` so the conflict case asserts the branch is preserved and the primary tree is clean.
2. Integrate `WorktreeManager` into `src/engine/cycle.ts`:
   - Add an optional `worktrees?: WorktreeManager` to `CycleEngineOptions`; default to `new WorktreeManager(cfg.projectPath)` lazily only when `cfg.sandbox` is true. Add a public `cleanupSandboxes()` delegating to `cleanupAll()`.
   - At the start of `run()` (after the git-repo check), when sandbox is enabled, best-effort `worktrees.cleanupAll()` and log it, clearing stale sandboxes from a crashed prior run.
   - In `runIteration`, before building the `PhaseContext`, `createSandbox(this.cfg.projectPath, iteration.index)`; compute `workPath = sandbox?.path ?? this.cfg.projectPath`, `baseCommit = headCommit(workPath)`, and set the context `projectPath = workPath`, `baseCommit`, and doc paths to their sandbox equivalents (`join(sandbox.path, relative(primaryProject, docPath))`). `EXECUTE`, `VALIDATE_STEP`, `TEST_MODULE` and every `FIX_*` phase must operate on the sandbox path (they all read `ctx.projectPath`). Module inference (`inferModules`) must use `workPath`.
   - On iteration success (after the pipeline loop completes with no abort and not `--only-phase`), `promoteSandbox(sandbox)` and emit a log line recording the method + whether the branch was preserved; on abort or a thrown phase error, `discardSandbox(sandbox)` and never touch the primary tree. Use a `try/finally` with a handled flag so the early `return`s on abort and exceptions all clean up exactly once.
   - When `cfg.sandbox` is false, keep the current behavior byte-for-byte.
   - Register a process-level `SIGINT`/`SIGTERM`/`exit` cleanup so an unexpected exit attempts `cleanupSandboxes()` best-effort (in `src/cli.ts` for both `run` and live-handoff paths, or via the existing signal handlers).
3. Ensure `src/engine/phases.ts` `commitAll`/`validateStep` operate correctly when `ctx.projectPath` is a sandbox path. `commitAll` must **scan** modified files from the sandbox `ctx.projectPath` but **persist** the Muninn symbol graph to the **PRIMARY** project database (`ctx.dbPath`, resolved from `RunConfig.projectPath` via `resolveDatabasePath`) with `projectRoot = ctx.primaryProjectRoot`, so indexed symbols survive worktree cleanup (ADR-20); do not crash if the sandbox `.huginn/` is absent.
4. Add a `src/engine/cycle.test.ts` (bun:test) case asserting that with a stub/injected `WorktreeManager` and `cfg.sandbox = true`, `runIteration` calls `createSandbox`, points the phase context at the sandbox path, and calls `promoteSandbox` on success / `discardSandbox` on abort. Keep the existing `sandbox: false` fixtures passing unchanged.
5. Final quality gate: `npm test` (`bun test && vitest run`) 100% green, `bun run typecheck` zero errors, `bun run build` succeeds.

## Iteration 14 — Persistent Config CLI (`huginn config`)
modules: src/commands/config.ts, src/cli.ts, src/config.ts, test/commands/

Implement the CLI write/read path for REQ-14 AC-14.3 (the `saveUserConfig` layer currently has no runtime caller).
1. Extend `src/config.ts`:
   - Refactor the atomic write into a reusable internal `writeConfigAtomic(path, config)`.
   - Keep `saveUserConfig(projectPath, config)` writing `<project>/ .huginn/config.json`.
   - Add `saveGlobalUserConfig(homeDir: string, config: UserConfig): void` writing `<home>/.huginn/config.json` (same atomic/symlink-safe hardening).
   - Add a pure `describeModelSources(sources: ModelSources): { thinker: { value: string; source: "flag" | "project" | "user" | "env" | "default" }; executor: { ... } }` returning where each resolved value came from (reuse the precedence logic; do not duplicate it).
2. Add `src/commands/config.ts`:
   - `export function printConfigUsage(): void`.
   - `export async function handleConfigCommand(subcommand: string | undefined, args: Record<string,string|boolean|undefined>): Promise<void>`:
     - `show` (default): print the effective resolved thinker/executor via `resolveModelsFromConfig` + `describeModelSources`, and the project/user config file paths; `--project` (default cwd), `--home` (override).
     - `set`: require at least one of `--thinker`/`--executor`; persist via `saveUserConfig` (default) or `saveGlobalUserConfig` when `--global`; print what was written and where. Invalid/empty values → error + usage + `process.exitCode = 1`.
     - unknown/no subcommand → usage; unknown → red error + `process.exitCode = 1`.
3. Wire `src/cli.ts`: add `config` to `KNOWN_COMMANDS`, route to `handleConfigCommand` with the subcommand positional (same pattern as `memory`/`mcp`), and document `config` in `usage()`.
4. Add `test/commands/config.test.ts` (vitest): with temp `projectPath` + `homeDir`, `set --thinker X` writes `.huginn/config.json` and `show` reflects it with `source: "project"`; `set --global --executor Y` writes `<home>/.huginn/config.json`; `show` precedence across project/user/env/flag; unknown subcommand exits non-zero; no-flags `set` errors. Never touch the real home (inject `--home`/`homeDir`).
5. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 15 — Sandbox Enforcement & Gate Hardening
modules: src/server/client.ts, src/engine/cycle.ts, src/engine/phases.ts, src/engine/worktree.ts, src/agents/integrator.ts, src/cli.ts, src/config.ts, test/

Fix the findings from the Phase 3 final validation gate (critical sandbox enforcement + hardening).
1. **Enforce the sandbox on the agent (CRITICAL, AC-17.6).** The opencode SDK accepts a `directory` query param on `session.create`, `session.prompt`, and `session.command` (see `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`: `SessionCreateData`, `SessionPromptData`, `SessionCommandData` all have `query?: { directory?: string }`).
   - In `src/server/client.ts`: add an optional `directory?: string` to `createSession(client, title, directory?)`, `prompt(...)`, and `runCommand(...)`, forwarding it as `query: { directory }` on the SDK calls (omit the query when undefined).
   - In `src/engine/cycle.ts`: pass the sandbox path as the directory when creating the iteration session (`ensureSession`) and thread it through the `PhaseContext` (add a `directory?: string` field, or reuse `ctx.projectPath` — prefer an explicit field set to `workPath`).
   - In `src/engine/phases.ts`: every `prompt(...)` (execute, fixFindings/fixSpec/fixSecurity) and every `runCommand(...)` (validateStep, testModule, secureCheck, review, docSync, commitAll) must pass `directory: ctx.projectPath` so the agent operates inside the worktree.
   - When sandboxing is enabled, do not reuse a stale `iterationSessionId` (it was bound to another directory): create a fresh directory-scoped session each run.
   - Add a `src/engine/cycle.test.ts` case asserting `session.create` and `session.command`/`prompt` received `query.directory === sandbox.path` when `sandbox: true` (extend the client stub to capture options).
2. **Promotion conflict must fail closed (AC-17.6).** In `runIteration`, after `promoteSandbox`, if `!result.promoted && result.method !== "none"` throw a descriptive Error (the run then finishes as an error; the branch is preserved by the manager). `method === "none"` logs an informational "no changes to promote". Fix the log that currently calls a zero-commit no-op a "conflict".
3. **No-HEAD fallback (AC-17.6).** At the start of `run()` (or constructor), if `cfg.sandbox` is true but `headCommit(projectRoot)` is null, log a warning and proceed with in-place execution (`sandbox` effectively off) instead of throwing from `createSandbox`.
4. **Stale branch sweep (AC-17.7).** `WorktreeManager.cleanupAll()` (or the pre-run cleanup) must also delete leftover `refs/heads/huginn/task-iter-*` branches that have no worktree (e.g. `git for-each-ref --format=%(refname:short) refs/heads/huginn/task-iter-` then `git branch -D`). Update `test/engine/worktree.test.ts` to assert a preserved conflict branch is reclaimed by `cleanupAll` and that a subsequent `createSandbox` then succeeds.
5. **Model-resolution consistency (finding #2).** In `src/cli.ts`, resolve models from separated layers (`loadConfigLayers`) and pass `projectConfig`/`userConfig` distinctly to `resolveModelsFromConfig`, matching `huginn config show`, so a merged blob can never misattribute or drop a user value.
6. **Integrator file-mode preservation (SEC-1001).** In `src/agents/integrator.ts` `writeAtomic`, preserve an existing target's permission bits (default new files to `0o600`; create parent dirs `0o700` for the home-scoped secret-bearing configs). Rules files may stay world-readable. Add a test asserting an existing `0o600` config is not widened by `setup`.
7. **Small correctness fixes**: `worktree.ts` prefix check must use a path separator (`startsWith(base + sep)` or `path.relative`); log the actual reclaimed count (not unconditional); set the `agy` label to `"Antigravity CLI (agy)"` to match SPEC AC-15.2.
8. Verify: `bun test`, `bunx vitest run`, `bun run typecheck`, `bun run build` all green.

---

# Plan: Modern Multi-Agent Runtime, Fullscreen TUI, Provider Agnosticism, MCP & Skills (Phase 5)

## Iteration 19 — Fullscreen Terminal UI & Responsive Viewport Engine
modules: src/tui/, src/cli.ts

Implement desktop-grade fullscreen terminal UI with alternate screen buffer and dynamic viewport scaling:
1. Update `src/tui/render.tsx`:
   - Enter alternate screen buffer prior to Ink mounting: `process.stdout.write("\x1b[?1049h\x1b[H")`.
   - Ensure clean exit: `process.stdout.write("\x1b[?1049l\x1b[?25h")` on normal exit, `SIGINT`, `SIGTERM`, unhandled exceptions, and via a synchronous `process.on("exit")` listener so cursor visibility is guaranteed even on abrupt termination.
2. Implement responsive viewport hook `useTerminalSize()` in `src/tui/useTerminalSize.ts`:
   - Listen to `process.stdout.on("resize")` tracking `{ rows, columns }`.
   - Provide safe fallbacks when non-TTY or stdout dimensions are unavailable (default 80x24).
3. Refactor `src/tui/LiveDashboard.tsx` and `src/tui/Dashboard.tsx`:
   - Replace hardcoded `VISIBLE_CHAT_LINES = 12` and `VISIBLE_STREAM_LINES = 8` with dynamically calculated heights based on `rows`.
   - Scale layout to 100% height and width.
   - Enforce internal card scroll containment so mouse wheel / trackpad scrolling never spills into the host terminal emulator history.
4. Silence stdout log leakage in `src/cli.ts` & `src/tui/render.tsx`:
   - Redirect startup logs, server banner, and provider warnings into an internal splash screen or log buffer rather than printing directly to stdout before Ink mounts.
   - Implement hot console interception (`patchConsole`) redirecting any runtime `console.log`, `console.warn`, and `console.error` to the internal event drawer (`events.emit("log", ...)`) while the TUI is mounted, restoring standard console methods on exit.
5. Add unit and component tests verifying resize events, escape sequence emission, and screen cleanup.

## Iteration 20 — Decoupled Multi-Agent Runtime Architecture (IAgentRuntime)
modules: src/engine/agent/, src/config.ts, src/cli.ts

Decouple Huginn from OpenCode by introducing an agnostic agent runtime layer:
1. Create `src/engine/agent/types.ts`:
   - `IAgentRuntime`: `id`, `name`, `isAvailable()`, `getAvailableModels()`, `getMcpStatus()`, `createSession()`.
   - `IAgentSession`: `id`, `prompt()`, `runCommand()`, `abort()`.
2. Implement concrete adapters in `src/engine/agent/adapters/`:
   - `OpencodeRuntimeAdapter`: Wraps `opencode serve` and `@opencode-ai/sdk`.
   - `ClaudeRuntimeAdapter`: Connects to Claude Code CLI / stdio.
   - `CodexRuntimeAdapter`: Connects to OpenAI Codex CLI.
   - `OmpRuntimeAdapter`: Connects to Oh My Pi (`omp`) CLI.
   - `CommandCodeRuntimeAdapter`: Connects to Command Code CLI.
   - `QwenRuntimeAdapter`: Connects to Qwen Code CLI.
   - `GenericSubprocessRuntimeAdapter`: Extensible stdio JSON-RPC adapter for Pi, Kimi, and custom agents.
3. Create `src/engine/agent/registry.ts`:
   - `getAgentRuntime(id)` factory and auto-detector scanning `PATH` for installed binaries (`claude`, `opencode`, `codex`, `omp`, `command-code`, `qwen`).
4. Update `src/config.ts` and `src/cli.ts`:
   - Add `agent?: string` to `UserConfig` and `RunConfig`.
   - Add `--agent <id>` CLI flag.
   - Route `CycleEngine` and `LiveEngine` to execute via `IAgentRuntime`.
5. Add tests in `test/engine/agent/` verifying adapter dispatch, CLI probe, and session execution.

## Iteration 21 — Interactive Model & Provider Selector & Persistence
modules: src/config.ts, src/tui/, src/engine/
 
Implement dynamic provider discovery, interactive onboarding picker, and in-session model switching:
1. Dynamic model discovery via `runtime.getAvailableModels()`.
2. Create interactive TUI model picker component `src/tui/ModelPickerModal.tsx`:
   - Keyboard navigable list (arrow keys, search filter, enter) to choose Thinker and Executor models.
   - Displays provider group badges (e.g. Anthropic, OpenAI, Google, Ollama, Groq).
3. Onboarding flow:
   - When running `huginn` without pre-configured models and default models are absent from active runtime, pop up the picker modal.
   - Prompt *"Save as default? [Project / Global / Session only]"* and persist to `.huginn/config.json` or `~/.huginn/config.json`.
4. In-session model switching:
   - Implement `/models` and `/model <thinker> [executor]` slash commands in `LiveDashboard.tsx` allowing hot-swapping models during active sessions.
5. Unit tests for model discovery, picker state, and config persistence.

## Iteration 22 — Live MCP Monitor, Inspector & Multi-MCP Configuration
modules: src/tui/, src/muninn/mcp/, src/engine/

Implement real-time MCP status visibility, interactive inspector, and multi-MCP project declarations:
1. Status Bar Pill:
   - Add live MCP health indicator to TUI header: `MCP: 🟢 <count> active (<tools> tools)`.
   - Periodic non-blocking health check against active runtime's MCP subsystem (`runtime.getMcpStatus()`) bounded by a strict 1500 ms timeout via `Promise.race` / `AbortSignal.timeout(1500)` so remote/hung MCP servers never freeze the UI.
2. Interactive `/mcp` inspector modal in `src/tui/McpInspectorModal.tsx`:
   - Lists all connected MCP servers (Muninn + third-party servers).
   - Displays transport type, latency, and list of exposed tools with descriptions.
3. Multi-MCP project configuration:
   - Read `.huginn/mcp.json` and auto-register external servers with the active runtime.
4. Add tests for MCP polling, inspector modal rendering, and `.huginn/mcp.json` parsing.

## Iteration 23 — Extensible Skills System & Rich Slash Commands
modules: src/engine/skills/, src/tui/, src/engine/liveMode.ts

Implement modular skills engine and full suite of interactive slash commands:
1. Skills loader `src/engine/skills/loader.ts`:
   - Discover skills in `.huginn/skills/*.md` and `.opencode/skills/*.md`, plus built-in `audit`, `refactor` and `explain`.
   - Parse skill metadata (title, description, trigger) and body prompt.
2. Rich slash commands dispatcher in `src/engine/liveMode.ts` and `src/tui/LiveDashboard.tsx`:
   - `/help`: Opens interactive cheat sheet with all commands and keybindings.
   - `/agent [id]`: Switch or view active agent runtime.
   - `/models [m]`: Switch or view active models.
   - `/mcp [id]`: Inspect MCP servers and tools.
   - `/skills`: List and execute custom skills.
   - `/status`: Show system diagnostics (branch, dirty state, worktree sandbox, runtime, models, memory stats).
   - `/clear`: Clear chat viewport history.
   - `/draft`: Trigger document drafting.
   - `/quit`: Confirm and exit cleanly.
3. Add tests verifying skill discovery, markdown parsing, and command dispatching.

## Iteration 24 — CLI Ergonomics: `huginn init` Wizard & Help Redesign
modules: src/commands/init.ts, src/cli.ts

Refactor CLI ergonomics to provide a welcoming developer onboarding experience:
1. Implement `huginn init` in `src/commands/init.ts`:
   - Guided terminal wizard: detects git repo, scans installed agent CLIs, prompts for default agent and models, runs `huginn setup`, and writes initial `.huginn/config.json`.
2. Redesign `huginn --help`:
   - Categorize output into Primary / Essential commands (`live`, `run`, `init`, `setup`, `doctor`) vs Advanced options.
   - Add concise examples and flag grouping.
3. Greenfield / unconfigured launch ergonomics:
   - When running `huginn` with no arguments in a repository that has never run Huginn, launch the init wizard or interactive onboarding instead of failing or dumping raw warnings.
4. Add test suite in `test/commands/init.test.ts` verifying wizard steps and config emission.

---

# Plan: Runtime Fidelity, Discoverability & Live Diagnostics (Phase 6)

Implements REQ-27…REQ-31 (SPEC.md §10). Repo facts for every iteration: Bun/TypeScript CLI, bin `src/cli.ts`; `src/**/*.test.ts` run under `bun test`, `test/**/*.test.ts` under `vitest run`; strict TS, ESM, `.js` extension on relative imports, no `any`. All parsers of external output must route every displayed string through `sanitizeTerminalText` (`src/util/text.ts`).

## Iteration 25 — Truthful Cross-Runtime Model Discovery & Native Selection
modules: src/engine/agent/adapters/, src/engine/agent/, src/cli.ts, src/tui/ModelPickerModal.tsx, test/engine/agent/

Implements REQ-27. Verified defects to fix: opencode returns 8 195 catalog models instead of the 581 connected ones and falls back to two fake defaults; commandcode returns a single literal vs its real 82; `validateModels` reads the wrong response field; models are passed as an unread `HUGINN_MODEL` env var.

1. `src/engine/agent/adapters/opencode.ts` `getAvailableModels()`:
   - Type the response as `{ all?: Array<{ id: string; name: string; models?: Record<string, { id: string; name: string; description?: string }> }>; connected?: string[] }`.
   - Build the catalog **only** from providers whose `id` is in `connected`. Do not return hardcoded models on failure or empty.
   - On throw/empty, fall back to parsing the `opencode models` CLI (one `provider/model` per line) via a bounded `spawnSync`/`Bun.spawn` with a short timeout; strip blank lines and any non-`provider/model` noise. Return `[]` (not fakes) if that also fails.
2. `src/engine/agent/adapters/commandcode.ts`: implement `getAvailableModels()` by running `commandcode --list-models` and parsing it. Parser rules (derived from the real output): skip the `Available models  ·  N models` header; a line with no leading whitespace and no double-space gap to a description is a **group heading** (skip); a line matching `^\s*(\S+)\s{2,}(.+)$` is a model row → id = group 1, description = group 2; stop consuming once the atomic-list block ends (the trailing `Pass the full id…` / `cmd --model …` / `Docs:` / `Decision models` footer must be ignored — detect the footer start and break). Provider = the id's prefix before the first `/` when present, else the current group heading. Map to `ModelInfo[]`; on any failure return `[]`.
3. `src/engine/agent/adapters/generic.ts`: add `modelListCommand?: { command: string; args: string[]; parse: (stdout: string) => ModelInfo[] }` to `GenericSubprocessOptions`, and have `getAvailableModels()` prefer it over the static `models` array. When neither is present, return `[]` (delete the `${id}/default` fabrication). Add `modelArgs?: (model: string) => string[]` so a runtime can pass its native flag.
4. Per-runtime wiring: set `modelListCommand` for `claude`, `qwen`, `omp`, `gemini`, `kimi`, `pi` where the CLI supports listing (probe each CLI's help first and only wire the ones that expose it); fix the wrong `args` for commandcode (verified: the non-interactive form is `-p`/`--print`, **not** `exec`) and pass the model via `--model`/`-m`.
5. `src/engine/agent/adapters/generic.ts` `prompt()`: replace the `HUGINN_MODEL`-only channel with the runtime's `modelArgs(model)` appended to argv (keep `HUGINN_MODEL` as an additional env hint only). Guard against duplicate/conflicting flags.
6. `src/cli.ts` `validateModels()`: read `(res as { providers?: Array<{ id: string }> }).providers ?? []` instead of `.all`.
7. `src/tui/ModelPickerModal.tsx`: remove the `DEFAULT_FALLBACK_MODELS` substitution for empty/error results; render a distinct empty state ("No models discovered from <runtime> — type a provider/model id and press Enter") and a sanitized error state; make large catalogs responsive (incremental/bounded rendering while keeping the existing 6-row window and substring filter); replace the opencode-centric seed values with per-runtime seeds.
8. Tests (vitest, `test/engine/agent/`):
   - opencode: start a local `node:http` server returning a **captured real** `GET /provider` payload (with `all` > `connected`) and assert only connected-provider models are returned; assert the fallback parser maps captured `opencode models` output (581 lines) correctly and that failure returns `[]`.
   - commandcode: assert the parser maps the captured `commandcode --list-models` fixture (82 models, group headings + footer) to the exact expected ids and ignores the footer.
   - generic: assert `modelListCommand` is preferred, `[]` is returned with no fake default, and `modelArgs` appears in the spawned argv (use a fake executable in the temp dir).
9. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 26 — Slash-Command Palette & Inline Autocomplete
modules: src/tui/, src/engine/liveMode.ts

Implements REQ-28.
1. Create a single command registry (`src/tui/commandRegistry.ts` or `src/engine/commands.ts`): `{ id, aliases, argHint, description, category }` covering every Phase 5 command (`/help`, `/agent`, `/models`|`/model`, `/mcp`, `/skills`|`/skill`, `/status`, `/clear`, `/draft`|`/go`, `/quit`|`/abort`) plus lookup helpers (`matchCommands(prefix)`, `findCommand(token)`).
2. Refactor `src/tui/LiveDashboard.tsx` `submit()` to resolve the command through the registry (identity + alias), keeping the existing per-command argument handling. Keep unknown-`/…` behavior unchanged.
3. Add a `CommandSuggestions` component rendered directly beneath `ChatInputRow` when `draftInput.startsWith("/")` and no space has been typed yet; filter by id/alias substring; render ≤6 rows with `▲/▼` scroll markers; highlight the selected row.
4. `useInput` precedence: when the overlay is open, intercept `↑`/`↓`/`j`/`k` (move highlight), `Tab` (accept), `Enter` (accept+submit), `Esc` (dismiss overlay) **before** the existing focus (`Tab`) and scroll-trap (`↑`/`↓`) branches; when closed, behavior is unchanged.
5. Include the overlay height in the layout budget (`availableHeight`) so chat/stream cards never overflow; re-verify the `headerHeight`/`inputHeight` math.
6. `HelpModal.tsx`: generate `SLASH_COMMANDS` from the registry (delete the hand-maintained array) so the cheat sheet cannot drift.
7. Tests (vitest, `test/tui/`): registry-drift guard (every dispatched command present, every registry entry dispatchable); prefix matching; overlay renders on `/` and filters as more characters are typed; accepting inserts the command with its arg hint; existing model-picker/mcp/skills/help modal tests still pass.
8. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 27 — Raven Identity & TUI Presence
modules: src/tui/, src/banner.ts

Implements REQ-29.
1. Create `src/tui/RavenHeader.tsx` exporting the ASCII raven mark + `HUGINN` wordmark (reuse/adapt the `banner.ts` art), with a narrow-terminal fallback (wordmark only) driven by `useTerminalSize()`.
2. Replace the `🦅 HUGINN` header text in `src/tui/Dashboard.tsx` (`HeaderCard`) and `src/tui/LiveDashboard.tsx` (`LiveHeader`) with the shared component. Remove every `🦅` from the source.
3. Keep/relocate live context (runtime, thinker/executor, project, MCP badge) into the header so presence is meaningful; ensure the header's row cost stays within the existing layout budget.
4. Ensure the ASCII art is sanitization-safe and contains no control characters; guard against terminals narrower than the art.
5. Tests (vitest, `test/tui/`): header renders the raven mark + wordmark at ≥80 cols; collapses to wordmark-only when narrow; no `🦅` appears in the rendered output; existing dashboard/header tests updated.
6. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 28 — Honest MCP/Muninn Liveness & stdio Hardening
modules: src/commands/memory.ts, src/muninn/mcp/, src/engine/agent/adapters/, src/engine/agent/mcpStatus.ts, src/server/lifecycle.ts, src/tui/

Implements REQ-30.
1. `src/engine/agent/adapters/generic.ts` `getMcpStatus()`: stop hardcoding `status: "connected"`. Config-discovered servers are reported as `unknown` (extend `McpServerStatus.status` with `"unknown"`, or use `disconnected` + an explicit `unverified` flag — pick one and thread it through `formatMcpBadge` and `McpInspectorModal`). `healthy` must be false when servers are unverified.
2. `src/engine/agent/adapters/opencode.ts` `getMcpStatus()` catch: return `{ servers: [], totalTools: 0, healthy: false, degraded: true, error: sanitizeTerminalText(err.message) }` so the badge shows `MCP: 🟡 error` instead of a neutral gray.
3. `src/engine/agent/mcpStatus.ts` `formatMcpBadge()`: render the new `unknown`/error states distinctly (e.g. `MCP: ⚪ n unverified`, `MCP: 🟡 error`), and ensure the 1.5 s timeout timer is `.unref()`'d.
4. `src/commands/memory.ts` `handleMcpCommand` ("run" branch): install `process.stdout.on("error", …)` (swallow EPIPE / exit cleanly); bridge `process.stdin` `'end'`/`'close'` to the same `done()` used by `transport.onclose`; assign `server.onerror = (e) => log`; ensure the `finally` still closes service+server.
5. `src/muninn/mcp/server.ts`: give `send()` a bounded write so a broken pipe rejects instead of awaiting `'drain'` forever (wrap with a timeout + `stdout` error rejection).
6. `src/server/lifecycle.ts`: after `waitForHealth`, attach an `exit`/`error` listener on the child that marks the handle unhealthy and logs (`[huginn] opencode server exited (code N)`); expose the state so `OpencodeRuntimeAdapter` can report a recoverable error and (best-effort) restart once.
7. `src/engine/liveMode.ts` `getDiagnostics()`: distinguish a Muninn DB failure from an empty DB — on error, report the sanitized error rather than `0 entities, 0 observations`; update the `/status` row accordingly.
8. `src/engine/phases.ts`: keep indexing non-fatal but log at debug (`HUGINN_DEBUG`) instead of a bare `catch {}`.
9. Tests (vitest/bun): `getMcpStatus` unverified path; opencode catch → degraded+error; badge formatting for unknown/error; mcp-run exits on stdin `'close'` (spawn the built CLI, close stdin, assert exit within a bound); `send()` broken-pipe does not hang; diagnostics error path.
10. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 29 — Fluid Feedback & Intuitive DX Polish
modules: src/tui/, src/cli.ts, src/engine/liveMode.ts

Implements REQ-31.
1. Audit every `submit()` branch and ensure each emits a sanitized acknowledgement (busy → result → error) so no input is a silent no-op; standardize the system-message wording for success/failure.
2. Actionable errors: replace bare `(err as Error).message` output with a component + next-step hint (e.g. models → "try `/model <id>`"; runtime → "run `/agent`"; mcp → "run `/mcp`").
3. Empty-chat guidance: when the chat viewport is empty, render a short raven-flavoured hint list (type `/` for commands, `/draft` to plan, `/mcp` to inspect) consistent with REQ-29's identity.
4. Confirm no stdout leaks while mounted (AC-21.3) and that the palette from Iteration 26 is reachable from the hint.
5. Tests (vitest, `test/tui/`): each command emits a visible message; error messages contain the hint; empty-state hint renders; no direct `console.log` on the TUI path.
6. Final quality gate: `npm test` (`bun test && vitest run`) 100% green, `bun run typecheck` zero errors, `bun run build` succeeds.

---

# Plan: Per-Agent MCP Truth, Composer Ergonomics & Methodology Profiles (Phase 7)

Implements REQ-32…REQ-38 (SPEC.md §13). Same repo facts as Phase 6 (Bun/TS, bin `src/cli.ts`, `src/**/*.test.ts` → `bun:test`, `test/**/*.test.ts` → vitest, strict TS, ESM, `.js` imports, no `any`, `sanitizeTerminalText` for every externally-sourced display string). Capture real CLI output as fixtures under `test/fixtures/` before writing parsers, and keep the fixture-hygiene guard green (never commit secrets — the provider payload lesson).

## Iteration 30 — Per-Agent MCP Enumeration & Honest Attribution
modules: src/engine/agent/, src/tui/, src/commands/, test/engine/agent/, test/fixtures/

Implements REQ-32. Verified: `opencode mcp list` (box list, `● ✓ <name> connected` + command, `N server(s)`), `agy mcp list` (TSV `NAME TYPE STATUS COMMAND/URL`, `enabled`), `claude mcp list` (`<name>: <cmd> - ✔ Connected`, health-checks), `qwen mcp list` (`✓ <name>: <cmd> (<transport>) - Connected`), `commandcode mcp list` (table `NAME TYPE SCOPE AUTH STATUS` + `Total: N server(s)`).

1. Capture each listing to `test/fixtures/<cli>-mcp-list.txt` (redact anything secret-shaped) and add the entries to `test/fixtures/README.md`.
2. `src/engine/agent/types.ts`: add `McpServerListing = { name; transport?; status: "connected"|"enabled"|"disabled"|"pending"|"unknown"; detail? }` and optional `listMcpServers?(): Promise<McpServerListing[]>` on `IAgentRuntime`.
3. Add exported pure parsers (one per format, in the corresponding adapter or a shared `mcpList.ts`) + a bounded runner reusing `modelList.ts`'s `runModelListCommand` (timeout, stdout cap, kill process group, stderr reason). Implement `listMcpServers()` for `opencode`, `claude`, `qwen`, `agy`, `commandcode`; `omp`/`kimi`/`pi`/`cursor`/`windsurf` fall back to config-file discovery with `status: "unknown"`.
4. Honest status mapping per AC-32.2; only `connected` counts as live. Where a CLI reports nothing (e.g. `agy`'s `enabled`), never upgrade it to `connected`.
5. `src/engine/agent/mcpStatus.ts` `fetchMcpStatusWithTimeout`: prefer `listMcpServers()` when present, map to `McpStatusReport`; **nullish-coalesce every numeric field** (`report.totalTools ?? 0`) and make `formatMcpBadge` self-describing and attributed: `MCP: 🟢 n connected · <agent>`, `MCP: ⚪ n configured · <agent>`, `MCP: ⚪ none · <agent>`, `MCP: 🟡 error — <reason> · <agent>`.
6. `src/tui/McpInspectorModal.tsx`: render `name · transport · status · detail`; add a header line naming the source agent and the expectation ("these come from **<agent>** — add/change them in the agent's own config; Muninn’s brain is project-scoped and independent of the agent"); flag Muninn presence/absence with the exact fix command.
7. Tests: fixture-based parser tests per format; status mapping; badge strings for every state; a guard asserting no MCP surface can render `undefined`/`NaN` (drive each state, assert the strings are absent); attribution present.

## Iteration 31 — Interactive Runtime Picker
modules: src/tui/, src/engine/liveMode.ts

Implements REQ-33.
1. New `src/tui/AgentPickerModal.tsx`: rows from `AGENT_TARGETS` with label, `available`/not-installed marker, detected path, active marker; `↑/↓/j/k`, `Enter` switch, `Esc` cancel.
2. `LiveDashboard.tsx`: `/agent` (no arg) opens the picker instead of printing the list; keep `/agent <id>`; on switch failure emit an actionable message (`NEXT_STEP.runtimeSwitch`) and keep the modal open.
3. Use `detectAvailableAgents()` for availability (async, non-blocking, loading state).
4. Tests (vitest, `test/tui/`): picker lists all targets, marks the active one, switches on Enter, fails closed on an unavailable target, Esc cancels; existing `/agent` tests updated.

## Iteration 32 — Composer Ergonomics, Panel Honesty
modules: src/tui/

Implements REQ-34 + REQ-35.1/35.2.
1. Input history: a bounded (≥50) per-session list of submitted drafts in `RefineView`; when the palette is closed and the draft is empty (or the caret is at the boundary), `↑` recalls older and `↓` walks forward to the empty draft; recalled text stays editable; slash-command submissions are not added to history.
2. Composer presence: give `ChatInputRow` its own accent border/background and a clearer prompt glyph so it anchors the view; keep the single-line footer and the layout budget correct at 80×24 (and after Phase 6's palette).
3. Rename `REFINEMENT CONVERSATION` → `Conversation` (TUI + docs).
4. Adaptive stream panel: when the session has received no reasoning/stream content, the agent panel renders collapsed (its rows return to the conversation); it expands on first content and never shows an empty bordered box.
5. Tests: history recall/forward/editing; no history entries for slash commands; the composer keeps the frame inside 80×24 with and without the palette; the stream panel is absent until content arrives, then present; the renamed panel appears.

## Iteration 33 — Target Hygiene: Remove `gemini`
modules: src/agents/, src/engine/agent/, src/cli.ts, src/commands/, docs, tests

Implements REQ-35.3. Verified: `gemini -p` requires an argument; the adapter passes none and writes the prompt to stdin, so the CLI enters interactive mode and hangs; `agy` supersedes it.
1. Remove `gemini` from `AGENT_TARGETS`/`AGENT_REGISTRY` and the `registry.ts` factory; delete the `gemini` case and any docs/README/SPEC/DESIGN/AGENTS mentions (keep `agy`).
2. Backward compatibility: a persisted `agent: "gemini"` must not throw — `resolveAgent`/config sanitization falls back to detection with a warning (add a test).
3. Update every test/fixture that enumerates targets (registry barrel, setup, doctor, init wizard, `AGENT_TARGETS` counts).
4. Verify: `bun run typecheck`, `bun test`, `bunx vitest run` green.

## Iteration 34 — Methodology Profiles (Huginn Cycle + SDD/ODD/RDD/Strict-TDD)
modules: src/config.ts, src/engine/cycle.ts, src/engine/types.ts, src/engine/phases.ts, src/state/, src/commands/config.ts, src/cli.ts, src/tui/, test/

Implements REQ-36. The pipeline is already data (`PIPELINE`, cycle.ts:55-64) and `mode` is the precedent for a validated enum wired through flag → `UserConfig` → `sanitizeConfig` → persisted state.
1. `ProfileName = "huginn" | "sdd" | "odd" | "rdd" | "strict-tdd"`; add to `RunConfig`/`UserConfig`/`stateSchema`, sanitize like `mode`, default `huginn`.
2. `--profile <id>` on both `run` and `live` (and `huginn config set --profile`); validate against the profile list, fail closed with usage on an unknown id.
3. Replace the `PIPELINE` constant with `PIPELINES: Record<ProfileName, PipelineStep[]>`; `CycleEngine` selects by `cfg.profile`; make `MAIN_PHASES`-derived concerns (`--only-phase` validation, progress rendering, `PHASE_LABEL`) profile-aware.
4. Define the four profiles over the existing phase vocabulary (reorder/subset), adding new `PhaseName` members only where a methodology genuinely needs one (e.g. a failing-test step for `strict-tdd`, a receipt step for `rdd`), together with their labels and prompts. `strict-tdd`/`rdd` record a **frozen worktree snapshot** (commit SHA + tree hash) as machine-checkable evidence in the iteration state.
5. Announce the active profile in the TUI header/`/status` and the CLI banner; a profile whose prompts/templates are unavailable fails closed with an actionable message (never silently falls back to `huginn`).
6. Tests: profile selection per config/flag/precedence; `PIPELINES` shape per profile; fail-closed on unknown/misconfigured profile; `strict-tdd` writes a snapshot receipt and the gate references it; removed/unknown persisted profile falls back with a warning; a snapshot test on the default `huginn` pipeline proving it is unchanged.

## Iteration 35 — Agent-Agnostic Question Protocol & Honest Decision UI
modules: src/engine/, src/tui/, templates/, test/

Implements REQ-37.
1. Define the protocol: `<<<HUGINN_QUESTION>>>` … `<<<END_HUGINN_QUESTION>>>` containing `QuestionItem[]` JSON. Add an exported parser (`parseQuestionBlock`) returning `{ questions, cleanedText }`; strip the block from displayed text; sanitize everything; on unparseable payload, return the raw (sanitized) text as a warning rather than dropping it.
2. Wire it into the subprocess session path (`generic.ts` / `phases.ts` / `liveMode.ts`): after a prompt completes, if the output carries a block, raise a `kind: "question"` `DecisionRequest` through the existing broker and, on answer, resume with a follow-up turn carrying the chosen labels (or free text). Bound the number of chained questions per turn to avoid loops.
3. Keep opencode's `permissions.ts` native path; ensure both produce the same `DecisionRequest`.
4. `DecisionModal` (and `resolveDecisionKey`): render `questionItems` with per-option rows + description, numeric and `↑`/`↓` selection, `Enter` confirm, multi-select when `multiple`, free-text when `custom`; every keypress yields feedback and nothing is silently swallowed; timeout on a pending question aborts with a message.
5. Document the protocol for users (README/SPEC/DESIGN + the injected rules block) so an agent can be told to ask.
6. Tests: parser (valid/truncated/absent/empty-options); end-to-end with a synthetic subprocess agent that emits a block and receives the follow-up; opencode native path unchanged; modal option selection, multi-select and free text (currently untested — `grep` shows no `DecisionModal` test).

## Iteration 36 — Muninn Provisioning, Agent-Independent Memory & Final Gate
modules: src/commands/, src/engine/, src/agents/, src/tui/, src/muninn/, test/, docs

Implements REQ-38.
1. **One brain assertion**: prove the DB is project-scoped and never keyed by `runtime.id`; add a test that switches runtime mid-session and observes identical Muninn stats.
2. **Choose the fleet**: extend `huginn setup` (or add `huginn mcp setup`) to list `detectAvailableAgents()` results, mark which already register Muninn (using `listMcpServers()` from Iteration 30), and offer **all installed** or a per-agent selection; non-interactive `--agent <id>` (repeatable) and `--all`; skip uninstalled with a note; `--dry-run`/report mode.
3. **Native `mcp add` first**: use `opencode/claude/qwen/agy/commandcode mcp add` when present (idempotent, verified argument form) and fall back to `registerMcpForTarget` (atomic, symlink-safe, key-preserving); existing entries are no-ops; unparseable configs are reported, never rewritten.
4. **Provisioning matrix**: `huginn doctor` and `/mcp` render agent × (installed · Muninn registered · source) with the exact fix command.
5. **Profiles lean on the brain**: ensure the injected rules block (`AGENTS.md`/`CLAUDE.md`/… via `injectRulesForTarget`) mandates `muninn_context`/`muninn_inspect_symbol` before changes and `muninn_verify_contract` before final code, and that the `huginn` profile's gates treat contradicting Muninn evidence as blocking.
6. Doc-sync README/DESIGN/SPEC/AGENTS for Phase 7.
7. Final quality gate: `bun run typecheck` zero errors, `npm test` green, `bun run build` succeeds; verify the real flows end-to-end (MCP listing per agent, Muninn registration on a temp fake agent config, profile selection).

---

# Plan: Run Integrity, Honest Surfaces & a Coherent Terminal Language (Phase 8)

Implements REQ-49…REQ-54 (SPEC.md §19–21). Origin: a real `huginn run` on a five-iteration
project completed iteration 1, produced four commits, reported `🛑 ABORTED`, and left the project
directory **empty**; the same run left a foreign `projects` row (huginn itself) in the project's
Muninn database; the run dashboard's output panel stayed at `(waiting for agent stream / tool
executions...)` for the whole run; and no in-session surface could select a methodology profile.

Repo facts for every iteration: Bun/TypeScript CLI, bin `src/cli.ts`; `src/**/*.test.ts` run under
`bun test`, `test/**/*.test.ts` under `vitest run`; strict TS, ESM, `.js` extension on relative
imports, no `any`; every externally-sourced display string passes through `sanitizeTerminalText`
(`src/util/text.ts`). **The gate marker literals** (`### Overall gate: 🟢/🟡/🔴`,
`### Overall fidelity: …`) are a three-way contract between `src/engine/steps/instructions.ts` +
`src/engine/phases.ts` + `src/engine/gate.ts`; **never** change them when touching display glyphs.

## Iteration 37 — Sandbox Promotion Integrity & Honest Outcomes
modules: src/engine/worktree.ts, src/engine/cycle.ts, src/state/schema.ts, src/state/store.ts, src/tui/Dashboard.tsx, test/engine/

Implements REQ-49. Verified root cause (reproduced in an isolated clone): `git merge --ff-only`
refuses when the primary tree holds an **untracked** file the sandbox branch also adds
(`error: The following untracked working tree files would be overwritten by merge: AGENTS.md`); the
`cherry-pick` fallback hits the same collision; `promoteSandbox` runs `cherry-pick --abort`, removes
the worktree, **keeps the branch**, and returns `{ promoted:false, method:"cherry-pick" }`;
`runIteration` throws and `run()` records `aborted: true`, so `.harness/PROGRESS.md` and the TUI
report `🛑 ABORTED` while the primary branch is untouched and the iteration's commits are stranded
on `huginn/task-iter-N`. (The colliding file is often huginn's own: `injectRulesForTarget` writes
`<project>/AGENTS.md` after the bootstrap commit, so it is untracked and collides with the
doc-writer's `AGENTS.md` in the sandbox.)

1. `WorktreeManager.promoteSandbox` (`src/engine/worktree.ts`) — resolve collisions **before**
   integrating, never destroy user data:
   - `untrackedCollisions(root, sandbox)`: `git ls-files --others --exclude-standard` in the primary
     root ∩ `git diff --name-only <baseCommit>..<branch>` → the paths the integration would
     overwrite.
   - Back each collision up to `<root>/.huginn/promotion-backup/<stamp>/<relPath>` preserving content
     and mode (`copyFileSync` + `chmodSync`), then remove the working-tree copy so integration can
     proceed. `<stamp>` is filesystem-safe (ISO-8601 with `:`/`.` replaced).
   - Retry `git merge --ff-only`; on failure `git cherry-pick <baseCommit>..<branch>`; on failure
     `git cherry-pick --abort`, **restore every backed-up file to its original path**, keep the
     branch (do not `git branch -D`) and return
     `{ promoted:false, method:"cherry-pick", commits, backups, detail }`. The zero-commit path stays
     `method:"none"`.
   - Extend `PromoteResult` with `backups?: string[]` and `detail?: string`; the successful ff /
     cherry-pick paths report the backup directory too.
2. `CycleEngine` (`src/engine/cycle.ts`) — a promotion failure is not an abort:
   - Add `promotion?: { status: "promoted" | "none" | "conflict" | "failed"; branch: string;
     backups?: string[]; detail?: string }` to the engine, persisted on the state.
   - On a promotion error set `outcome.reason = "error"` with the structured `promotion` record and
     the error message; **do not** set `state.aborted`. Log a single line naming the branch and the
     backup directory when one exists.
   - The `finally` must keep discarding an unsettled sandbox exactly once (unchanged), but must not
     delete a branch `promoteSandbox` deliberately preserved.
3. `src/state/schema.ts` + `src/state/store.ts`:
   - Add an optional `promotion` object to `stateSchema` so pre-Phase-8 state files still parse.
   - `renderProgressMarkdown` renders `🔴 PROMOTION FAILED — branch <b> preserved (backups: <dir>)`
     when `state.promotion?.status` is `conflict`/`failed`, and `🛑 ABORTED` only for a genuine abort.
4. `src/tui/Dashboard.tsx`: when the run ends with a failed promotion, surface the branch (and backup
   directory) in a visible line instead of only a generic end state.
5. Tests (`test/engine/worktree.test.ts`, `test/engine/cycle.test.ts`, state rendering): an untracked
   collision is backed up and the merge lands on the primary branch; an unresolvable collision
   restores the originals and leaves the primary tree byte-identical with the branch preserved; a
   promotion failure never renders as ABORTED.
6. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 38 — Muninn: One Root for the Database and the Project Record
modules: src/muninn/db/client.ts, src/muninn/service/memory-service.ts, src/commands/memory.ts, src/commands/doctor.ts, test/muninn/

Implements REQ-50. Verified root cause: the database **file** is resolved from `process.cwd()`
(`getDatabase` → `resolveDatabasePath(dbPath)` never receives a start directory) while the project
**row** is resolved from `--project` (`ensureProject({ rootPath })`), so
`huginn mcp run --project X` executed with a cwd inside `Y` writes X's project row — and, via
`muninn_save`/`memory index`, X's entities and observations — into **Y's** `muninn.db`. That is how a
`huginn` project row (root `/Users/dahch/Documents/Projects/huginn`) appeared inside a test project's
database.

1. `src/muninn/db/client.ts`:
   - `getDatabase(dbPath?: string, startDir?: string)` forwards `startDir` to
     `resolveDatabasePath(dbPath, startDir ?? process.cwd())`.
   - `ensureProject` keeps `options.rootPath`, but its **fallback** must be the same root the caller
     used for the database (accept an explicit `startDir`/`defaultRoot`) instead of an independent
     `findGitRoot()` of the cwd.
2. `src/muninn/service/memory-service.ts`: the constructor opens the database with the project root
   (`getDatabase(options?.dbPath, options?.projectRoot)`) and creates the row from the same root, so
   the two can never diverge. Document the invariant.
3. `src/commands/memory.ts` (`memory index/search/sync`, `mcp run`): resolve `--project` once and pass
   it as `projectRoot` so the database lives at `<project>/.huginn/muninn.db` regardless of cwd. Warn
   (dim, non-fatal) when the resolved database's git root differs from `--project`.
4. `src/commands/doctor.ts`: add a check that lists foreign `projects` rows in the project's database
   (root_path ≠ the project root) and prints the exact fix, **without deleting anything**.
5. Tests (`test/muninn/`): the database path follows `--project` from any cwd; running `--project X`
   from a cwd inside `Y` creates only X's row and writes nothing into `Y`'s database; `doctor` flags a
   foreign row.
6. Screen the **whole** `.huginn` surface, not just the database: the durable JSONL export
   (`syncToDisk`/`importFromDisk`) goes through `assertDocPath` too, so a repository-shipped
   `.huginn/memories.jsonl` symlink can be neither written through nor read from — the read direction
   would otherwise pull foreign content into the database, where the MCP memory tools serve it to the
   agent (SEC-006). The `doctor` attribution check compares canonical (`realpath`) roots so a project
   reached through a path alias is not reported as a foreign row.
7. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 39 — The Run Output Panel Is Never Dead
modules: src/tui/Dashboard.tsx, src/tui/feedback.ts, src/brand.ts, src/engine/agent/types.ts, test/tui/

Implements REQ-51. Verified: `phaseStream` is emitted **only** by `subscribeToEvents`
(`src/engine/permissions.ts`, wired in `src/cli.ts` when `runtime.id === "opencode"`). Every
subprocess runtime (`commandcode`, `claude`, `codex`, …) emits nothing, so `StreamCard` renders
`(waiting for agent stream / tool executions...)` for the entire run — and the phase's real
`PhaseResult.text` is never shown as body text, only as a one-line `ReportPill`.

1. `src/engine/agent/types.ts`: add a capability flag to `IAgentRuntime` (e.g.
   `readonly streamsOutput: boolean`), `true` for `opencode` and `false` for the generic subprocess
   adapter (and every adapter that inherits it). Use it to choose what the panel claims.
2. `src/tui/Dashboard.tsx` `StreamCard` — mirror the live console's adaptive rule (REQ-35.1/35.2):
   - `streamLines` empty **and** a phase has finished → render the **tail of `ui.lastReport.text`**
     (the real agent report) clipped to the card's rows, instead of the waiting copy.
   - `streamLines` empty and nothing finished yet → render an **idle raven state**: a small
     two-raven ASCII composition (Huginn + Muninn) built in `src/brand.ts` next to a rotating
     raven-voiced phrase, centred and clipped to the card.
   - One line names the active runtime and states that live streaming depends on it (only runtimes
     with an event channel stream; the rest report once per phase). Only shown when
     `streamsOutput === false`.
3. `src/tui/feedback.ts`: add the idle phrases (bounded, sanitized) so the copy lives with the
   console's other voice.
4. Layout: the card keeps its allocated height; the idle/report bodies are clipped to the available
   rows and never overflow at 80×24 (same discipline as `LiveHero`).
5. Tests (`test/tui/`): empty-with-report renders the report tail; empty-without-report renders the
   raven idle state and **not** `(waiting …)`; the runtime note appears only for non-streaming
   runtimes; the card never exceeds its row budget.
6. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 40 — A Single Semantic Glyph Language for Phase Status
modules: src/tui/glyphs.ts, src/format.ts, src/state/store.ts, src/tui/Dashboard.tsx, src/tui/LiveDashboard.tsx, src/tui/HelpModal.tsx, src/tui/SkillsModal.tsx, test/tui/

Implements REQ-52. Verified: the pipeline column renders `⏳` plus `verdictIcon()`'s `✅ 🟡 🔴 ⏭️`
(`src/format.ts`), `ReportPill` falls back to `🔴`, `PROGRESS.md` uses its own emoji map
(`🔍 ⚡ 🚦 🧪 🔐 👀 📝 🧠`), and the stream panel sniffs `⚡ ✓ ✗ 💭` — double-width emoji that break the
Ink grid.

1. New `src/tui/glyphs.ts`: the one semantic table, all printable single-width ASCII/box-drawing.
   - Status: pending `·`, running the existing braille spinner, pass `✓`, warning `!`, blocked `✕`,
     skipped `–`.
   - Phase kind (for `PROGRESS.md`): SPEC_AUDIT `?`, EXECUTE `>`, VALIDATE_STEP `=`, TEST_MODULE `%`,
     SECURE_CHECK `#`, REVIEW `@`, DOC_SYNC `~`, COMMIT_ALL `.`; `FIX_*` keep the ` └─ ` indent.
   - Exported as pure functions/data plus a `verdictGlyph(v)` used everywhere.
2. `src/format.ts`: `verdictIcon`/`verdictToken` return the new glyphs/tokens (keep `verdictToken`
   semantics; the TUI still resolves the token to a colour).
3. Replace every emoji **display** glyph: `Dashboard.tsx` (`PipelineCard`'s `⏳`, `verdictIcon`'s
   `✅🟡🔴⏭️`, `ReportPill`'s `🔴`, the `[⏸ PAUSED]` label, the promotion notice), `store.ts` (the
   phase-icon map, the status emoji and the promotion line) and the modal section headers
   (`HelpModal`, `SkillsModal`, `ModelPickerModal`). The **stream-panel prefixes** (`⚡ ✓ ✗ 💭`) are
   left as they are: they are markers a *runtime* emits (`src/engine/permissions.ts`), not huginn's
   own display glyphs, and rewriting them would be a producer change, not a theme one.
4. **Do not** touch the gate marker literals or the decision/permission prompt text; only rendered
   TUI/markdown display glyphs change.
5. Drift-guard test (`test/tui/`): the rendered pipeline/status strings contain no emoji while the
   gate literals remain present in the engine sources.
6. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 41 — Sessions Are a Documented Surface in `--help`
modules: src/cli.ts, src/state/liveSession.ts, test/commands/

Implements REQ-53. Verified: `--continue`/`-c`, `--session <id>` and `--list-sessions`/`-sl` are
listed as flags but `huginn --help` never explains the session store, the resume precedence or the
reattach semantics.

1. `usage()` (`src/cli.ts`): add a **Sessions** section documenting the store
   (`<project>/.huginn/live/sessions.json`, owner-only, atomic, never in `git status`), the three
   flags, and the semantics: `--session <id>` is the strongest request and wins over `--continue`,
   which adopts the project's most recently updated session; a `--continue` with nothing to continue
   starts a fresh session with a notice; a bare `--session` fails closed. State the exact scope (live
   mode).
2. `usageCore()`: add a one-line pointer to the Sessions section beside the existing session flags.
3. Keep the drift guard green and extend it (`test/commands/init.test.ts`) so every token in the new
   section is also present in `usage()`.
4. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

## Iteration 42 — Interactive Methodology Profile Selection
modules: src/tui/ProfilePickerModal.tsx, src/tui/commandRegistry.ts, src/tui/LiveDashboard.tsx, src/tui/HelpModal.tsx, src/tui/InfoPanel.tsx, src/engine/liveMode.ts, test/tui/

Implements REQ-54. Verified gap: the profile is resolved from `--profile` or
`huginn config set --profile` only; `src/engine/liveMode.ts` has **no** `profile` reference, there is
no `/profile` command in `src/tui/commandRegistry.ts`, and the cheat sheet never lists it — the header
merely displays `profile:huginn`.

1. New `src/tui/ProfilePickerModal.tsx`: rows from `PROFILE_NAMES`/`PROFILES` showing the display
   name, the one-line description and an active marker; `↑/↓`/`j`/`k` move, `Enter` confirms, `Esc`
   cancels. Mirror `AgentPickerModal`'s layout and key handling.
2. `src/tui/commandRegistry.ts` + `HelpModal.tsx`: register `/profile` (argHint `[id]`) with its
   description so the palette and the cheat sheet include it.
3. `src/engine/liveMode.ts`: add `getProfile()` and `updateProfile(name, scope)` where scope is
   `session` | `project` | `global`; validate against `PROFILE_NAMES` and **fail closed** with an
   actionable message on an unknown id; persist through the existing config writers
   (`saveUserConfig`/`saveGlobalUserConfig`). The change is reflected in the header and `/status`.
4. `src/tui/LiveDashboard.tsx`: `/profile` opens the picker, `/profile <id>` applies directly; after a
   handoff to the `CycleEngine` the new profile applies to the **next** cycle and the console says so
   explicitly (never a silent no-op).
5. `src/tui/InfoPanel.tsx`: the live context panel shows the active profile's display name.
6. Tests (`test/tui/`): the picker lists the five profiles and marks the active one; `Enter` changes
   it and the change is reflected; an invalid id fails closed without changing anything; `Esc`
   cancels; the registry and cheat sheet include `/profile` (drift guard).
7. Verify: `bun test`, `bunx vitest run`, `bun run typecheck` all green.

