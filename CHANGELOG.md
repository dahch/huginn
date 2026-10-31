# Changelog

## 2.0.0-rc.4

Fourteen commits since `2.0.0-rc.3`, 40 files: `src` +1468/−176, `test` +178/−9,
docs +226/−29 (`ADR.md`, `AGENTS.md`, `DESIGN.md`, `README.md`, `SPEC.md`). Three engine
features land — memory-capped subprocesses, resumable interrupted iterations, and a
crash-aware `VERIFY` — alongside the live console's real focus model, a corrected account
of the step prompts in `AGENTS.md`, the fix that makes every clarifying question and every
option visible and answerable, the packaging fix that installs `@dahch/muninn` from npm,
and a scope wrapper that keeps signal deaths visible on every systemd version.

### Added

- **Memory-capped subprocesses.** Every agent prompt and every `Verification:` command now runs
  inside a transient `systemd-run --user --scope` with `MemoryMax` (default 70 % of RAM, clamped to
  2–12 GiB), `MemorySwapMax=4G` and `TasksMax=1024`, so a runaway build is killed inside its own
  cgroup instead of exhausting RAM and freezing the host. The cap is opt-out
  (`HUGINN_MEMORY_MAX=off`), tunable with `HUGINN_MEMORY_SWAP_MAX`/`HUGINN_TASKS_MAX`, and degrades
  to the previous plain spawn where no user systemd manager exists.
- **Resume the step that was interrupted.** An aborted iteration (Ctrl-C, `q`/`Esc`, an abort at a
  gate) no longer discards its sandbox: everything is committed into it and the worktree plus its
  branch stay on disk, with `state.resume` naming the step that was in flight. The next run reattaches
  that sandbox and restarts exactly that step — earlier steps keep their work, and the interrupted
  step is re-run rather than skipped past. The live hand-off (`live` → run) now only resets `.harness`
  when the plan on disk actually changed, so returning from a cycle keeps the progress. New `/resume`
  command and a `Resume Point` row in `/status` / `.harness/PROGRESS.md`.
- **Crash-aware `VERIFY`.** A verification command killed by a signal is reported as
  `CRASHED (SIGSEGV)` with a trusted "crash, not an assertion" note instead of `FAILED (exit 139)`,
  and the fix rounds are skipped: a driver/GPU crash is an environment failure, so huginn escalates to
  you (or aborts in `auto`/headless) instead of paying a thinker to "fix" the source.

### Fixed

- **Signal deaths survive the memory scope on every systemd version.** systemd 255 (the
  ubuntu-24.04 CI runner) reports a signalled payload of `systemd-run --scope` as exit `1`,
  so `VERIFY` saw an ordinary failure instead of a crash and would have paid the fix rounds.
  The scoped shell now runs the payload in a nested `sh -c` and re-exits with its `128+n`
  status, which every systemd version propagates as a plain exit code.
- **`@dahch/muninn` installs from npm.** The v0.1.0 tarball URL attached to the GitHub
  release started returning 404 (the asset moved), which broke `bun install --frozen-lockfile`
  in CI and the publish build. Now that the package ships on the registry, the dependency is
  `^0.1.0` and the lockfile resolves it from npm.
- **Every question and every option is visible and answerable.** The decision modal was a
  `flexShrink: 1` child under a hardcoded six-row reservation, so a question with several options was
  squashed by Yoga and the lower options were silently clipped. The modal now keeps its natural
  height (the conversation cards give up the space instead). A block carrying several questions is
  asked **one modal at a time** — with a `(2/3)` counter — and each answer is paired with its own
  question; previously only the first was shown behind a "+N more question(s)" line and the first
  answer was silently reused for every later question.
- **The audit-only QA step no longer rebuilds the workspace for coverage.** `ROLE_QA` and the
  `VALIDATE_STEP` qa task told the auditor to "run coverage report" while `auditOnlyGuardrails()`
  forbade coverage artifacts; the model resolved the contradiction by instrumenting and rebuilding
  the whole workspace (`cargo llvm-cov`) on top of the format/lint/build commands `VERIFY` runs
  later. The audit now reports the coverage the repository already publishes (or "not measured in
  audit mode"), runs one heavy command at a time, and is told never to build in `/tmp` — a
  RAM-backed `tmpfs` on Linux.
- **Live focus is real.** `Tab`/`Shift+Tab` cycle composer → conversation → agent stream (skipping a
  collapsed stream card) and the focused surface owns `↑`/`↓`/`PgUp`/`PgDn`; the arrow keys no longer
  jump to input history just because the draft is empty, so the conversation is scrollable while a
  history exists. `Tab` never appends a line to the chat, which used to build a wall of identical
  "panel is collapsed" notices.

## 2.0.0-rc.3

Thirteen commits since `2.0.0-rc.2`, 61 files: `src/engine` +1308/−92, `test` +538/−17,
`src/plan` +288/−1, `src/tui` +63/−19, docs +588/−1077 (`DESIGN.md` alone drops 1001 lines that now
live in [dahch/muninn](https://github.com/dahch/muninn)). Three features — the increment contract,
the deterministic `VERIFY` phase with atomic promotion, and native pi MCP — land on top of a TUI
correction pass (honest cycle outcome, reachable panels, a readable palette) and the packaging and
documentation fixes below.

### Added

- **Scrum-style increments.** Iterations are now planned, executed and persisted as vertical,
  testable slices. The plan prompts require `Goal`, `Acceptance criteria` and a fenced
  `Verification:` block; the parser feeds them to `EXECUTE`, `TEST_MODULE` and the QA audit, and a
  new deterministic `VERIFY` phase runs those commands in the sandbox and gates on their real exit
  codes (blocking + `FIX_VERIFY` on failure). Every profile runs it before `COMMIT_ALL`.
- **Atomic iteration checkpoint.** Before a sandbox is promoted, huginn commits anything
  `COMMIT_ALL` left uncommitted (`chore(iter-N): checkpoint — …`), so a successful increment can
  never be discarded silently. A dirty sandbox with zero commits is now a failed promotion that
  preserves the worktree, and stopping a run leaves the primary tree at the last promoted increment.
- **Tracked local changes are parked during promotion.** A tracked file with staged or unstaged
  modifications that the iteration also changes (the real `README.md` conflict) is backed up under
  `.huginn/promotion-backup/<stamp>/` with a `manifest.json`, reset to `HEAD`, and the iteration is
  promoted. A failed integration restores the content, mode and staged/unstaged index state. Partial
  staging and staged new files keep the fail-closed branch-preserving path.
- **Native pi MCP reporting.** The `RuntimePort` exposes `listMcpServers`/`mcpStatus`, the bridges
  forward them, and the pi driver lists `pi mcp list --json` (real state + tool counts) with
  `~/.pi/agent/mcp.json` and `<project>/.pi/mcp.json` as the config fallback. The badge no longer
  says `none` while pi has servers; it can report `🟢 2 connected (214 tools) · pi` or `⚪ 2 configured`.

### Changed

- `--no-verify` / `"verify": false` skips the plan's verification commands; plans without the
  increment sections still run (the phase passes with a note).
- The `MCP` badge distinguishes a failed server (`🟡 error`) from an unprobed one (`⚪ configured`)
  and reserves part of its poll budget for fast config discovery.
- The models are shown once, in the status header; the LIVE CONTEXT panel no longer repeats
  `thinker`/`executor` (two rows freed, and a test keeps them out).
- Re-tagging is safe now: the publish step skips when the version is already on npm, and the release
  job updates the existing page from the changelog instead of skipping it.

### Fixed

- **A failed cycle no longer says "Cycle completed!".** The live console now reads
  `CycleEngine.run()`'s outcome: an error/abort is reported as such, names the preserved sandbox
  branch, and does not emit a second `done (completed)` after the engine already failed. The
  post-cycle modal title is neutral (`CYCLE FINISHED`), so a promotion conflict cannot read as success.
- **The run dashboard's `AGENT OUTPUT` no longer hides the last phase report behind a blank stream
  row.** A buffer that only holds `""` is treated as "no stream" (matching the live view), so the
  report tail or the raven idle state is shown instead of an empty box.
- **Live Tab is no longer a silent no-op when the agent-output panel is collapsed.** The footer
  hides `[Tab] Focus` until there are two cards, and pressing Tab explains that the panel appears
  with stream content and that PgUp/PgDn scroll the conversation.
- **Muninn could not open its database in the published bundle.** `bun build` had baked the CI
  runner's absolute path (`/home/runner/…/better-sqlite3/build/Release/better_sqlite3.node`) into
  the native binding, so every installed copy reported Muninn as unavailable while a source checkout
  worked. `better-sqlite3` is now `--external` and a direct dependency, resolved at runtime.
- The dark palette's secondary text was ANSI `gray` (bright black, ~#7f7f7f) and nearly invisible on
  a dark terminal: `muted`/`system` are `#9aa5b1` and the border `#5b6572`.

### Docs

- `DESIGN.md` replaces the in-tree Muninn chapters (13-18) with pointers to the package's own
  design document, keeping only the wrapper surface and the two integration points; `ADR-54`
  (verified increments) and `ADR-55` (MCP through the port) are new, and `SPEC.md` gains `REQ-49`,
  `REQ-57`, `REQ-58` and `REQ-59`.
- The README now says what a gate actually guarantees — it is parsed, not read, and it can block —
  and how a receipt pins an iteration to its base commit, resulting commit and verified tree hash.

## 2.0.0-rc.2

**Renumbered from 3.0.0-rc.1.** No code changed in the renumbering. `1.2.0` is the last stable, the
`2.0.0-rc.1` line never shipped a final, and the SDK rewrite is one breaking change — so it lands on
`2.0.0` instead of skipping past a major that never existed. `3.0.0-rc.1` stays on npm as a
deprecated artifact until the account can unpublish it.

Two fixes since that prerelease:

- `huginn --version` answers instead of starting the live console.
- The model the engine asks for is the model that runs: `pi` switches per prompt with
  `session.setModel(model, { persist: false })`, `claude` passes it to each turn's query, and
  `codex` says it cannot (its SDK fixes the model per thread).

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
