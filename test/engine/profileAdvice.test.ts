import { describe, expect, it } from "vitest";
import { validateDraftFormat } from "../../src/engine/planMode";
import { parseProfileAdvice, PROFILE_NAMES } from "../../src/engine/profiles";

const COMPLETE = [
  "# Plan: demo",
  "",
  "**Profile:** rdd",
  "**Profile reason:** two files, existing tests, no spec delta.",
  "",
  "## Iteration 1 — Do",
  "",
  "**Goal:** the app starts.",
  "",
  "**Acceptance criteria:**",
  "- [ ] REQ-1: it answers.",
  "",
  "**Verification:**",
  "```sh",
  "bun test",
  "```",
  "",
  "work",
].join("\n");

describe("parseProfileAdvice", () => {
  it("reads the bold line and its reason", () => {
    expect(parseProfileAdvice(COMPLETE)).toEqual({
      profile: "rdd",
      reason: "two files, existing tests, no spec delta.",
    });
  });

  it("accepts the heading form, backticks and an inline reason", () => {
    expect(parseProfileAdvice("## Profile: odd")).toEqual({ profile: "odd" });
    expect(parseProfileAdvice("**Profile:** \`strict-tdd\`")).toEqual({ profile: "strict-tdd" });
    expect(parseProfileAdvice("**Profile:** sdd — new feature")).toEqual({
      profile: "sdd",
      reason: "new feature",
    });
  });

  it("refuses an unknown profile instead of falling back to the default", () => {
    expect(parseProfileAdvice("**Profile:** whatever")).toBeNull();
    expect(parseProfileAdvice("**Profile:**")).toBeNull();
  });

  it("does not mistake prose for the proposal", () => {
    expect(parseProfileAdvice("The profile is probably rdd here.")).toBeNull();
    expect(parseProfileAdvice("# Plan: x\n\n## Iteration 1 — Do")).toBeNull();
  });

  it("covers every declared profile id", () => {
    for (const id of PROFILE_NAMES) {
      expect(parseProfileAdvice(`**Profile:** ${id}`)?.profile).toBe(id);
    }
  });
});

describe("plan format requires the proposal", () => {
  it("accepts a complete plan", () => {
    expect(validateDraftFormat("plan", COMPLETE)).toBeNull();
  });

  it("names the missing proposal", () => {
    const withoutProfile = COMPLETE.split("\n").filter((l) => !l.startsWith("**Profile")).join("\n");
    expect(validateDraftFormat("plan", withoutProfile)).toContain("profile proposal");
  });

  it("still reports a broken iteration first", () => {
    const broken = COMPLETE.replace("**Goal:** the app starts.\n", "");
    expect(validateDraftFormat("plan", broken)).toContain("must declare");
  });
});
