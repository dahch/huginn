import { describe, it, expect } from "bun:test";
import { parseIterationMetadata, parsePlan } from "../plan/parser";

const INCREMENT = [
  "# Plan: notifications",
  "",
  "## Iteration 1 — Deliver a notification",
  "modules: src/notifications/, src/api/",
  "",
  "**Goal:** a new event delivers one notification and the app still starts.",
  "",
  "**Acceptance criteria:**",
  "- [ ] REQ-1: the endpoint answers 200.",
  "- [x] REQ-2: the notification is persisted.",
  "",
  "**Verification:**",
  "```sh",
  "# the suite must be green",
  "bun test",
  "bun run typecheck",
  "```",
  "",
  "Implement the notification slice.",
  "",
].join("\n");

describe("parsePlan", () => {
  it("parses iterations with em-dash and modules line", () => {
    const plan = [
      "# Plan",
      "",
      "## Iteration 1 — Implement greet",
      "modules: src/hello/",
      "Do the thing.",
      "",
      "## Iteration 2 - Another title",
      "Do another thing.",
    ].join("\n");
    const iters = parsePlan(plan);
    expect(iters).toHaveLength(2);
    expect(iters[0]).toMatchObject({
      index: 1,
      title: "Implement greet",
      modules: ["src/hello/"],
    });
    expect(iters[0].prompt).toBe("Do the thing.");
    expect(iters[1].index).toBe(2);
    expect(iters[1].modules).toBeUndefined();
    expect(iters[1].prompt).toBe("Do another thing.");
  });

  it("parses English 'Iteration N:' headings", () => {
    const plan = "## Iteration 3: Add API\ndo it\n\n## Iteration 4: Add tests\ntest it";
    const iters = parsePlan(plan);
    expect(iters.map((i) => i.index)).toEqual([3, 4]);
    expect(iters[0].title).toBe("Add API");
    expect(iters[0].prompt).toBe("do it");
  });

  it("parses multiple modules values", () => {
    const plan = "## Iteration 1 — X\nmodules: src/a, src/b, tests/\nbody";
    const iters = parsePlan(plan);
    expect(iters[0].modules).toEqual(["src/a", "src/b", "tests/"]);
  });

  it("keeps only the section body as the prompt (no trailing blank)", () => {
    const plan = "## Iteration 1 — X\n\n  Hello  \n\n## Iteration 2 — Y\nsecond";
    const iters = parsePlan(plan);
    expect(iters[0].prompt).toBe("Hello");
    expect(iters[1].prompt).toBe("second");
  });

  it("sorts iterations by index regardless of file order", () => {
    const plan = "## Iteration 2 — B\nb\n## Iteration 1 — A\na";
    const iters = parsePlan(plan);
    expect(iters.map((i) => i.index)).toEqual([1, 2]);
  });

  it("ignores non-iteration headings", () => {
    const plan = "# Intro\n## Context\nblah\n## Iteration 1 — X\nbody";
    const iters = parsePlan(plan);
    expect(iters).toHaveLength(1);
    expect(iters[0].index).toBe(1);
  });

  it("ignores Spanish 'Iteración' headings", () => {
    const plan = "## Iteración 1 — X\nbody";
    const iters = parsePlan(plan);
    expect(iters).toHaveLength(0);
  });
});

describe("iteration increment metadata", () => {
  it("reads Goal, Acceptance criteria and Verification without rewriting the prompt", () => {
    const [iteration] = parsePlan(INCREMENT);
    expect(iteration).toBeDefined();
    expect(iteration!.goal).toContain("delivers one notification");
    expect(iteration!.acceptanceCriteria).toEqual([
      "REQ-1: the endpoint answers 200.",
      "REQ-2: the notification is persisted.",
    ]);
    expect(iteration!.verification).toEqual(["bun test", "bun run typecheck"]);
    // The body remains the verbatim executor prompt.
    expect(iteration!.prompt).toContain("Implement the notification slice.");
    expect(iteration!.prompt).toContain("**Goal:**");
  });

  it("supports heading-style sections and inline criteria", () => {
    const metadata = parseIterationMetadata(
      [
        "### Goal",
        "The CLI exits 0.",
        "### Acceptance criteria",
        "- [ ] it runs",
        "### Verification",
        "- `bun test`",
      ].join("\n"),
    );
    expect(metadata.goal).toBe("The CLI exits 0.");
    expect(metadata.acceptanceCriteria).toEqual(["it runs"]);
    expect(metadata.verification).toEqual(["bun test"]);
  });

  it("keeps a legacy plan working with no metadata", () => {
    const iterations = parsePlan("# Plan: x\n\n## Iteration 1 — Do\n\nwork\n");
    expect(iterations).toHaveLength(1);
    expect(iterations[0]!.goal).toBeUndefined();
    expect(iterations[0]!.acceptanceCriteria).toBeUndefined();
    expect(iterations[0]!.verification).toBeUndefined();
  });

  it("does not treat the executor body's bullets as verification commands", () => {
    const metadata = parseIterationMetadata(
      [
        "**Verification:**",
        "```sh",
        "bun test",
        "```",
        "",
        "Implement:",
        "- step one",
        "- step two",
      ].join("\n"),
    );
    expect(metadata.verification).toEqual(["bun test"]);
  });

  it("treats an inline Verification as the only command", () => {
    const metadata = parseIterationMetadata(
      ["**Verification:** `bun test`", "", "- not a command"].join("\n"),
    );
    expect(metadata.verification).toEqual(["bun test"]);
  });

  it("does not mistake a shell comment inside the fence for a markdown heading", () => {
    const metadata = parseIterationMetadata(
      ["**Verification:**", "```sh", "# a comment", "bun test", "```"].join("\n"),
    );
    expect(metadata.verification).toEqual(["bun test"]);
  });

  it("parses several iterations independently", () => {
    const plan = [
      INCREMENT,
      "## Iteration 2 — Second slice",
      "",
      "**Goal:** second outcome.",
      "",
      "**Acceptance criteria:**",
      "- [ ] second criterion",
      "",
      "**Verification:**",
      "```sh",
      "bun run build",
      "```",
      "",
    ].join("\n");
    const iterations = parsePlan(plan);
    expect(iterations.map((it) => it.index)).toEqual([1, 2]);
    expect(iterations[1]!.goal).toBe("second outcome.");
    expect(iterations[1]!.verification).toEqual(["bun run build"]);
  });
});
