import { type PhaseName } from "./types.js";

/**
 * Methodology profiles (REQ-36 / ADR-35).
 *
 * Huginn's cycle had no name and no alternative. The pipeline is already *data*
 * (`PipelineStep[]`), so a profile is a named, ordered subset of the existing
 * phase vocabulary plus the evidence each one has to leave behind — no new engine
 * paths, and `runPhase`/`runIteration` are untouched.
 *
 * The default is the **Huginn Cycle**: the eight phases that made Huginn what it
 * is (audit the spec, build, gate, test, secure, review, document, commit).
 */
export type ProfileName = "huginn" | "sdd" | "odd" | "rdd" | "strict-tdd";

export const DEFAULT_PROFILE: ProfileName = "huginn";

export const PROFILE_NAMES: readonly ProfileName[] = [
  "huginn",
  "sdd",
  "odd",
  "rdd",
  "strict-tdd",
];

/** Evidence a profile freezes, so a claim cannot be hallucinated (AC-36.4). */
export type ProfileEvidence = "none" | "receipt" | "snapshot";

export interface ProfileSpec {
  id: ProfileName;
  /** Display name (the default profile has a proper noun). */
  name: string;
  /** One-line intent, shown in the header/`/status` and `--help`. */
  description: string;
  /** The ordered phases this profile runs, once per iteration. */
  phases: readonly PhaseName[];
  /**
   * What the profile freezes as machine-checkable evidence: `receipt` records the
   * authenticated iteration result, `snapshot` additionally pins the worktree
   * state before and after `EXECUTE` so "the tests passed" is verifiable.
   */
  evidence: ProfileEvidence;
  /**
   * Extra instruction prepended to the iteration prompt, used by the profiles that
   * fold a methodology step (proposal/design/tasks, test-first) into `EXECUTE`.
   */
  preamble?: string;
  /**
   * `strict-tdd` only: its first `TEST_MODULE` runs **before** `EXECUTE` and is
   * *expected to fail*. It is judged (so the receipt records the failing verdict)
   * but must not block or trigger the test-fix loop, which would implement the
   * code before `EXECUTE` and invert test-first (REV-002).
   */
  testFirst?: boolean;
}

export const PROFILES: Record<ProfileName, ProfileSpec> = {
  huginn: {
    id: "huginn",
    name: "Huginn Cycle",
    description: "Audit the spec, build, gate, test, secure, review, document, commit",
    phases: [
      "SPEC_AUDIT",
      "EXECUTE",
      "VALIDATE_STEP",
      "TEST_MODULE",
      "SECURE_CHECK",
      "REVIEW",
      "DOC_SYNC",
      "COMMIT_ALL",
    ],
    evidence: "none",
  },
  sdd: {
    id: "sdd",
    name: "Spec-Driven Development",
    description: "Proposal → spec → design → tasks → apply → verify → archive",
    phases: ["SPEC_AUDIT", "EXECUTE", "VALIDATE_STEP", "TEST_MODULE", "REVIEW", "DOC_SYNC", "COMMIT_ALL"],
    evidence: "receipt",
    preamble:
      "Work spec-first: before writing code, state the proposal, the spec deltas, the design " +
      "and the concrete task list; then apply them. Verify against the spec, and archive by " +
      "updating the documents.",
  },
  odd: {
    id: "odd",
    name: "Organic-Driven Development",
    description: "Lightweight daily changes — implement, test, commit",
    phases: ["EXECUTE", "TEST_MODULE", "COMMIT_ALL"],
    evidence: "none",
    preamble:
      "Keep this small and direct: make the change, run the tests, commit. Do not invent spec " +
      "or architecture work that the task does not need.",
  },
  rdd: {
    id: "rdd",
    name: "Receipt-Driven Development",
    description: "Implement, test, gate, and freeze a receipt the commit references",
    phases: ["EXECUTE", "TEST_MODULE", "VALIDATE_STEP", "COMMIT_ALL"],
    evidence: "receipt",
  },
  "strict-tdd": {
    id: "strict-tdd",
    name: "Strict TDD",
    description: "Tests first, then implement, with a frozen worktree snapshot as evidence",
    phases: ["TEST_MODULE", "EXECUTE", "TEST_MODULE", "VALIDATE_STEP", "COMMIT_ALL"],
    evidence: "snapshot",
    testFirst: true,
    preamble:
      "Test-first, strictly: write the failing tests that express the requirement BEFORE the " +
      "implementation, show them failing, then implement until they pass. Never claim a test " +
      "passed without the evidence from this run.",
  },
};

/** Every phase any profile may run, in registry order (for `--only-phase`). */
export const PROFILE_PHASES: readonly PhaseName[] = [
  ...new Set(PROFILE_NAMES.flatMap((name) => PROFILES[name].phases)),
];

export function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

export function profileSpec(name: ProfileName | undefined): ProfileSpec {
  return PROFILES[name ?? DEFAULT_PROFILE] ?? PROFILES[DEFAULT_PROFILE];
}

/** The phases of a profile, de-duplicated but order-preserving (strict-tdd repeats TEST_MODULE). */
export function phasesForProfile(name: ProfileName | undefined): readonly PhaseName[] {
  return profileSpec(name).phases;
}

/**
 * Fail-closed guard (AC-36.6): every phase a profile names must be runnable. The
 * profiles only reference the existing vocabulary today, so this exists to stop a
 * future profile from silently degrading to the default instead of erroring.
 */
export function validateProfilePhases(
  name: ProfileName,
  implemented: ReadonlySet<PhaseName>,
): { ok: true } | { ok: false; missing: PhaseName[] } {
  const missing = [...new Set(profileSpec(name).phases)].filter((phase) => !implemented.has(phase));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** The instruction prepended to the iteration prompt, if the profile adds one. */
export function profilePreamble(name: ProfileName | undefined): string {
  return profileSpec(name).preamble ? `${profileSpec(name).preamble}\n\n` : "";
}
