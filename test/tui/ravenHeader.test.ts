import React from "react";
import { PassThrough } from "node:stream";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "ink";
import stringWidth from "string-width";
import { render } from "./inkRender";
import type { CycleEngine } from "../../src/engine/cycle";
import type { RunConfig } from "../../src/config";
import { HUGINN_WORDMARK, RAVEN_MARK, RAVEN_MOODS, artWidth, ravenMark } from "../../src/brand.js";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine } from "../../src/engine/liveMode";
import {
  COMPACT_BRAND,
  COMPACT_BRAND_WIDTH,
  HEADER_BORDER_ROWS,
  HEADER_TEXT_BRAND_ROWS,
  RAVEN_ART_ROWS,
  RAVEN_ART_WIDTH,
  RAVEN_FULL_MIN_COLUMNS,
  RAVEN_MARK_WIDTH,
  RAVEN_VIEWPORT_RESERVED_ROWS,
  RavenHeader,
  WORDMARK_WIDTH,
  buildRavenArtRows,
  headerValue,
  ravenHeaderPlan,
} from "../../src/tui/RavenHeader.js";
import { LiveApp, VIEWPORT_RESERVED_ROWS_CLOSED } from "../../src/tui/LiveDashboard";
import { Dashboard } from "../../src/tui/Dashboard";
import { PANEL_TITLE } from "../../src/tui/InfoPanel.js";

/** The eagle code point, written as an escape so the glyph is nowhere in the tree (AC-29.1). */
const EAGLE = /\u{1f985}/u;

function createMockStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as unknown as PassThrough & {
    isTTY: boolean;
    setRawMode: () => PassThrough;
    ref: () => PassThrough;
    unref: () => PassThrough;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

/** Pin the terminal size `useTerminalSize()` reads from `process.stdout`. */
function stubTerminalSize(rows: number, columns: number): () => void {
  const originalRows = process.stdout.rows;
  const originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true, writable: true });
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true, writable: true });
  return () => {
    Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true, writable: true });
    Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true, writable: true });
  };
}

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** Visible lines of the last rendered frame, trailing blanks dropped. */
function visibleLines(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function capture(
  element: React.ReactElement,
  columns: number,
  rows: number,
): Promise<string> {
  const restore = stubTerminalSize(rows, columns);
  const stdout = new PassThrough() as unknown as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const instance = render(element, { stdout, stdin: createMockStdin(), patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    instance.unmount();
    return output;
  } finally {
    restore();
  }
}

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "opencode/gpt-5.1-codex",
  cwd: "/mock/project",
  mode: "auto",
} as unknown as RunConfig;

function createMockLive(): LiveEngine {
  return {
    cfg: mockCfg,
    runtime: {
      name: "opencode",
      id: "opencode",
      capabilities: { streaming: true, systemPrompts: true, tools: true },
    },
    models: { thinker: mockCfg.thinker, executor: mockCfg.executor },
    currentStage: "refine",
    ideaText: "",
    // Phase 4D: the view hydrates its conversation from the transcript at mount.
    getTranscript: vi.fn().mockReturnValue([]),
    getResumePoint: vi.fn().mockReturnValue(undefined),
    clearTranscript: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn().mockResolvedValue(undefined),
    draft: vi.fn().mockResolvedValue("aborted"),
    approvePlan: vi.fn().mockResolvedValue(undefined),
    requestAbort: vi.fn(),
    resolveDecision: vi.fn(),
    updateModels: vi.fn(),
    getDiagnostics: vi.fn().mockResolvedValue({
      gitBranch: "main",
      gitClean: true,
      worktreeSandbox: false,
      runtimeName: "opencode",
      thinkerModel: mockCfg.thinker,
      executorModel: mockCfg.executor,
      memoryStats: { entitiesCount: 0, observationsCount: 0 },
    }),
  } as unknown as LiveEngine;
}

function createMockEngine(): CycleEngine {
  return {
    runtime: { name: "opencode", id: "opencode", capabilities: { streaming: true } },
    getState: () => ({ currentIteration: 1, currentPhase: "EXECUTE" }),
    pause: vi.fn(),
    resume: vi.fn(),
    requestAbort: vi.fn(),
    resolveDecision: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
  } as unknown as CycleEngine;
}

function sampleRows(): React.ReactNode[][] {
  return [
    [
      React.createElement(Text, { key: "left", bold: true }, "[⠋ REFINE]"),
      React.createElement(Text, { key: "right", dimColor: true }, "MCP: ⚪ 0 active"),
    ],
    [React.createElement(Text, { key: "models" }, "thinker: mock")],
  ];
}

/** `RavenHeader` with the two context rows the live view renders. */
function ravenHeader(plan: ReturnType<typeof ravenHeaderPlan>, suffix = "LIVE"): React.ReactElement {
  return React.createElement(RavenHeader, { plan, suffix, rows: sampleRows() });
}

describe("RavenHeader ASCII assets (REQ-29)", () => {
  it("ships a printable-ASCII raven mark and wordmark with no control characters", () => {
    const rows = [...RAVEN_MARK, ...HUGINN_WORDMARK];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatch(/^[\x20-\x7e]*$/);
    }
    // The mark must read as a raven: a beak, an eye and a wedge tail.
    const mark = RAVEN_MARK.join("\n");
    expect(mark).toContain("<(");
    expect(mark).toContain("o");
    expect(mark).toContain("\\_\\");
    expect(RAVEN_MARK.length).toBeLessThanOrEqual(3);
  });

  it("keeps every raven mood on the idle mark's exact grid (REQ-73)", () => {
    const idle = ravenMark("idle");
    expect(idle).toBe(RAVEN_MARK);
    for (const mood of ["idle", "thinking", "sleeping"] as const) {
      const mark = RAVEN_MOODS[mood];
      expect(mark).toHaveLength(RAVEN_MARK.length);
      expect(artWidth(mark)).toBe(artWidth(RAVEN_MARK));
      for (const [index, row] of mark.entries()) {
        // Same grid: changing mood never reflows a row.
        expect(row.length, `${mood} row ${index}`).toBe(RAVEN_MARK[index]!.length);
        expect(row).toMatch(/^[\x20-\x7e]*$/);
      }
    }
    // The mood is the beak glyph: only those cells differ.
    expect(ravenMark("thinking")[1]).toContain("O");
    expect(ravenMark("sleeping")[1]).toContain("-");
  });

  it("renders the mark centred beside the wordmark and never wider than the composed art", () => {
    const rows = buildRavenArtRows("full");
    expect(rows).toHaveLength(RAVEN_ART_ROWS);
    expect(rows.every((row) => row.mark.length === 0 || row.mark.length > RAVEN_MARK_WIDTH - 1)).toBe(
      true,
    );
    // The mark occupies the middle rows only, so the block stays compact.
    expect(rows[0]?.mark.trim()).toBe("");
    expect(rows[rows.length - 1]?.mark.trim()).toBe("");
    for (const row of rows) {
      expect(`${row.mark}${row.wordmark}`.length).toBeLessThanOrEqual(RAVEN_ART_WIDTH);
    }
    // Wordmark-only rows drop the mark column entirely.
    expect(buildRavenArtRows("wordmark").every((row) => row.mark === "")).toBe(true);
    expect(artWidth(HUGINN_WORDMARK)).toBe(WORDMARK_WIDTH);
  });

  it("clamps dynamic values, collapsing newlines so they cannot forge rows", () => {
    expect(headerValue("opencode", 4)).toBe("ope…");
    expect(headerValue("\u001b[31mred\u001b[0m", 20)).toBe("red");
    expect(headerValue("a\nb\tc", 20)).toBe("a b c");
    expect(headerValue(undefined, 10)).toBe("");
    expect(headerValue(null, 10)).toBe("");
    expect(headerValue("long", 0)).toBe("");
    // Fractional budgets floor instead of slicing mid-column; negative ones clamp.
    expect(headerValue("abcdef", 3.9)).toBe("ab…");
    expect(headerValue("abcdef", -2)).toBe("");
  });

  it("cuts a value with a one-column ellipsis instead of cropping it silently (REQ-76)", () => {
    // A value that fits is left byte-for-byte intact, ellipsis and all.
    expect(headerValue("main", 4)).toBe("main");
    expect(headerValue("main", 40)).toBe("main");
    // A value that does not fit keeps its head and spends the last column on `…`.
    expect(headerValue("abcdef", 4)).toBe("abc…");
    expect(headerValue("abcdef", 2)).toBe("a…");
    // The degenerate budgets have their own branches: nothing, then the mark only.
    for (const budget of [0, -1, 0.9, Number.NaN]) {
      expect(headerValue("abcdef", budget), String(budget)).toBe("");
    }
    // Infinity means "no clamp" (the old contract); it never eats the value.
    expect(headerValue("abcdef", Number.POSITIVE_INFINITY)).toBe("abcdef");
    expect(headerValue("abcdef", Number.NEGATIVE_INFINITY)).toBe("");
    expect(headerValue("abcdef", 1)).toBe("…");
    expect(headerValue("abcdef", 1.9)).toBe("…");
    // The budget is in display columns, so a wide glyph is never split and the
    // result can never paint wider than the columns the layout reserved.
    expect(headerValue("日本語abc", 4)).toBe("日…");
    expect(headerValue("日本語abc", 5)).toBe("日本…");
    for (const [value, budget] of [
      ["abcdef", 4],
      ["日本語abc", 4],
      ["日本語abc", 5],
      ["日本語abc", 2],
      ["abc", 1],
    ] as const) {
      expect(stringWidth(headerValue(value, budget)), `${value}/${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("carries the raven's mood into the composed rows without changing the grid", () => {
    const idle = buildRavenArtRows("full", "idle");
    const thinking = buildRavenArtRows("full", "thinking");
    const sleeping = buildRavenArtRows("full", "sleeping");
    expect(thinking).toHaveLength(idle.length);
    expect(sleeping).toHaveLength(idle.length);
    for (const [index, row] of idle.entries()) {
      // The wordmark column never depends on the mood.
      expect(thinking[index]?.wordmark).toBe(row.wordmark);
      expect(sleeping[index]?.wordmark).toBe(row.wordmark);
      // Only the beak cell differs, so switching mood cannot reflow the block.
      expect(thinking[index]?.mark.length).toBe(row.mark.length);
      expect(sleeping[index]?.mark.length).toBe(row.mark.length);
    }
    expect(idle[2]?.mark).toContain("o");
    expect(thinking[2]?.mark).toContain("(");
    expect(thinking[2]?.mark).toContain("O");
    expect(sleeping[2]?.mark).toContain("-");
    // Compact is a single fixed row: the mood cannot make it taller.
    expect(buildRavenArtRows("compact", "thinking")).toEqual(
      buildRavenArtRows("compact", "idle"),
    );
  });
});

describe("ravenHeaderPlan degradation (AC-29.3)", () => {
  it("shows the mark plus the wordmark on a wide, tall terminal", () => {
    const plan = ravenHeaderPlan({ columns: 100, rows: 30, contextRows: 2, outerInset: 2 });
    expect(plan.variant).toBe("full");
    expect(plan.artRows).toBe(RAVEN_ART_ROWS);
    expect(plan.artWidth).toBe(RAVEN_ART_WIDTH);
    expect(plan.height).toBe(HEADER_BORDER_ROWS + RAVEN_ART_ROWS + 2);
    expect(plan.artWidth).toBeLessThanOrEqual(plan.contentWidth);
  });

  it("falls back to the wordmark only between the mark threshold and the full width", () => {
    const at = ravenHeaderPlan({ columns: RAVEN_FULL_MIN_COLUMNS - 1, rows: 30, contextRows: 2, outerInset: 2 });
    expect(at.variant).toBe("wordmark");
    expect(at.artWidth).toBe(WORDMARK_WIDTH);
    expect(at.artWidth).toBeLessThanOrEqual(at.contentWidth);
    expect(at.height).toBe(HEADER_BORDER_ROWS + RAVEN_ART_ROWS + 2);
  });

  it("falls back to the compact one-row brand when even the wordmark does not fit", () => {
    const plan = ravenHeaderPlan({ columns: 30, rows: 30, contextRows: 2, outerInset: 2 });
    expect(plan.variant).toBe("compact");
    expect(plan.artRows).toBe(1);
    expect(plan.artWidth).toBe(COMPACT_BRAND_WIDTH);
    expect(plan.contentWidth).toBe(30 - 2 - 4);
    expect(plan.height).toBe(HEADER_BORDER_ROWS + 1 + 2);
    expect(buildRavenArtRows("compact").map((row) => `${row.mark}${row.wordmark}`)).toEqual([
      COMPACT_BRAND,
    ]);
  });

  it("falls back to plain text when even the compact brand does not fit", () => {
    const plan = ravenHeaderPlan({ columns: 14, rows: 30, contextRows: 2, outerInset: 2 });
    expect(plan.contentWidth).toBeLessThan(COMPACT_BRAND_WIDTH);
    expect(plan.variant).toBe("text");
    expect(plan.artRows).toBe(0);
    expect(plan.artWidth).toBe(0);
    expect(plan.height).toBe(HEADER_BORDER_ROWS + HEADER_TEXT_BRAND_ROWS + 2);
  });

  it("steps down to the one-row compact brand when the five-row art is too tall", () => {
    // The five-row art is only spent when the viewport floor
    // (RAVEN_VIEWPORT_RESERVED_ROWS) still fits underneath: 21 + border 2 +
    // art 5 + context 2 = 30. One row below that, compact still fits.
    const minimum = RAVEN_VIEWPORT_RESERVED_ROWS + HEADER_BORDER_ROWS + RAVEN_ART_ROWS + 2;
    const short = ravenHeaderPlan({ columns: 120, rows: minimum - 1, contextRows: 2, outerInset: 2 });
    const tall = ravenHeaderPlan({ columns: 120, rows: minimum, contextRows: 2, outerInset: 2 });
    expect(short.variant).toBe("compact");
    expect(short.artRows).toBe(1);
    expect(tall.variant).toBe("full");
    expect(short.height).toBeLessThan(tall.height);
    // Even lower, the compact row no longer fits either.
    const text = ravenHeaderPlan({
      columns: 120,
      rows: RAVEN_VIEWPORT_RESERVED_ROWS + HEADER_BORDER_ROWS + 1 + 2 - 1,
      contextRows: 2,
      outerInset: 2,
    });
    expect(text.variant).toBe("text");
    expect(text.height).toBe(HEADER_BORDER_ROWS + HEADER_TEXT_BRAND_ROWS + 2);
  });

  it("renders raven art on the canonical 80×24 terminal when the palette is closed", () => {
    const plan = ravenHeaderPlan({
      columns: 80,
      rows: 24,
      contextRows: 2,
      outerInset: 2,
      reservedRows: VIEWPORT_RESERVED_ROWS_CLOSED,
    });
    // 80 columns clear RAVEN_FULL_MIN_COLUMNS, and 24 rows pay for 13 reserved +
    // 2 border + 5 art + 2 context = 22, so the full mark is affordable.
    expect(plan.variant).toBe("full");
    expect(plan.artRows).toBe(RAVEN_ART_ROWS);
  });

  it("clamps negative sizes, floors fractions and defaults the optional budgets", () => {
    const clamped = ravenHeaderPlan({ columns: -10, rows: -4, contextRows: -3 });
    expect(clamped.columns).toBe(0);
    expect(clamped.rows).toBe(0);
    expect(clamped.contextRows).toBe(0);
    expect(clamped.contentWidth).toBe(0);
    expect(clamped.variant).toBe("text");
    expect(clamped.height).toBe(HEADER_BORDER_ROWS + HEADER_TEXT_BRAND_ROWS);
    // The omitted budgets fall back to the live defaults instead of `NaN`.
    expect(clamped.reservedRows).toBe(RAVEN_VIEWPORT_RESERVED_ROWS);

    const fractional = ravenHeaderPlan({
      columns: 100.9,
      rows: 30.9,
      contextRows: 2.9,
      reservedRows: 0.9,
      outerInset: 2.9,
    });
    expect(fractional.columns).toBe(100);
    expect(fractional.rows).toBe(30);
    expect(fractional.contextRows).toBe(2);
    expect(fractional.reservedRows).toBe(0);
    expect(fractional.contentWidth).toBe(100 - 2 - 4);
    expect(fractional.variant).toBe("full");
  });

  it("measures the width budget after the caller's inset, not the raw columns", () => {
    // Wide enough in columns for the full treatment, but the caller's own
    // padding eats the content box: 100 - 60 - 4 = 36 columns, enough for the
    // compact row only, even though full would otherwise fit.
    const compact = ravenHeaderPlan({
      columns: 100,
      rows: 40,
      contextRows: 2,
      reservedRows: 0,
      outerInset: 60,
    });
    expect(compact.contentWidth).toBe(36);
    expect(compact.variant).toBe("compact");

    // One inset step narrower and the wordmark is still affordable.
    const wordmark = ravenHeaderPlan({
      columns: 100,
      rows: 40,
      contextRows: 2,
      reservedRows: 0,
      outerInset: 56,
    });
    expect(wordmark.contentWidth).toBe(40);
    expect(wordmark.variant).toBe("wordmark");
  });

  it("never claims an art block wider than the header's content box", () => {
    for (const columns of [24, 40, 44, 58, 64, 71, 72, 80, 100, 200]) {
      for (const rows of [24, 27, 28, 30, 40]) {
        const plan = ravenHeaderPlan({ columns, rows, contextRows: 2, outerInset: 2 });
        if (plan.variant !== "text") {
          expect(plan.artWidth).toBeLessThanOrEqual(plan.contentWidth);
          expect(plan.height).toBe(
            HEADER_BORDER_ROWS +
              (plan.variant === "compact" ? 1 : RAVEN_ART_ROWS) +
              plan.contextRows,
          );
        } else {
          expect(plan.height).toBe(HEADER_BORDER_ROWS + HEADER_TEXT_BRAND_ROWS + plan.contextRows);
        }
      }
    }
  });
});

describe("RavenHeader rendering (AC-29.1, AC-29.2, AC-29.3)", () => {
  it("renders the raven mark beside the HUGINN wordmark at ≥ 80 columns", async () => {
    const columns = 100;
    const rows = 30;
    const height = 8 + 2; // headroom for the surrounding chrome/size gate
    const plan = ravenHeaderPlan({ columns, rows: 40, contextRows: 2, outerInset: 2 });
    const output = await capture(ravenHeader(plan), columns, rows);
    const rendered = visibleLines(output);

    expect(plan.variant).toBe("full");
    for (const art of buildRavenArtRows("full")) {
      const composed = `${art.mark}${art.wordmark}`.replace(/\s+$/, "");
      expect(rendered.some((line) => line.includes(composed)), composed).toBe(true);
    }
    // The mark itself (beak/eye/tail) is on screen, not just the wordmark.
    expect(output).toContain("<(o");
    expect(height).toBeGreaterThan(0);
  });

  it("renders exactly the rows the layout budget assumes", async () => {
    for (const [columns, rows] of [
      [100, 30],
      [80, 24],
      [64, 30],
      [40, 24],
    ] as const) {
      const plan = ravenHeaderPlan({ columns, rows, contextRows: 2, outerInset: 2 });
      const output = await capture(ravenHeader(plan), columns, rows);
      expect(visibleLines(output).length, `${columns}x${rows} (${plan.variant})`).toBe(plan.height);
    }
  });

  it("degrades to the wordmark only on a narrow-but-tall terminal", async () => {
    const columns = 64;
    const plan = ravenHeaderPlan({ columns, rows: 40, contextRows: 2, outerInset: 2 });
    const output = await capture(ravenHeader(plan), columns, 40);

    expect(plan.variant).toBe("wordmark");
    for (const row of HUGINN_WORDMARK) {
      expect(output).toContain(row.replace(/\s+$/, ""));
    }
    expect(output).not.toContain("<(o");
    expect(visibleLines(output).length).toBe(plan.height);
  });

  it("renders the compact one-row brand when the wordmark does not fit", async () => {
    const columns = 30;
    const plan = ravenHeaderPlan({ columns, rows: 30, contextRows: 2, outerInset: 2 });
    const output = await capture(ravenHeader(plan), columns, 30);

    expect(plan.variant).toBe("compact");
    expect(output).toContain(COMPACT_BRAND);
    expect(output).not.toContain(HUGINN_WORDMARK[0]!.trim());
    expect(visibleLines(output).length).toBe(plan.height);
  });

  it("falls back to plain HUGINN text on a terminal too narrow for even the compact art", async () => {
    const columns = 14;
    const plan = ravenHeaderPlan({ columns, rows: 30, contextRows: 2, outerInset: 2 });
    const output = await capture(ravenHeader(plan), columns, 30);

    expect(plan.variant).toBe("text");
    expect(output).toContain("HUGINN");
    expect(output).not.toContain("<(o");
    expect(output).not.toContain(HUGINN_WORDMARK[0]!.trim());
    expect(visibleLines(output).length).toBe(plan.height);
  });

  it("renders the full variant with the raven's current mood", async () => {
    const plan = ravenHeaderPlan({ columns: 100, rows: 40, contextRows: 0, outerInset: 2 });
    const thinking = await capture(
      React.createElement(RavenHeader, { plan, rows: [], mood: "thinking" }),
      100,
      30,
    );
    expect(thinking).toContain("<(O");
    expect(thinking).not.toContain("<(o");
  });

  it("renders the brand suffix only in the plain-text fallback", async () => {
    const plan = ravenHeaderPlan({ columns: 14, rows: 30, contextRows: 0, outerInset: 2 });
    // A 14-column terminal leaves 8 content columns, so the fallback truncates:
    // assert the suffix is part of the drawn brand rather than a full literal.
    const withSuffix = await capture(
      React.createElement(RavenHeader, { plan, rows: [], suffix: "X" }),
      14,
      30,
    );
    expect(withSuffix).toContain("HUGINN X");

    const withoutSuffix = await capture(
      React.createElement(RavenHeader, { plan, rows: [] }),
      14,
      30,
    );
    expect(withoutSuffix).toContain("HUGINN");
    expect(withoutSuffix).not.toContain("HUGINN X");
    expect(withoutSuffix).not.toContain("<(o");
  });

  it("never emits a line wider than the terminal, at any size", async () => {
    for (const [columns, rows] of [
      [30, 24],
      [44, 30],
      [58, 30],
      [64, 30],
      [72, 30],
      [80, 24],
      [100, 30],
      [140, 40],
    ] as const) {
      const plan = ravenHeaderPlan({ columns, rows, contextRows: 2, outerInset: 2 });
      const output = await capture(ravenHeader(plan), columns, rows);
      for (const line of output.replace(ANSI, "").split("\n")) {
        expect(line.length, `${columns}x${rows}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe("Dashboard headers use the shared raven brand (AC-29.1, AC-29.4)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("keeps stage/thinker/executor/project in the header and the environment in the panel", async () => {
    const output = await capture(
      React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg, initialShowModelPicker: false }),
      100,
      30,
    );

    expect(output).toContain("<(o");
    for (const row of HUGINN_WORDMARK) {
      expect(output).toContain(row.replace(/\s+$/, ""));
    }
    // The header is identity and ephemeral state (ADR-73): the live stage badge,
    // the project path and the two models.
    expect(output).toMatch(/\[[^\]]*REFINE\]/);
    expect(output).toContain("/mock/project");
    expect(output).toContain("thinker:");
    expect(output).toContain("executor:");
    // The environment — the runtime/agent, the MCP badge, git — lives in the
    // panel now, so the header no longer repeats the runtime name.
    expect(output).toContain("opencode");
    expect(output).toContain("MCP:");
    expect(output).not.toContain("runtime:");
  });

  it("renders raven art, not the text mark, on an 80×24 terminal (REQ-73)", async () => {
    const rows = 24;
    const columns = 80;
    const output = await capture(
      React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg, initialShowModelPicker: false }),
      columns,
      rows,
    );

    // REQ-73: with the palette closed, 80×24 affords the real five-row art, so
    // the header renders the bird instead of the plain text mark.
    expect(output).toContain("<(o");
    expect(output).not.toContain("HUGINN LIVE");
    expect(output).toContain("Conversation");
    // Idle: no stream content, so the agent-output panel is collapsed by design.
    expect(output).not.toContain("THINKING & LIVE AGENT STREAM");
    // The stage is the header's badge; the footer carries keys, not state.
    expect(output).toMatch(/\[[^\]]*REFINE\]/);
    expect(output).not.toContain("stage:");
    // The frame still fits: the bird costs four rows more than text did, so the
    // cards (and the hero) shrink instead of pushing the composer off-screen.
    expect(visibleLines(output).length).toBeLessThanOrEqual(rows);
    for (const line of output.replace(ANSI, "").split("\n")) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("budgets the art header when the command palette is open on a tall terminal", async () => {
    const rows = 30;
    const columns = 100;
    const restore = stubTerminalSize(rows, columns);
    const stdout = new PassThrough() as unknown as PassThrough & { columns: number; rows: number };
    stdout.columns = columns;
    stdout.rows = rows;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const stdin = createMockStdin();
    const instance = render(React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg, initialShowModelPicker: false }), {
      stdout,
      stdin,
      patchConsole: false,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      stdin.write("/");
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      instance.unmount();
      restore();
    }

    expect(output).toContain("▸ /help");
    expect(output).toContain("<(o");
    expect(output).toContain("Conversation");
    expect(output).toMatch(/\[[^\]]*REFINE\]/);
    expect(output).not.toContain("stage:");
    expect(visibleLines(output).length).toBeLessThanOrEqual(rows);
  });

  it("renders the raven brand in the cycle dashboard too, without dropping the run context", async () => {
    const output = await capture(React.createElement(Dashboard, { engine: createMockEngine(), cfg: mockCfg, autoExit: false }), 100, 32);

    expect(output).toContain("<(o");
    for (const row of HUGINN_WORDMARK) {
      expect(output).toContain(row.replace(/\s+$/, ""));
    }
    expect(output).toContain("RUNNING");
    expect(output).toContain("mode:");
    expect(output).toContain("MCP:");
    expect(output).toContain("Elapsed:");
    expect(output).toContain("Active Phase:");
    expect(output).toContain("thinker:");
    expect(output).toContain("PIPELINE PHASES");
  });

  it("keeps the cycle dashboard inside 24 rows on an 80×24 terminal", async () => {
    const rows = 24;
    const columns = 80;
    const output = await capture(React.createElement(Dashboard, { engine: createMockEngine(), cfg: mockCfg, autoExit: false }), columns, rows);

    expect(output).toContain("HUGINN");
    expect(output).toContain("PIPELINE PHASES");
    expect(output).toContain("LIVE AGENT OUTPUT");
    expect(visibleLines(output).length).toBeLessThanOrEqual(rows);
    for (const line of output.replace(ANSI, "").split("\n")) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("never renders the eagle in either header", async () => {
    for (const [columns, rows] of [
      [100, 30],
      [80, 24],
      [40, 30],
    ] as const) {
      const live = await capture(
        React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg, initialShowModelPicker: false }),
        columns,
        rows,
      );
      const cycle = await capture(React.createElement(Dashboard, { engine: createMockEngine(), cfg: mockCfg, autoExit: false }), columns, rows);
      expect(EAGLE.test(live), `live ${columns}x${rows}`).toBe(false);
      expect(EAGLE.test(cycle), `cycle ${columns}x${rows}`).toBe(false);
    }
  });
});

describe("console chrome speaks one measured alphabet (REQ-76)", () => {
  const PICTOGRAPH = /\p{Extended_Pictographic}/u;

  /** The engine's healthy badge source: two live servers, no tool count. */
  const healthyMcp = () => ({
    servers: [
      { id: "pi:pi", name: "pi", status: "connected" as const, transport: "stdio" as const, toolsCount: 3 },
      { id: "pi:muninn", name: "muninn", status: "connected" as const, transport: "stdio" as const, toolsCount: 0 },
    ],
    totalTools: 0,
    healthy: true,
  });

  it("paints the mapped healthy badge on the live console and the cycle dashboard", async () => {
    const live = createMockLive() as unknown as { runtime: unknown };
    live.runtime = {
      name: "pi",
      id: "pi",
      capabilities: { streaming: false, systemPrompts: true, tools: true },
      getMcpStatus: async () => healthyMcp(),
    };
    const liveOut = await capture(
      React.createElement(LiveApp, { live: live as unknown as LiveEngine, cfg: mockCfg, initialShowModelPicker: false }),
      100,
      30,
    );
    const engine = createMockEngine() as unknown as { runtime: unknown };
    engine.runtime = {
      name: "pi",
      id: "pi",
      capabilities: { streaming: false },
      getMcpStatus: async () => healthyMcp(),
    };
    const cycleOut = await capture(
      React.createElement(Dashboard, { engine: engine as unknown as CycleEngine, cfg: mockCfg, autoExit: false }),
      120,
      32,
    );

    // The exact wording both dashboards promise for a healthy report.
    expect(liveOut).toContain("MCP: ✓ 2 connected · pi");
    expect(cycleOut).toContain("MCP: ✓ 2 connected · pi");
    for (const [where, output] of [
      ["live", liveOut],
      ["cycle", cycleOut],
    ] as const) {
      expect(output, where).not.toMatch(PICTOGRAPH);
    }
  });

  it("paints no pictograph and no wide glyph in the live header or the side panel", async () => {
    const live = await capture(
      React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg, initialShowModelPicker: false }),
      100,
      30,
    );
    // The panel really is on screen: otherwise the guardian would pass by not looking.
    expect(live).toContain(PANEL_TITLE);
    const cycle = await capture(
      React.createElement(Dashboard, { engine: createMockEngine(), cfg: mockCfg, autoExit: false }),
      120,
      32,
    );
    for (const [where, output] of [
      ["live", live],
      ["cycle", cycle],
    ] as const) {
      const lines = visibleLines(output);
      expect(lines.length, where).toBeGreaterThan(0);
      for (const line of lines) {
        const detail = `${where}: ${JSON.stringify(line)}`;
        // A double-width glyph breaks the monospace grid the frame measured:
        // Ink lays out one column and the terminal paints two.
        expect(PICTOGRAPH.test(line), detail).toBe(false);
        expect(stringWidth(line), detail).toBe(line.length);
      }
    }
  });
});

describe("source-wide eagle guard (AC-29.1)", () => {
  it("has no eagle code point anywhere under src/", () => {
    const root = new URL("../../src", import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(ts|tsx|json|md)$/.test(entry.name)) continue;
        if (EAGLE.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
