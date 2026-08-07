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
  it("returns null for unparseable output (caller fails closed)", () => {
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
