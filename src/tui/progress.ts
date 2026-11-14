import { phasesForProfile, type ProfileName } from "../engine/profiles.js";

/**
 * The run's progress, as a fraction of the work the plan actually scheduled.
 *
 * Dividing by iterations alone made a one-iteration plan read 100% before the
 * first phase ran ("iteration 1 of 1" is not "half done" — it is not started).
 * So an iteration is worth `1/total` and only earns it phase by phase; the bar
 * reaches 100% when the last phase of the last iteration has a verdict.
 */
export interface RunProgressInput {
  currentIteration: number;
  totalIterations: number;
  profile?: ProfileName;
  /** Phases that finished this iteration (a verdict was recorded). */
  donePhases: ReadonlySet<string>;
}

/** The distinct phases one iteration has to get through under `profile`. */
export function iterationPhases(profile?: ProfileName): readonly string[] {
  return [...new Set(phasesForProfile(profile))];
}

export function runProgressFraction(input: RunProgressInput): number {
  const total = Math.max(1, Math.floor(input.totalIterations));
  const phases = iterationPhases(input.profile);
  const done = phases.filter((phase) => input.donePhases.has(phase)).length;
  const finishedIterations = Math.max(0, Math.min(total, Math.floor(input.currentIteration) - 1));
  const partial = phases.length > 0 ? done / phases.length : 0;
  return Math.max(0, Math.min(1, (finishedIterations + partial) / total));
}

/** Integer percent for the header bar; 100 only when every iteration is through. */
export function runProgressPercent(input: RunProgressInput): number {
  return Math.round(runProgressFraction(input) * 100);
}
