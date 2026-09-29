import type { Iteration } from "../../plan/types.js";

/**
 * The subset of {@link PhaseContext} the step prompt builders need (REQ-7).
 *
 * Huginn composes every step's prompt itself, so the builders only depend on the
 * iteration being worked, the project/sandbox path, the tracked docs and the
 * diff anchor — never on the client, session or model routing.
 */
export interface StepContext {
  /** Working tree the step operates on (the sandbox worktree when sandboxed). */
  projectPath: string;
  /** Directory the agent session is scoped to; falls back to {@link projectPath}. */
  directory?: string;
  iteration: Iteration;
  specPath: string;
  adrPath: string;
  planPath: string;
  modules: string[];
  /** Commit the iteration started from, when known (diff anchor). */
  baseCommit?: string;
  /** The active profile's methodology instruction for `EXECUTE` (REQ-36). */
  profilePreamble?: string;
}
