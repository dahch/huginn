import { describe, it, expect } from "bun:test";
import { parsePlan } from "../plan/parser";

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
