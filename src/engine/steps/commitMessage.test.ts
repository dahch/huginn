import { describe, it, expect } from "bun:test";
import { deterministicCommitMessage } from "./commitMessage";

const iteration = { index: 3, title: "Payments webhook" };

describe("deterministicCommitMessage", () => {
  it("derives a conventional commit from the iteration and the changed paths", () => {
    expect(
      deterministicCommitMessage({
        iteration,
        totalIterations: 5,
        profile: "huginn",
        changedPaths: ["src/engine/cycle.ts", "src/engine/phases.ts"],
      }),
    ).toBe(
      "feat(engine): Payments webhook\n\nHarness iteration 3/5 (huginn).",
    );
  });

  it("uses `fix` for a fix/bug title", () => {
    const message = deterministicCommitMessage({
      iteration: { ...iteration, title: "Fix the retry loop" },
      totalIterations: 1,
      profile: "odd",
      changedPaths: ["src/a.ts"],
    });
    expect(message.startsWith("fix(a): Fix the retry loop")).toBe(true);
  });

  it("uses `docs` when every changed path is a document", () => {
    const message = deterministicCommitMessage({
      iteration: { ...iteration, title: "Explain the gate" },
      totalIterations: 2,
      profile: "huginn",
      changedPaths: ["README.md", "docs/GATES.mdx"],
    });
    expect(message.startsWith("docs(iter-3): Explain the gate")).toBe(true);
  });

  it("falls back to chore(iter-N) with nothing to describe", () => {
    const message = deterministicCommitMessage({
      iteration: { index: 7, title: "   " },
      totalIterations: 7,
      profile: "huginn",
      changedPaths: [],
    });
    expect(message.startsWith("chore(iter-7): iteration 7")).toBe(true);
  });

  it("slugifies a hostile title and never lets it inject a newline or ANSI", () => {
    const message = deterministicCommitMessage({
      iteration: {
        ...iteration,
        title: "\u001b[2Jfeat: pwn\n\nSecond paragraph",
      },
      totalIterations: 3,
      profile: "huginn",
      changedPaths: ["src/x.ts"],
    });
    const [subject, body] = message.split("\n\n");
    expect(subject).not.toContain("\u001b");
    expect(subject).not.toContain("\n");
    expect(body).toBe("Harness iteration 3/3 (huginn).");
  });

  it("is deterministic for the same input", () => {
    const input = {
      iteration,
      totalIterations: 5,
      profile: "huginn" as const,
      changedPaths: ["src/engine/cycle.ts"],
    };
    expect(deterministicCommitMessage(input)).toBe(deterministicCommitMessage(input));
  });
});
