import type { Iteration } from "../../plan/types.js";
import type { ProfileName } from "../profiles.js";

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
  /** The active profile, for the deterministic commit message (REQ-63). */
  profile?: ProfileName;
  /** Number of iterations in the plan, for the deterministic commit body. */
  totalIterations?: number;
  /**
   * Explicit Muninn database path. Under sandboxing this is the PRIMARY
   * project's database, so memory reads survive worktree cleanup. Retrieval
   * never resolves a path itself: no `dbPath` means no memory block.
   */
  dbPath?: string;
  /** Project root Muninn attributes entities/observations to (the primary project). */
  primaryProjectRoot?: string;
}
