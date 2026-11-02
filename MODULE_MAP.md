# Module → requirement map

A navigation index for `SPEC.md`, the single authoritative requirements ledger. It replaces
`SPEC_ORCHESTRATOR.md`, which restated the orchestrator with its own REQ numbering and collided with
this one (its REQ-8 and REQ-12 meant different things than `SPEC.md`'s). The IDs below are the
canonical `SPEC.md` ones.

| Module | Requirements |
|---|---|
| `src/cli.ts` | REQ-9, REQ-14, REQ-26, REQ-42, REQ-53, REQ-67 |
| `src/plan/parser.ts` | REQ-55 |
| `src/engine/cycle.ts`, `src/engine/phases.ts` | REQ-40, REQ-49, REQ-56, REQ-57, REQ-60…REQ-63 |
| `src/engine/gate.ts` | REQ-40, REQ-60 |
| `src/engine/decisionBroker.ts`, `src/engine/types.ts` | REQ-37 |
| `src/state/store.ts`, `src/state/schema.ts` | REQ-44, REQ-57, REQ-67 |
| `src/engine/planMode.ts` | REQ-55 |
| `src/engine/steps/` | REQ-40, REQ-41, REQ-60, REQ-61, REQ-64…REQ-66 |
| `src/engine/memory/`, `src/engine/steps/retrieval.ts` | REQ-64…REQ-66 |
| `src/engine/sandbox.ts`, `src/engine/verify.ts` | REQ-56 |
| `src/tui/*`, `src/headless.ts` | REQ-21, REQ-29, REQ-31, REQ-51, REQ-52, REQ-68, REQ-69, REQ-70, REQ-71, REQ-72, REQ-73, REQ-74, REQ-75, REQ-76, REQ-77 |
| `src/tui/Modal.tsx`, `src/tui/footer.ts` | REQ-75, REQ-77 |
| `src/tui/sessionContext.ts`, `src/tui/RavenHeader.tsx`, `src/tui/InfoPanel.tsx` | REQ-47, REQ-76, REQ-77 |
| `src/tui/search.ts`, `src/tui/clipboard.ts` | REQ-72 |
| `src/tui/markdown.tsx` | REQ-74 |
| `src/engine/permissionPolicy.ts`, `src/engine/runtimeEvents.ts`, `src/engine/agent/drivers/opencode.ts` | REQ-37, REQ-42, REQ-67 |
| `src/engine/liveMode.ts`, `src/engine/liveRepo.ts` | REQ-44, REQ-54 |
| `src/state/liveSession.ts` | REQ-44, REQ-53 |
| `src/engine/gitRepo.ts` | REQ-39 |
| `src/engine/agent/` | REQ-22, REQ-27, REQ-32, REQ-33, REQ-43, REQ-58, REQ-67 |
| `src/update.ts` | background version check (no numbered requirement) |
