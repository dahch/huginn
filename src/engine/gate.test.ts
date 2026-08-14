import { describe, it, expect } from "bun:test";
import { parseValidateStepVerdict, parseSpecAuditVerdict, extractJson, normalizeJudgeOutput } from "./gate";

describe("parseValidateStepVerdict", () => {
  it("reads the AUTO-APPROVED marker", () => {
    expect(parseValidateStepVerdict("...report...\n✅ AUTO-APPROVED — no action required")).toBe("pass");
  });
  it("reads REVIEW REQUESTED marker", () => {
    expect(parseValidateStepVerdict("...\n⚠️ REVIEW REQUESTED — address items")).toBe("warning");
  });
  it("reads BLOCKED marker", () => {
    expect(parseValidateStepVerdict("...\n🛑 BLOCKED — do not proceed")).toBe("blocked");
  });
  it("falls back to overall gate line", () => {
    expect(parseValidateStepVerdict("### Overall gate: 🟢 PASS")).toBe("pass");
    expect(parseValidateStepVerdict("### Overall gate: 🟡 PASS WITH WARNINGS")).toBe("warning");
    expect(parseValidateStepVerdict("### Overall gate: 🔴 BLOCKED")).toBe("blocked");
  });
  it("parses near-miss prose verdicts the reviewing agent actually emits", () => {
    expect(
      parseValidateStepVerdict(
        "The `/validate-step` gate returned **🟡 PASS WITH WARNINGS — REVIEW REQUESTED**. I addressed all feasible required actions.",
      ),
    ).toBe("warning");
    expect(
      parseValidateStepVerdict(
        "The `/validate-step` re-run returned **🟡 PASS WITH WARNINGS — REVIEW REQUESTED** (not blocked, but with required actions).",
      ),
    ).toBe("warning");
    expect(parseValidateStepVerdict("gate: PASS WITH WARNINGS — address items")).toBe("warning");
    expect(parseValidateStepVerdict("All green, AUTO-APPROVED for merge")).toBe("pass");
    expect(parseValidateStepVerdict("do not proceed, BLOCKED until fixed")).toBe("blocked");
  });
  it("never downgrades a blocked report to warning (fail-open guard)", () => {
    // A 🔴 report mentioning the warning phrase must stay blocked.
    expect(parseValidateStepVerdict("🔴 BLOCKED — REVIEW REQUESTED")).toBe("blocked");
    expect(parseValidateStepVerdict("### Overall gate: 🔴 BLOCKED\n⚠️ REVIEW REQUESTED — address items")).toBe("blocked");
    // The reverse contradiction too: a 🟢 overall gate must not mask a 🛑 handoff.
    expect(parseValidateStepVerdict("### Overall gate: 🟢 PASS\n🛑 BLOCKED — do not proceed")).toBe("blocked");
  });
  it("respects negated phrases and word boundaries in prose fallbacks", () => {
    expect(parseValidateStepVerdict("the gate is not blocked anymore")).toBeNull();
    expect(parseValidateStepVerdict("this was unblocked after the fix")).toBeNull();
    expect(parseValidateStepVerdict("cannot proceed: not auto-approved")).toBeNull();
    expect(parseValidateStepVerdict("the flow is no longer auto-approved")).toBeNull();
    expect(parseValidateStepVerdict("cannot be auto-approved until reviewed")).toBeNull();
    expect(parseValidateStepVerdict("not yet auto-approved, pending review")).toBeNull();
  });
  it("does not misread a clean report listing what it does not contain", () => {
    // Real reviewing-agent output: "🟡 PASS WITH WARNINGS (no 🔴, no MAJOR
    // DEVIATION, no Critical/High)". The negated "no 🔴" must not trip blocked.
    expect(
      parseValidateStepVerdict("Gate **🟡 PASS WITH WARNINGS** (no 🔴, no MAJOR DEVIATION, no Critical/High)"),
    ).toBe("warning");
    expect(parseValidateStepVerdict("no 🔴 findings, all clear")).toBeNull();
    expect(parseValidateStepVerdict("All 🟢 — no 🟡, no 🔴")).toBe("pass");
    expect(parseValidateStepVerdict("PASS — no blockers, no 🟡 remaining")).toBeNull();
  });
  it("still fails closed for prose that carries no verdict", () => {
    expect(parseValidateStepVerdict("Both platforms fully green. Here's the summary and the fixes applied.")).toBeNull();
    expect(parseValidateStepVerdict("The tests passed, coverage is above threshold.")).toBeNull();
    expect(parseValidateStepVerdict("nothing here")).toBeNull();
    expect(parseValidateStepVerdict("")).toBeNull();
  });
});

describe("parseSpecAuditVerdict", () => {
  it("reads Overall fidelity lines", () => {
    expect(parseSpecAuditVerdict("### Overall fidelity: 🟢 ALIGNED")).toBe("pass");
    expect(parseSpecAuditVerdict("### Overall fidelity: 🟡 MINOR DRIFT")).toBe("warning");
    expect(parseSpecAuditVerdict("### Overall fidelity: 🔴 MAJOR DEVIATION")).toBe("blocked");
  });
  it("reads reversed wording", () => {
    expect(parseSpecAuditVerdict("Overall fidelity: 🔴 MAJOR DEVIATION")).toBe("blocked");
    expect(parseSpecAuditVerdict("MAJOR DEVIATION")).toBe("blocked");
  });
  it("returns null for unparseable output (caller fails closed)", () => {
    expect(parseSpecAuditVerdict("lorem ipsum")).toBeNull();
  });
});

describe("extractJson", () => {
  it("extracts a JSON object from surrounding text", () => {
    const text = 'Here you go:\n```json\n{"status":"blocked","summary":"s","actionItems":["a"]}\n```';
    expect(extractJson(text)).toEqual({ status: "blocked", summary: "s", actionItems: ["a"] });
  });
  it("handles nested braces and strings with braces", () => {
    const text = 'prefix {"a":{"b":"{not json}"},"c":[1,2]} suffix';
    expect(extractJson(text)).toEqual({ a: { b: "{not json}" }, c: [1, 2] });
  });
  it("returns null when no object present", () => {
    expect(extractJson("no json here")).toBeNull();
  });
  it("returns null on invalid JSON", () => {
    expect(extractJson("{oops}")).toBeNull();
  });
});

describe("normalizeJudgeOutput", () => {
  it("accepts a valid output", () => {
    const j = normalizeJudgeOutput({ status: "warning", summary: "x", actionItems: ["y"] });
    expect(j).toEqual({ status: "warning", summary: "x", actionItems: ["y"], parsed: true });
  });
  it("rejects unknown status", () => {
    expect(normalizeJudgeOutput({ status: "banana" })).toBeNull();
  });
  it("coerces missing fields", () => {
    const j = normalizeJudgeOutput({ status: "pass" });
    expect(j?.summary).toBe("");
    expect(j?.actionItems).toEqual([]);
    expect(j?.parsed).toBe(true);
  });
});
