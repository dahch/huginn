# Changelog

## 3.0.0-rc.1

The SDK rewrite. Huginn stops driving thirteen agent CLIs and starts executing the runtimes it can
actually control, saying out loud what each one can do.

### Breaking

- **Five runtimes instead of thirteen adapters.** The cycle executes `pi`, `opencode`, `codex`,
  `claude` or `generic`. The other eight targets (`agy`, `commandcode`, `devin`, `kimi`,
  `mcode`, `mimo`, `omp`, `qwen`) keep working through one configured `generic` driver and
  remain **provisioning targets** for `huginn setup`/`doctor` — but a stored config naming one of
  them now warns and falls back to auto-detection.
- **Muninn is a package.** The memory engine lives at
  [dahch/muninn](https://github.com/dahch/muninn) and is consumed as `@dahch/muninn`. The database
  and export paths are unchanged (`.huginn/muninn.db`, `.huginn/memories.jsonl`), and
  `huginn memory`/`check`/`mcp run` keep working as wrappers.
- **Model/MCP discovery is no longer wired for the eight generic targets**: their catalog is an
  explained empty list and the MCP panel falls back to config discovery. That is the honest answer,
  not a regression to fix.

### Added

- `RuntimePort` (`src/engine/agent/port.ts`) with explicit `RuntimeCapabilities`, typed events
  (`text`/`tool`/`permission`/`usage`/`error`/`done`), `interrupt()` and idempotent `close()`.
- A **conformance suite** every driver must pass; it fails any driver that claims more than it
  delivers.
- Native drivers: `pi` (in-process SDK, real session history, dynamic catalog), `codex` (persisted
  thread), `claude` (optional, external, never bundled — its SDK is not open source).
- `huginn runtime list [--check]`: which runtimes can execute the cycle, with their capabilities.
- `ci.yml`: typecheck, unit, integration and a build smoke on every push and pull request.

### Fixed

- Repository state is classified from exit codes and the filesystem, never from git's localised
  message: on a non-English locale every greenfield directory used to be refused.
- A git process killed by a signal is never reported as a clean empty success (the bug Bun exposed).
- `bun test` is scoped to `src/`, so the vitest-authored suites no longer run in bun's shared
  process and leak `process.exitCode` between files.

### Notes

- This is a release candidate. The final 3.0.0 follows the first field reports; the interfaces above
  are expected to hold, but the runtime list is the contract, not the implementation.
- Muninn is pinned to its `v0.1.0` release asset while npm publishing is unavailable; it switches
  to `^0.1.0` in 3.0.1 once the package is on the registry.
