import { describe, expect, it } from "vitest";
import {
  iterationPhases,
  runProgressFraction,
  runProgressPercent,
} from "../../src/tui/progress";

const done = (...names: string[]) => new Set(names);

describe("run progress", () => {
  it("does not claim 100% before the first phase of a one-iteration plan", () => {
    expect(runProgressPercent({ currentIteration: 1, totalIterations: 1, profile: "huginn", donePhases: done() })).toBe(0);
  });

  it("moves one phase at a time inside the iteration", () => {
    const phases = iterationPhases("huginn");
    const one = runProgressPercent({ currentIteration: 1, totalIterations: 1, profile: "huginn", donePhases: done(phases[0]!) });
    expect(one).toBe(Math.round((1 / phases.length) * 100));
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(100);
  });

  it("reaches 100 only when every phase of every iteration is done", () => {
    const phases = iterationPhases("huginn");
    expect(
      runProgressPercent({ currentIteration: 1, totalIterations: 1, profile: "huginn", donePhases: done(...phases) }),
    ).toBe(100);
  });

  it("counts finished iterations as whole before the current partial one", () => {
    const phases = iterationPhases("huginn");
    const fraction = runProgressFraction({
      currentIteration: 2,
      totalIterations: 4,
      profile: "huginn",
      donePhases: done(...phases.slice(0, 2)),
    });
    // iteration 1 finished (1/4) plus 2 phases of 4 iterations × 9 phases.
    expect(fraction).toBeCloseTo(0.25 + 2 / (4 * phases.length), 5);
  });

  it("deduplicates a profile that repeats a phase (strict-tdd)", () => {
    expect(new Set(iterationPhases("strict-tdd")).size).toBe(iterationPhases("strict-tdd").length);
  });

  it("clamps a resumed run past the last iteration to 100", () => {
    expect(
      runProgressPercent({ currentIteration: 9, totalIterations: 2, profile: "rdd", donePhases: done() }),
    ).toBe(100);
  });

  it("never renders a negative or oversized bar", () => {
    expect(runProgressFraction({ currentIteration: 0, totalIterations: 1, profile: "huginn", donePhases: done() })).toBe(0);
    expect(runProgressFraction({ currentIteration: 1, totalIterations: 0, profile: "huginn", donePhases: done() })).toBe(0);
  });
});
