export type ModelRef = { providerID: string; modelID: string };

export type Verdict = "pass" | "warning" | "blocked" | "skipped";

export type Mode = "auto" | "supervised";

export type PhaseName =
  | "SPEC_AUDIT"
  | "FIX_SPEC"
  | "EXECUTE"
  | "VALIDATE_STEP"
  | "FIX_VALIDATE"
  | "TEST_MODULE"
  | "FIX_TEST"
  | "SECURE_CHECK"
  | "FIX_SECURITY"
  | "REVIEW"
  | "FIX_REVIEW"
  | "DOC_SYNC"
  | "COMMIT_ALL";

/** The eight pipeline phases run once per iteration (FIX_* phases are excluded). */
export const MAIN_PHASES: PhaseName[] = [
  "SPEC_AUDIT",
  "EXECUTE",
  "VALIDATE_STEP",
  "TEST_MODULE",
  "SECURE_CHECK",
  "REVIEW",
  "DOC_SYNC",
  "COMMIT_ALL",
];

export interface PhaseResult {
  iteration: number;
  phase: PhaseName;
  attempt: number;
  verdict?: Verdict;
  model: string;
  sessionId: string;
  messageId: string;
  summary: string;
  raw: string;
  reportPath?: string;
  startedAt: string;
  finishedAt: string;
}

export type DecisionKind = "gate-blocked" | "permission" | "spec-deviation";

export type DecisionChoice = "retry" | "continue" | "abort" | "allow" | "deny";

export interface DecisionRequest {
  id: string;
  kind: DecisionKind;
  iteration: number;
  phase: PhaseName;
  attempt: number;
  message: string;
  reportPath?: string;
  permissionId?: string;
  permissionSessionId?: string;
}
