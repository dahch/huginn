import React from "react";
import { PassThrough } from "node:stream";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text, render } from "ink";
import type { CycleEngine } from "../../src/engine/cycle";
import type { RunConfig } from "../../src/config";
import { HUGINN_WORDMARK, RAVEN_MARK, artWidth } from "../../src/brand.js";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine } from "../../src/engine/liveMode";
import {
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
import { LiveApp } from "../../src/tui/LiveDashboard";
import { Dashboard } from "../../src/tui/Dashboard";

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
    runtime: { name: "opencode", id: "opencode" },
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
    expect(headerValue("opencode", 4)).toBe("open");
    expect(headerValue("\u001b[31mred\u001b[0m", 20)).toBe("red");
    expect(headerValue("a\nb\tc", 20)).toBe("a b c");
    expect(headerValue(undefined, 10)).toBe("");
    expect(headerValue("long", 0)).toBe("");
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

  it("falls back to plain text when even the wordmark does not fit", () => {
    const plan = ravenHeaderPlan({ columns: 30, rows: 30, contextRows: 2, outerInset: 2 });
    expect(plan.variant).toBe("text");
    expect(plan.artRows).toBe(0);
    expect(plan.artWidth).toBe(0);
    expect(plan.contentWidth).toBe(30 - 2 - 4);
    expect(plan.height).toBe(HEADER_BORDER_ROWS + HEADER_TEXT_BRAND_ROWS + 2);
  });

  it("drops the art entirely when the terminal is too short to afford it", () => {
    // The art is only spent when the viewport floor (RAVEN_VIEWPORT_RESERVED_ROWS)
    // still fits underneath: 19 + border 2 + art 5 + context 2 = 28.
    const minimum = RAVEN_VIEWPORT_RESERVED_ROWS + HEADER_BORDER_ROWS + RAVEN_ART_ROWS + 2;
    const short = ravenHeaderPlan({ columns: 120, rows: minimum - 1, contextRows: 2, outerInset: 2 });
    const tall = ravenHeaderPlan({ columns: 120, rows: minimum, contextRows: 2, outerInset: 2 });
    expect(short.variant).toBe("text");
    expect(tall.variant).toBe("full");
    expect(short.height).toBeLessThan(tall.height);
    // On the canonical 80×24 terminal the art cannot be afforded, so the header
    // costs border + brand + context rows — the budget the palette depends on
    // (AC-28.4), one row more than the pre-raven header.
    expect(ravenHeaderPlan({ columns: 80, rows: 24, contextRows: 2, outerInset: 2 }).height).toBe(
      HEADER_BORDER_ROWS + HEADER_TEXT_BRAND_ROWS + 2,
    );
  });

  it("never claims an art block wider than the header's content box", () => {
    for (const columns of [24, 40, 44, 58, 64, 71, 72, 80, 100, 200]) {
      for (const rows of [24, 27, 28, 30, 40]) {
        const plan = ravenHeaderPlan({ columns, rows, contextRows: 2, outerInset: 2 });
        if (plan.variant !== "text") {
          expect(plan.artWidth).toBeLessThanOrEqual(plan.contentWidth);
          expect(plan.height).toBe(HEADER_BORDER_ROWS + RAVEN_ART_ROWS + plan.contextRows);
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

  it("falls back to plain HUGINN text on a terminal too narrow for the art", async () => {
    const columns = 30;
    const plan = ravenHeaderPlan({ columns, rows: 30, contextRows: 2, outerInset: 2 });
    const output = await capture(ravenHeader(plan), columns, 30);

    expect(plan.variant).toBe("text");
    expect(output).toContain("HUGINN LIVE");
    expect(output).not.toContain("<(o");
    expect(output).not.toContain(HUGINN_WORDMARK[0]!.trim());
    expect(visibleLines(output).length).toBe(plan.height);
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

  it("renders the mark + wordmark and keeps runtime/thinker/executor/project/MCP context", async () => {
    const output = await capture(
      React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg, initialShowModelPicker: false }),
      100,
      30,
    );

    expect(output).toContain("<(o");
    for (const row of HUGINN_WORDMARK) {
      expect(output).toContain(row.replace(/\s+$/, ""));
    }
    // Presence over decoration (AC-29.4).
    expect(output).toContain("runtime:");
    expect(output).toContain("opencode");
    expect(output).toContain("/mock/project");
    expect(output).toContain("thinker:");
    expect(output).toContain("executor:");
    expect(output).toContain("MCP:");
    expect(output).toContain("REFINE");
  });

  it("keeps the live frame inside the terminal at 80×24 (chat/stream never overflow)", async () => {
    const rows = 24;
    const columns = 80;
    const output = await capture(
      React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg, initialShowModelPicker: false }),
      columns,
      rows,
    );

    // The compact fallback keeps the header at its original 4-row cost.
    expect(output).toContain("HUGINN LIVE");
    expect(output).toContain("REFINEMENT CONVERSATION");
    expect(output).toContain("THINKING & LIVE AGENT STREAM");
    expect(output).toContain("stage: REFINE");
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
    expect(output).toContain("REFINEMENT CONVERSATION");
    expect(output).toContain("stage: REFINE");
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
