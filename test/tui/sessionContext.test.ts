/**
 * The live session summaries the side panel renders (REQ-12).
 *
 * These functions are pure strings, so the only thing worth asserting is the
 * wording they promise: the branch and its state, Muninn's counters in the
 * compact alphabet the panel's narrow value column can afford, and the MCP
 * badge translated from the engine's pictographs into the console's measured
 * glyphs (REQ-76).
 */

import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  formatMcpBadge,
  type McpBadge,
  type McpBadgeStatus,
} from "../../src/engine/agent/mcpStatus.js";
import type { McpServerStatus, McpStatusReport } from "../../src/engine/agent/types.js";
import { STATUS_GLYPHS } from "../../src/tui/glyphs.js";
import {
  GIT_BRANCH_COLUMNS,
  MCP_STATUS_GLYPHS,
  MEMORY_REASON_COLUMNS,
  contextStat,
  formatCount,
  gitStat,
  mcpBadgeText,
  memoryStat,
  stageTip,
} from "../../src/tui/sessionContext.js";

const PICTOGRAPH = /\p{Extended_Pictographic}/u;

describe("formatCount (REQ-12)", () => {
  it("keeps small counters literal and compacts the thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1_000)).toBe("1.0k");
    expect(formatCount(1_500)).toBe("1.5k");
    // A five-digit count still spends one decimal, a six-digit one does not.
    expect(formatCount(99_999)).toBe("100.0k");
    expect(formatCount(100_000)).toBe("100k");
    expect(formatCount(123_456)).toBe("123k");
  });

  it("never prints a negative, fractional or non-finite counter", () => {
    expect(formatCount(-1)).toBe("0");
    expect(formatCount(12.9)).toBe("12");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatCount(Number.NEGATIVE_INFINITY)).toBe("0");
  });
});

describe("memoryStat (REQ-12 / REQ-76)", () => {
  it("formats both counters with the compact formatter", () => {
    expect(memoryStat({ entitiesCount: 4, observationsCount: 9 })).toBe("4 entities · 9 obs");
    // A large database reads in the same budget instead of overflowing the box.
    expect(memoryStat({ entitiesCount: 2_314, observationsCount: 76 })).toBe("2.3k entities · 76 obs");
    expect(memoryStat({ entitiesCount: 12_345, observationsCount: 130_000 })).toBe(
      "12.3k entities · 130k obs",
    );
    expect(stringWidth(memoryStat({ entitiesCount: 2_314, observationsCount: 76 }))).toBe(22);
    // The formatted value is what `formatCount` promises, never a raw number.
    expect(memoryStat({ entitiesCount: 1_500, observationsCount: 0 })).toBe(
      `${formatCount(1_500)} entities · ${formatCount(0)} obs`,
    );
  });

  it("reports an unavailable database instead of a fabricated zero", () => {
    expect(memoryStat({ entitiesCount: 0, observationsCount: 0, error: "locked" })).toBe(
      "unavailable — locked",
    );
    expect(memoryStat(null)).toBe("");
    expect(memoryStat(undefined)).toBe("");
  });

  it("clamps a hostile failure reason with the shared truncation mark", () => {
    const reason = "x".repeat(200);
    const text = memoryStat({ entitiesCount: 0, observationsCount: 0, error: reason });
    const [, clamped = ""] = text.split("unavailable — ");
    expect(text.endsWith("…")).toBe(true);
    // The reason claims exactly its column budget, never the panel's value row.
    expect(stringWidth(clamped)).toBe(MEMORY_REASON_COLUMNS);
    expect(text).not.toContain(reason);
  });

  it("never lets a non-finite count leak into the row", () => {
    expect(memoryStat({ entitiesCount: Number.NaN, observationsCount: Number.POSITIVE_INFINITY })).toBe(
      "0 entities · 0 obs",
    );
    expect(memoryStat({ entitiesCount: -5, observationsCount: -1 })).toBe("0 entities · 0 obs");
  });
});

describe("gitStat (REQ-12 / REQ-76)", () => {
  it("keeps the longest real branch whole", () => {
    const stat = gitStat({ branch: "upgrade/ui-ux", clean: false, sandbox: false });
    expect(stat).toBe("⎇ upgrade/ui-ux · dirty");
    // 23 columns, exactly the panel's value budget (see `InfoPanel`).
    expect(stringWidth(stat)).toBe(23);
  });

  it("marks a branch it had to cut instead of cropping it silently", () => {
    const stat = gitStat({ branch: "feature/".repeat(20), clean: true, sandbox: false });
    expect(stat).toContain("…");
    // The branch clamp leaves the branch name at its column budget, so the state
    // that follows it (`clean`/`dirty`) is never lost to the cut.
    expect(stat.endsWith(" · clean")).toBe(true);
  });

  it("keeps the state when the row budget clamps the branch (ADR-73)", () => {
    const stat = gitStat({ branch: "feature/live-layout", clean: false, sandbox: false }, 23);
    // The panel's value column is 23: the branch announces its cut, and the
    // `dirty` fact — the reason the row exists — keeps every column it needs.
    expect(stringWidth(stat)).toBeLessThanOrEqual(23);
    expect(stat.endsWith(" · dirty")).toBe(true);
    expect(stat).toContain("…");
  });

  it("never spends more columns than the row budget it was given (ADR-73)", () => {
    for (const clean of [true, false]) {
      const git = { branch: "feature/a-very-long-branch-name", clean, sandbox: true };
      const state = clean ? " · clean" : " · dirty";
      for (let width = 0; width <= 40; width += 1) {
        const stat = gitStat(git, width);
        expect(stringWidth(stat), `${clean ? "clean" : "dirty"} at ${width}`).toBeLessThanOrEqual(
          width,
        );
        // The state survives whenever the budget can pay for it at all; below
        // that the row is dropped instead of printed without the fact it reports.
        if (width >= 11) expect(stat.endsWith(state), `${state} at ${width}`).toBe(true);
        else expect(stat, `${state} at ${width}`).toBe("");
      }
    }
    // The narrowest budget that still fits the mark and the state: a one-column
    // branch is the ellipsis alone, and `dirty` is untouched.
    expect(gitStat({ branch: "feature/x", clean: false, sandbox: false }, 11)).toBe(
      "⎇ … · dirty",
    );
  });

  it("falls back to the historic branch cap without a usable budget", () => {
    const git = { branch: "b".repeat(GIT_BRANCH_COLUMNS + 1), clean: true, sandbox: false };
    const unbudgeted = gitStat(git);
    // `undefined`, `NaN` and `Infinity` all mean "no row budget was given": the
    // historic {@link GIT_BRANCH_COLUMNS} cap applies and nothing is invented.
    expect(gitStat(git, Number.NaN)).toBe(unbudgeted);
    expect(gitStat(git, Number.POSITIVE_INFINITY)).toBe(unbudgeted);
    // A fractional budget is floored rather than rounded up past the row.
    expect(gitStat(git, 23.9)).toBe(gitStat(git, 23));
    expect(stringWidth(gitStat(git, 23.9))).toBeLessThanOrEqual(23);
  });

  it("renders nothing when git could not be read", () => {
    expect(gitStat(null)).toBe("");
    expect(gitStat({ branch: "   ", clean: true, sandbox: false })).toBe("");
  });

  it("keeps a branch exactly at its budget and marks the one that exceeds it", () => {
    const exact = gitStat({ branch: "b".repeat(GIT_BRANCH_COLUMNS), clean: true, sandbox: false });
    expect(exact).toBe(`⎇ ${"b".repeat(GIT_BRANCH_COLUMNS)} · clean`);
    const cut = gitStat({ branch: "b".repeat(GIT_BRANCH_COLUMNS + 1), clean: true, sandbox: false });
    expect(cut).toBe(`⎇ ${"b".repeat(GIT_BRANCH_COLUMNS - 1)}… · clean`);
  });
});

describe("contextStat (REQ-12 / NFR-10)", () => {
  it("says nothing while the conversation is empty", () => {
    expect(contextStat(null)).toBe("");
    expect(contextStat(undefined)).toBe("");
    expect(contextStat({ turns: 0, chars: 1_400 })).toBe("");
    expect(contextStat({ turns: -3, chars: 1_400 })).toBe("");
  });

  it("pluralizes the turn count and compacts the character count", () => {
    expect(contextStat({ turns: 1, chars: 0 })).toBe("1 turn · 0 chars");
    expect(contextStat({ turns: 2, chars: 840 })).toBe("2 turns · 840 chars");
    expect(contextStat({ turns: 3, chars: 1_400 })).toBe("3 turns · 1.4k chars");
  });
});

describe("stageTip (REQ-12)", () => {
  it("gives every live stage one non-empty reminder", () => {
    for (const stage of ["refine", "draft", "approve", "execute"] as const) {
      expect(stageTip(stage), stage).not.toBe("");
      expect(stageTip(stage), stage).not.toMatch(PICTOGRAPH);
    }
    expect(stageTip("refine")).toBe("type / for commands");
    expect(stageTip("execute")).toBe("Tab focuses the stream");
  });

  it("falls back to an empty tip for a stage it does not know", () => {
    expect(stageTip("bogus" as Parameters<typeof stageTip>[0])).toBe("");
  });
});

describe("mcpBadgeText (REQ-76)", () => {
  const server = (name: string, toolsCount: number): McpServerStatus => ({
    id: `pi:${name}`,
    name,
    status: "connected",
    transport: "stdio",
    toolsCount,
  });
  const healthy: McpStatusReport = {
    servers: [server("pi", 3)],
    totalTools: 3,
    healthy: true,
  };

  it("swaps the engine's pictograph for the measured status glyph", () => {
    const badge = formatMcpBadge(healthy, "pi");
    // The engine's own wording is untouched — that contract is not ours to move.
    expect(badge.text).toBe("MCP: 🟢 1 connected (3 tools) · pi");
    expect(mcpBadgeText(badge)).toBe("MCP: ✓ 1 connected (3 tools) · pi");
    expect(mcpBadgeText(formatMcpBadge({ ...healthy, totalTools: 0 }, "pi"))).toBe(
      "MCP: ✓ 1 connected · pi",
    );
  });

  it("renders the healthy multi-server badge exactly as the console promises", () => {
    const report: McpStatusReport = {
      servers: [server("pi", 1), server("muninn", 0)],
      totalTools: 2,
      healthy: true,
    };
    const text = mcpBadgeText(formatMcpBadge(report, "pi"));
    expect(text).toBe("MCP: ✓ 2 connected (2 tools) · pi");
    expect(text).not.toMatch(PICTOGRAPH);
    // The documented shape: two live servers and no tool count to report.
    expect(mcpBadgeText(formatMcpBadge({ ...report, totalTools: 0 }, "pi"))).toBe(
      "MCP: ✓ 2 connected · pi",
    );
  });

  it("speaks the degraded and unknown severities with their own glyphs", () => {
    const degraded = mcpBadgeText(
      formatMcpBadge({ servers: [], totalTools: 0, healthy: false, error: "probe failed" }, "pi"),
    );
    expect(degraded).toBe("MCP: ! error — probe failed · pi");
    const unknown = mcpBadgeText(formatMcpBadge({ servers: [], totalTools: 0, healthy: false }, "pi"));
    expect(unknown).toBe("MCP: · none · pi");
    expect(MCP_STATUS_GLYPHS.healthy).toBe(STATUS_GLYPHS.pass);
    expect(MCP_STATUS_GLYPHS.degraded).toBe(STATUS_GLYPHS.warning);
    expect(MCP_STATUS_GLYPHS.unknown).toBe(STATUS_GLYPHS.pending);
  });

  it("strips every pictograph and variation selector, and never widens the row", () => {
    for (const status of ["healthy", "degraded", "unknown"] as const) {
      const text = mcpBadgeText({
        text: `MCP: 🟢 ⚪ 🟡 ✔️ 2   connected  ·  pi`,
        status,
      });
      expect(text, status).not.toMatch(PICTOGRAPH);
      expect(text, status).not.toContain("\uFE0F");
      // The status mark sits immediately after the label, once.
      expect(text, status).toMatch(/^MCP: [✓!·] 2 connected · pi$/);
      expect(stringWidth(text), status).toBe(text.length);
    }
  });

  it("still names the badge when the engine reported nothing but a mark", () => {
    expect(mcpBadgeText({ text: "MCP: 🟢", status: "healthy" })).toBe("MCP: ✓");
    expect(mcpBadgeText({ text: "", status: "unknown" })).toBe("MCP: ·");
  });

  it("repairs a badge the engine sent without its label", () => {
    expect(mcpBadgeText({ text: "🟢 2 connected · pi", status: "healthy" })).toBe(
      "MCP: ✓ 2 connected · pi",
    );
    expect(mcpBadgeText({ text: "   ", status: "unknown" })).toBe("MCP: ·");
  });

  it("survives a missing text or an unknown severity without leaking a glyph", () => {
    // A malformed report must still render a measured, named badge.
    expect(mcpBadgeText({ status: "degraded" } as McpBadge)).toBe("MCP: !");
    expect(mcpBadgeText({ text: "MCP: x", status: "bogus" as McpBadgeStatus })).toBe("MCP: · x");
  });

  it("strips control characters and one-line breaks before collapsing spaces", () => {
    const text = mcpBadgeText({ text: "MCP: 🟢\u001b[31m\n2\tconnected\u001b[0m", status: "healthy" });
    expect(text).toBe("MCP: ✓ 2 connected");
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});
