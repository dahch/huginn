import { describe, expect, it } from "bun:test";
import {
  evidenceBasis,
  evidenceClassForPhase,
  partitionPhases,
  phaseIsAgentReported,
  unprovenClaims,
} from "./evidence";

describe("evidence lanes", () => {
  it("classifies by the producer, not by the verdict", () => {
    for (const phase of ["VERIFY", "COMMIT_ALL", "REPAIR_PROMOTION"]) {
      expect(evidenceClassForPhase(phase)).toBe("deterministic");
      expect(phaseIsAgentReported(phase)).toBe(false);
    }
    // TEST_MODULE stays a judgment: the agent runs the suite and reports it.
    for (const phase of ["SPEC_AUDIT", "EXECUTE", "TEST_MODULE", "SECURE_CHECK", "REVIEW", "DOC_SYNC", "FIX_VERIFY"]) {
      expect(evidenceClassForPhase(phase)).toBe("judgment");
      expect(phaseIsAgentReported(phase)).toBe(true);
    }
  });

  it("names what each phase rests on", () => {
    expect(evidenceBasis("VERIFY")).toContain("exit codes");
    expect(evidenceBasis("TEST_MODULE")).toContain("agent-reported");
    expect(evidenceBasis("REVIEW")).toContain("agent");
    expect(evidenceBasis("SOMETHING_NEW")).toBe("agent turn");
  });

  it("splits recorded phases into the two lanes", () => {
    const lanes = partitionPhases([
      { phase: "VERIFY", verdict: "pass" },
      { phase: "REVIEW", verdict: "warning" },
    ]);
    expect(lanes.deterministic.map((entry) => entry.phase)).toEqual(["VERIFY"]);
    expect(lanes.judgment.map((entry) => entry.phase)).toEqual(["REVIEW"]);
    expect(lanes.judgment[0].verdict).toBe("warning");
  });

  it("always states the containment claim no receipt can make", () => {
    const claims = unprovenClaims([]);
    expect(claims.some((claim) => claim.includes("worktree"))).toBe(true);
    expect(unprovenClaims(["TEST_MODULE"]).some((claim) => claim.includes("agent's report"))).toBe(true);
    // A cycle with no audit phases makes no audit claim.
    expect(unprovenClaims(["EXECUTE"]).some((claim) => claim.includes("model judgments"))).toBe(false);
  });
});
