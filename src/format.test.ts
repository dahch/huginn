import { describe, it, expect } from "bun:test";
import { formatCost, formatUsage } from "./format";

describe("formatUsage", () => {
  it("renders nothing when no metric was measured", () => {
    expect(formatUsage(undefined)).toBeUndefined();
    expect(formatUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 })).toBeUndefined();
  });

  it("compacts thousands and millions", () => {
    expect(formatUsage({ inputTokens: 12_300, outputTokens: 4_100, costUsd: 0 })).toBe(
      "12.3k in / 4.1k out",
    );
    expect(formatUsage({ inputTokens: 1_200_000, outputTokens: 0, costUsd: 0 })).toBe(
      "1.2M in / 0 out",
    );
  });

  it("appends the cost when there is one", () => {
    expect(formatUsage({ inputTokens: 10, outputTokens: 2, costUsd: 0.42 })).toBe(
      "10 in / 2 out · $0.42",
    );
    expect(formatUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0.004 })).toBe("<$0.01");
  });
});

describe("formatCost", () => {
  it("never renders a fake zero", () => {
    expect(formatCost(0)).toBeUndefined();
    expect(formatCost(Number.NaN)).toBeUndefined();
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1.239)).toBe("$1.24");
  });
});
