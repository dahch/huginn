# Changelog

## Unreleased

### Added

- **Each live-session fact has one home.** The live header is now identity and ephemeral state: row 1
  is `[<spinner> <STAGE>]` plus the project path, row 2 is the two models, and the MCP badge, runtime
  name, git, sandbox and context counter left it for the side panel. The panel no longer repeats the
  stage, and the footer no longer appends `stage: <LABEL>`; it keeps the focused surface's keys and
  `usage`. `LIVE_HEADER_CONTEXT_ROWS` stays `2`, so the header height and every budget derived from
  it are unchanged, and the project path inherits the columns the badge/runtime spent (a 100×30 path
  is now painted whole). `gitStat(git, maxWidth?)` reserves the `clean`/`dirty` suffix before it
  clamps the branch, because the panel is the only surface that reports the working-tree state;
  `sessionStat` had no caller left and is gone with its test (REQ-77 / ADR-73).

- **Console chrome speaks one measured alphabet.** The MCP badge no longer reaches the console as
  the engine's double-width pictographs: `mcpBadgeText` (`src/tui/sessionContext.ts`) strips them and
  re-inserts one mark from `MCP_STATUS_GLYPHS` (`healthy` ✓, `degraded` !, `unknown` ·, all from
  `STATUS_GLYPHS`), so the run header and `InfoPanel` paint `MCP: ✓ 2 connected · pi` while
  `formatMcpBadge` and its engine test stay untouched. `headerValue` now clamps in display columns
  and spends the last one on `…`, so a truncated header, panel or footer value announces the cut
  instead of cropping silently (and a double-width glyph is never split). The side panel widens to
  36 columns, giving its value column 23 columns for the values it really reports, and `memoryStat`
  formats both Muninn counters through `formatCount` (`2.3k entities · 76 obs`). REQ-76 / ADR-72.

- **A decision alphabet that matches the rest of the TUI.** `src/tui/glyphs.ts` gains
  `DECISION_GLYPHS` (`approve` `+`, `question` `?`, `warn` `!`, `done` `*`) and `decisionGlyph(kind)`,
  and `DecisionModal` now composes its title with the pure exported `decisionTitle(req)` in
  `src/tui/decision.ts` instead of inline pictographs. The mapping is exhaustive, and `permission`
  and `spec-deviation` get their own titles rather than borrowing the gate wording. The decision
  modal, the feedback channel and the dashboard share one printable, single-column, ASCII alphabet
  (REQ-68 / ADR-63).
- **A drift guard for the decision surface.** `test/tui/decisionModal.test.ts` renders every title
  kind and fails on any `\p{Extended_Pictographic}` code point or a display width that disagrees
  with the string length; `test/tui/glyphs.test.ts` covers the new table, including its ASCII
  requirement.
- **The decision modal never outgrows the frame.** Its body and key footer are modelled one terminal
  row per entry (`decisionBodyRows`/`decisionKeyRows`) and a pure planner (`decisionModalHeight`)
  computes the exact height. Both dashboards pass the rows their own chrome leaves as `maxRows`, so
  a tall question windows its body behind a `… +N · ↑/↓` indicator (scrolled with `↑`/`↓`) instead
  of pushing the composer and footer off an 18- or 24-row terminal (REQ-69 / ADR-64).
- **Live console layout controls and a sectioned context panel.** From a focused card, `z`
  maximizes it and restores the remembered split, `Ctrl+↑`/`Ctrl+↓` move the conversation/stream
  split, and `L` pins or reopens the log tail. `L` is card-only, so typing it in the composer stays
  draft text. The idle log tail collapses after a minute, reopens on the next event, advertises every
  hidden entry in the footer, and only stays open for an error still present in its visible tail.
  `InfoPanel` groups its rows into `SESSION`, `REPO` and `MEMORY` sections (an empty section is
  omitted) and anchors the stage tip to the bottom of the column (REQ-71 / ADR-67).
- **Transcript navigation, in-conversation search and clipboard copy.** From the conversation or
  the agent stream, `g`/`G` jump to the start/end; `Ctrl+F` from any focus opens a `find ❯ `
  composer that searches the transcript by message, walks hits with `↑`/`↓` and jumps with Enter,
  while Esc or `Ctrl+F` restores the draft; `y` on the conversation copies the newest assistant
  message through a sanitized, 100 KB-capped OSC 52 sequence and reports the channel honestly.
  Search and clipboard policy live in the pure `src/tui/search.ts` / `src/tui/clipboard.ts`
  modules, and an armed Esc abort is cancelled by every key search consumes (REQ-72).
- **One chrome-cost table for the TUI's cards.** `src/tui/Card.tsx` exports `CARD_CHROME`,
  `cardChrome(tone)` and the `Card` primitive. `primary` is the round conversation box,
  `secondary` is the quieter single box used by the stream, pipeline and side panel, and
  `tertiary` is a borderless title-plus-`│ ` list for the logs. `LogsCard` costs
  `visibleLogs.length + 1` instead of `+ 3`, and both dashboards import that cost from
  `cardChrome("tertiary")` instead of a literal. The tail itself now spends two fewer rows (a
  five-entry tail costs six instead of eight). The table, the painted heights, the surface→tone
  mapping and the emitted border colours are guarded by `test/tui/card.test.ts` and
  `test/tui/cardColors.test.ts` (REQ-70 / ADR-65).

### Changed

- **The live console no longer duplicates state.** The header stopped rendering MCP, the runtime name,
  git, the sandbox and the context counter; `PanelData`/`panelLines` stopped rendering the `stage`
  row (and the four fields only it consumed); and `footerHints` stopped accepting a `stage`. The TUI
  tests that pinned the duplication were rewritten to the one-home rule — a single `⎇` in the panel
  and none on the header's models row, the conversation counter exactly once, no `stage:` in any
  footer — and `test/tui/liveLayout.test.ts` holds the 100×30 long-path regression (REQ-77 /
  ADR-73).

- **The TUI's framed surfaces now read as a hierarchy.** The conversation keeps the round accent
  box, the stream and pipeline step back to a quiet `single` border, and the log tail loses its box
  and its mid-line `│` in favour of a leading `│ ` rule. This also removes `StreamCard`'s
  verbose-only accent border; the `[VERBOSE]` marker still carries that state, and focus is still
  signalled by `borderFocus` and the card title (REQ-70 / ADR-65). Both dashboards now derive every
  card body and scroll budget from `cardChrome(...).rows`, so no `- 3` chrome literal remains.
- **The decision modal is split into focused modules.** The pure title, row specs, planner and
  height live in `src/tui/decision.ts`, and the React row builders and modal live in
  `src/tui/DecisionModal.tsx`; neither dashboard imports the other's page module. A capped budget
  below `DECISION_MIN_ROWS` now draws nothing, so the modal never shows a title without its key
  footer (REQ-69 / ADR-66).
- **Feedback speaks `!`:** `FEEDBACK_WARN` is `!` (alongside `✓` and `…`). This is TUI-only: the
  gate literals (`### Overall gate: 🟢/🟡/🔴`, `### Overall fidelity: …`), the producer markers
  (`⚡ ✓ ✗ 💭`) and every engine/CLI warning output (the `⚠️ REVIEW REQUESTED` handoff line, its
  parsers and the fail-closed judge fallback) are unchanged.

## 2.0.0-rc.5

Thirty-nine commits since `2.0.0-rc.4`, 99 files: `src` +6362/−1518, `test` +1568/−358, docs
+927/−404 (`ADR.md`, `AGENTS.md`, `CHANGELOG.md`, `DESIGN.md`, `README.md`, `SPEC.md`). The cycle
moves onto one `RuntimePort` (native `opencode` driver included), the audit collapses to one
increment report with an on-demand judge, `VERIFY` becomes a deterministic gate followed by an
atomic checkpoint, and a failed promotion becomes recoverable (`huginn promote --retry|--repair`).
Muninn becomes the context engine (bounded retrieval, ADR backfill, one observation per promoted
increment), subprocesses stay memory-capped with a liveness-probed scope, and this candidate fixes
Command Code's project MCP path, integrates a repaired promotion with a real merge, and resolves
`ADR.md` in the decisions backfill.

### Added

- **A failed promotion is recoverable from the CLI and the live console.** `huginn promote --retry`
  re-attempts the integration of the preserved branch with **no model turn** (checkpoint, then the
  same `promoteSandbox` the iteration would have run); on success it indexes the symbols, records the
  iteration in Muninn, advances `currentIteration` and clears the resume cursor, so the next run
  continues after the recovered increment. `huginn promote --repair` (and `[p]` in the post-cycle
  prompt) is offered **only** for a content `conflict`: huginn merges the primary HEAD into the
  preserved branch without committing, the thinker diagnoses (read-only, `treeHash`-guarded), the
  executor resolves the conflicted files, huginn commits the merge (refusing leftover conflict
  markers) and runs the iteration's `Verification:` before fast-forwarding the primary branch. One
  attempt; any failure aborts the merge or resets the branch to its pre-merge tip and keeps it. A
  `failed` promotion (partially staged file, staged-new file, unreadable branch) is never handed to a
  model — it points at the deterministic `--retry` after the user clears the tree. The live
  post-cycle prompt advertises exactly the recovery the record can offer (`DecisionRequest.choices`)
  and loops instead of ending the session (ADR-62).
- **Brain vs. Hands fix rounds.** A blocked gate is no longer repaired by the thinker's tool loop.
  `DIAGNOSE` (`diagnoseFindingsPrompt`, thinker, **read-only**, no `agent: "build"`) root-causes the
  failure and emits a `Remediation Plan` persisted to `.harness/reports/II-FIX_*-N-diagnosis.md`;
  `APPLY_FIX` (`fixFindingsPrompt`, executor, `agent: "build"`) applies it. A tree mutation during
  the diagnosis is caught by the same `treeHash` guard the auditors use and discards the plan.
- **Escalating fix rounds.** Attempt 1 of a tactical gate (`FIX_VERIFY`/`FIX_TEST`) goes straight to
  the executor with the console output and the judge's structured `actionItems` (zero thinker
  tokens); an architectural gate (`FIX_SPEC`/`FIX_VALIDATE`/`FIX_SECURITY`/`FIX_REVIEW`) or any repeat
  failure runs `DIAGNOSE` first.
- **One clean session per phase.** `CycleEngine.withPhaseSession` opens and closes a fresh,
  directory-scoped session per pipeline step (and per `DIAGNOSE`/`APPLY_FIX` turn), so roles never
  share an accumulated tool loop and the prompt cache is not invalidated by an `executor`↔`thinker`
  switch. `IAgentSession.close()` is bridged to `RuntimeSession.close()`.
- **`VERIFY` runs right after `EXECUTE`** in the default profile, so a deterministic failure is caught
  before any LLM audit spends tokens, and the profile now freezes a `receipt` by default.
- **Muninn becomes the context engine.** `EXECUTE`, `SPEC_AUDIT` and `VALIDATE_STEP` receive a bounded
  (~8 KB) untrusted block with recent decisions, prior increments and the symbols under the iteration's
  modules (`retrieveIncrementContext`). Retrieval requires an explicit `dbPath` and refuses to open a
  missing database, so a read-only audit never triggers the DDL/`mkdir` a `MemoryService` performs.
  `plan`/`live` persist every ADR as a `decision` observation (`adr-<n>`, idempotent), each promoted
  increment leaves one `iter-<n>` observation, and `huginn memory decisions` backfills an existing
  `adr.md`. Every write is fail-open; `HUGINN_MEMORY=0` disables retrieval.
- **Token and cost usage is real.** A driver that reports `usage` now feeds `state.usage`, the
  `PROGRESS.md` header and both dashboards' existing footer row; `formatUsage` refuses to render a
  fake `0 in / 0 out`, and a sub-cent cost reads `<$0.01`.
- **`SPEC_AUDIT` bounds the plan embed.** The auditor receives the iteration index plus the current
  increment (24 KB) instead of the whole document.

### Changed

- **The engines run on one `RuntimePort`.** `CycleEngine`, `LiveEngine`, the judge and every phase
  call `session.prompt(...)` on the port; a legacy `IAgentRuntime` is bridged once at construction.
  `opencode` now has a native driver that owns the SSE subscription, streams typed events, answers
  permissions through `onPermission` (deny when absent) and questions through `onQuestion`, and
  supports `resumeSession`/`probeSession`. The CLI no longer wires a second subscriber (which would
  duplicate every delta), `toLegacyRuntime`/`getEngineRuntime` are gone, and `getEnginePort` is the
  single "what executes" factory.
- **A clean iteration costs ~6 model turns instead of 14.** Each audit role now ends on its own
  `### Audit status:` line, and the judge pass (a second model call re-deriving what the role just
  stated) runs only when that line is warning/blocked or missing — so a green `TEST_MODULE`,
  `SECURE_CHECK` or `REVIEW` pays zero judge turns. `VALIDATE_STEP` is one increment audit
  (acceptance coverage + spec fidelity) instead of qa + spec-auditor + security + a synthesis turn;
  `SPEC_AUDIT` runs once per cycle, memoized on `computePlanHash([spec, adr, plan])`, with a
  greenfield skip and `--only-phase SPEC_AUDIT` forcing it. `COMMIT_ALL` is deterministic
  (`feat|fix|docs(<scope>): <subject>` from the iteration) with `--commit agent` as the opt-in; the
  default profile keeps `evidence: "receipt"`.

### Fixed

- **`huginn memory decisions` found a repository's `ADR.md`.** The backfill defaulted to the
  lower-case `adr.md` only, so on this repository (and any project that follows the upper-case
  convention `run`/`live` already resolve) it reported "0 saved" against an existing document. The
  default now picks the file that exists (`adr.md`, then `ADR.md`), exactly like every other tracked
  document.
- **A repaired promotion no longer dies on an empty cherry-pick.** `repairPromotion` leaves a merge
  commit on the preserved branch. If the primary advanced while the repair was diagnosing or
  verifying, `git merge --ff-only` could not integrate the branch and the `git cherry-pick
  base..branch` fallback exited 1 with "the previous cherry-pick is now empty", so `--retry` could
  never recover it. `promoteSandbox` now detects a merge commit in the range (`git rev-list --merges
  base..branch`) and integrates with `git merge --no-ff` instead, restoring the primary tree with
  `git merge --abort` on a conflict; `repairPromotion` re-reads the primary HEAD after verification
  and merges the newly landed commits on top of the tree it already proved (bounded to three
  attempts), so the promoted tree is the verified tree.
- **A dead systemd user manager no longer fails every prompt.** `userScopeAvailable` only checked that
  `$XDG_RUNTIME_DIR/systemd/private` existed, so a socket left behind by a stopped manager still made
  huginn wrap every generic-runtime prompt and every `Verification:` command in `systemd-run --user
  --scope`, which then died with "Failed to connect to user scope bus" — the opposite of the promised
  degrade-to-plain-spawn. Availability now probes the manager with a bounded
  (`systemctl --user is-system-running`, 1.5 s, memoized per process) liveness check after the socket
  check; `HUGINN_MEMORY_MAX=off` still short-circuits before any probe.
- **Command Code found Muninn again.** `AGENT_REGISTRY.commandcode` wrote the project scope to
  `<project>/.commandcode/mcp.json`, but Command Code 1.88 loads the project `mcpServers` from the
  repository root `.mcp.json` (the user scope is `~/.commandcode/mcp.json`), so `cmd mcp list` never
  showed the server. The project path now reuses mcode's `.mcp.json`; the writer still merges into
  the existing `mcpServers` map, preserving other servers such as `codegraph` byte-for-byte, and
  `huginn doctor` detects the entry in the file the CLI actually reads.
- **An adopted sandbox promotes from its merge base, not from its own tip.** `attachSandbox` reported
  the worktree's HEAD as `baseCommit`, which is the branch tip; `promoteSandbox` computes the range
  `base..branch`, so adopting a sandbox (a resume after a checkpoint, or any recovery) produced an
  empty range and the "no commits" path deleted the worktree **and the branch**, losing the commits.
  Both adoption and the new recovery path now derive the base from `git merge-base HEAD <branch>`
  (falling back to the persisted `state.iterationBaseCommit`), pinned by
  `test/engine/worktree.test.ts`.
- **The live console's conversation no longer overlaps itself.** Every message line is wrapped to the
  card's own column budget before it is rendered (`wrapSegments` in `src/tui/markdown.tsx`, width-aware
  across styled segments so a `**bold**` or `` `code` `` span is never split mid-markup), so one
  logical line is exactly one terminal row. Before, Ink's own `wrap="wrap"` let a text node claim a
  single row while painting several, and the overflow drew over the following line and over the card's
  bottom border — long paragraphs came out half-overwritten and unreadable. Scroll offsets now count
  the rows the user actually sees, and the card clips as a last line of defence.
- **The run dashboard's phase list follows the active profile.** `PipelineCard` renders
  `phasesForProfile(cfg.profile)` instead of a hard-coded registry order, so the Huginn Cycle shows
  `VERIFY` where it really runs (right after `EXECUTE`, by design) instead of last, and a
  `odd`/`rdd`/`strict-tdd` run no longer lists phases it never executes.
- **Codex driver**: the thread is started with the session's `workingDirectory` (the sandbox, not
  huginn's cwd), a per-prompt model change recreates the thread instead of silently billing the old
  model, and `timeoutMs` aborts the turn.
- **Claude driver**: captures the CLI `session_id` and resumes it on later turns, strips the
  `anthropic/` prefix from the model id, uses a fresh `AbortController` with `timeoutMs` per turn, and
  passes `permissionMode: "bypassPermissions"` when `--permissions auto` is set.
- **pi driver**: honours `timeoutMs` by interrupting the in-process turn.
- **The audit gate reads only its own conclusion lines.** `computeValidateVerdict` requires both
  `### Overall fidelity:` and `### Audit status:` and consults the whole-body fidelity fallback only
  when the report talks about fidelity, so an audit-status line can no longer pass as a green fidelity
  verdict. The under-report screen matches the exact consolidation vocabulary (`### Overall gate:` and
  the three handoff phrases), never the bare ✅/⚠️/🔴 that every role template ships (REV-102).
- **The dashboards stop animating at 12 Hz while idle.** The spinner interval runs only while a
  turn/run is in flight, and the cycle dashboard's elapsed clock ticks once a second instead of
  every 80 ms.
- **Esc asks before aborting.** A single stray Esc used to end a paid-for live session; it now arms a
  two-step confirmation (any other key cancels), like `/quit`. The post-abort message no longer
  claims the sandbox was discarded: an interrupted iteration is parked for `/resume`.
- **Every subcommand owns its `--help`.** The global interception answered `huginn <cmd> --help`
  with the overview, leaving ten per-command help branches unreachable; `install` gained one.
- **`PLAN.md` is resolved case-insensitively** like `SPEC.md`/`ADR.md`.
- **`pendingChanges` lists files, not collapsed directories.** `git status --porcelain -uall` gives the
  deterministic commit a real scope for a brand-new folder.
- **`/draft` no longer truncates destructively**: the architect prompt reads the configured
  `specPath`/`adrPath`/`planPath` with a bounded read, a spec larger than the embedding bound is
  updated as a delta appended to the existing file, and ADR/plan prompts keep the document's
  structure index plus its recent tail instead of cutting the newest entries.
- **`SPEC.md`/`ADR.md` are resolved case-insensitively** when `--spec`/`--adr` are not passed.
- **Muninn MCP no longer pins `--project`** in user-global configs (`~/.claude.json`,
  `~/.codex/config.toml`, `~/.config/opencode/...`, the portable `~/.huginn/mcp.json`); only
  project-local files carry it.
- **Muninn indexing runs after a successful promotion**, not inside `COMMIT_ALL`, so a failed
  promotion cannot leave the durable symbol graph describing files that never reached the main tree.

### Documentation

- `AGENTS.md` §1–§4 and §6, `SPEC.md` (AC-40.2…AC-40.4, AC-57.1, the new `REQ-60`…`REQ-63` turn
  budget), `DESIGN.md` (§5 gate model, §5.1 turn table, runtime wiring) and the README describe the
  `DIAGNOSE` → `APPLY_FIX` flow, the per-phase sessions, the single-report `VALIDATE_STEP`, the
  on-demand judge, the `SPEC_AUDIT` cadence and the deterministic commit. `ADR.md` gains ADR-58
  (Muninn as the context engine) and ADR-59 (deterministic gates, on-demand judge); the README
  documents what the agent is told and `HUGINN_MEMORY`.

## 2.0.0-rc.4

Seventeen commits since `2.0.0-rc.3`, 40 files: `src` +1513/−176, `test` +178/−9,
docs +229/−29 (`ADR.md`, `AGENTS.md`, `DESIGN.md`, `README.md`, `SPEC.md`). Three engine
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
  The scoped shell now runs the payload in a nested `sh -c` and exits with its `128+n`
  status; the wrapper carries no shell variables of its own, because older systemd expands
  `$…` in `ExecStart` differently and would erase them. It also sets `ulimit -c 0` (a scope
  rejects `LimitCORE=`), so a crashing fixture cannot leave a core dump for
  systemd-coredump and DrKonqi.
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
