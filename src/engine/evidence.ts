/**
 * What a result *is*, not just whether it passed.
 *
 * A green `pass` from `VERIFY` means "a command exited 0 on this tree". A green
 * `pass` from `REVIEW` means "a model read the diff and liked it". Both used to
 * print the same check mark, which is how a report came to read as proof of
 * something it never tested.
 *
 * The split is a property of the *producer*, not of the verdict: the engine runs
 * `VERIFY` and `COMMIT_ALL` itself and gates on real exit codes, every other
 * phase is a model turn, and a gate answer is a human decision. Keeping the
 * classification in one pure module is what lets the receipt, the report and the
 * console agree instead of each inventing its own idea of "verified".
 */
import type { PhaseName } from "./types.js";

export type EvidenceClass = "deterministic" | "judgment" | "human";

/**
 * What a *phase* can be: a gate answer is a person's decision, so "human" never
 * describes a phase result. Narrowing here means a UI that indexes a phase
 * marker table cannot be asked for the human glyph by mistake.
 */
export type PhaseEvidenceClass = Exclude<EvidenceClass, "human">;

/** Phases the engine executes and gates on, with no model in the loop. */
const DETERMINISTIC_PHASES: ReadonlySet<string> = new Set<PhaseName>([
  // The plan's `Verification:` commands run in the sandbox; the verdict is the
  // real exit status (ADR-57), not a report the agent wrote about it.
  "VERIFY",
  // A deterministic commit made by the engine, or an agent-written one — either
  // way the *evidence* is git's, not the model's.
  "COMMIT_ALL",
  // Recovery: re-attempts the integration and re-runs verification; no new work.
  "REPAIR_PROMOTION",
]);

/**
 * The class of one phase result.
 *
 * `TEST_MODULE` is deliberately `judgment`: today the agent runs the suite and
 * writes `### Audit status:`, so the phase is a report about tests rather than a
 * test run huginn performed. If the engine ever executes that command itself,
 * this function is the one place that changes.
 */
export function evidenceClassForPhase(phase: string): PhaseEvidenceClass {
  return DETERMINISTIC_PHASES.has(phase) ? "deterministic" : "judgment";
}

/** True when the phase's verdict is a model's opinion about work it (or a peer) did. */
export function phaseIsAgentReported(phase: string): boolean {
  return evidenceClassForPhase(phase) === "judgment";
}

/** One line explaining what a lane's result actually rests on. */
export function evidenceBasis(phase: string): string {
  switch (phase) {
    case "VERIFY":
      return "command exit codes, run by huginn";
    case "COMMIT_ALL":
      return "git commit / worktree state";
    case "REPAIR_PROMOTION":
      return "re-run verification in the preserved branch";
    case "TEST_MODULE":
      return "agent-reported suite result, not executed by huginn";
    case "SECURE_CHECK":
      return "agent security review";
    case "REVIEW":
      return "agent code review";
    case "SPEC_AUDIT":
      return "agent spec-fidelity audit";
    case "VALIDATE_STEP":
      return "agent increment audit";
    case "DOC_SYNC":
      return "agent documentation pass";
    case "EXECUTE":
      return "agent implementation turn";
    default:
      return phase.startsWith("FIX_") ? "agent repair turn" : "agent turn";
  }
}

/**
 * The things an iteration receipt cannot prove, derived from what it recorded.
 *
 * Stating them is the difference between "verified" and "verified for these
 * claims"; a receipt that only lists what passed invites the reader to assume the
 * rest.
 */
export function unprovenClaims(phases: readonly string[]): string[] {
  const claims: string[] = [];
  const has = (phase: string): boolean => phases.includes(phase);
  if (has("TEST_MODULE")) {
    claims.push("the suite result is the agent's report; huginn did not run it");
  }
  if (has("SPEC_AUDIT") || has("VALIDATE_STEP") || has("REVIEW")) {
    claims.push("audit verdicts are model judgments, not reproducible checks");
  }
  // Every driver declares `filesystemIsolation: "worktree"`: the agent is pointed
  // at the iteration worktree and nothing stops it writing under `$HOME`, so no
  // receipt can assert containment.
  claims.push("no receipt proves the agent stayed inside the worktree");
  return claims;
}

export interface EvidenceEntry {
  phase: string;
  class: PhaseEvidenceClass;
  verdict?: "pass" | "warning" | "blocked" | "skipped";
  /** What the verdict rests on, one line. */
  basis: string;
}

/** Split recorded phases into the two lanes the report and the console print. */
export function partitionPhases(
  phases: Array<{ phase: string; verdict?: "pass" | "warning" | "blocked" | "skipped" }>,
): { deterministic: EvidenceEntry[]; judgment: EvidenceEntry[] } {
  const deterministic: EvidenceEntry[] = [];
  const judgment: EvidenceEntry[] = [];
  for (const entry of phases) {
    const bucket = evidenceClassForPhase(entry.phase) === "deterministic" ? deterministic : judgment;
    bucket.push({
      phase: entry.phase,
      class: evidenceClassForPhase(entry.phase),
      verdict: entry.verdict,
      basis: evidenceBasis(entry.phase),
    });
  }
  return { deterministic, judgment };
}
