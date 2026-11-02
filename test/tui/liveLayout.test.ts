import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import { render } from "./inkRender";
import { events } from "../../src/engine/engineEvents";
import type { DiagnosticsInfo, LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";
import type { DecisionRequest } from "../../src/engine/types";
import { decisionTitle } from "../../src/tui/decision";
import {
  DEFAULT_SPLIT_RATIO,
  LIVE_HEADER_CONTEXT_ROWS,
  LOG_AUTO_COLLAPSE_MS,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  SPLIT_RATIO_STEP,
  VIEWPORT_RESERVED_ROWS_CLOSED,
  VIEWPORT_RESERVED_ROWS_OPEN,
  LiveApp,
  adjustSplitRatio,
  liveCardHeights,
  nextFocus,
} from "../../src/tui/LiveDashboard";
import { MAX_SUGGESTION_ROWS } from "../../src/tui/CommandSuggestions.js";
import {
  COMPACT_BRAND,
  RAVEN_ART_ROWS,
  ravenHeaderPlan,
} from "../../src/tui/RavenHeader.js";
import { HUGINN_WORDMARK } from "../../src/brand.js";
import {
  PANEL_LABEL_COLUMNS,
  PANEL_TITLE,
  PANEL_TIP_PREFIX,
  SIDE_PANEL_GAP_COLUMNS,
  SIDE_PANEL_MIN_CARD_COLUMNS,
  SIDE_PANEL_MIN_COLUMNS,
  SIDE_PANEL_MIN_ROWS,
  SIDE_PANEL_WIDTH,
  InfoPanel,
  panelLines,
  sidePanelPlan,
  slicePanelLines,
  type PanelData,
  type PanelLine,
} from "../../src/tui/InfoPanel.js";
import { HERO_BRAND_TEXT, LiveHero, heroPlan } from "../../src/tui/LiveHero.js";
import { cardChrome } from "../../src/tui/Card.js";
import { EMPTY_CHAT_HINTS } from "../../src/tui/feedback.js";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

function createMockStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as PassThrough & {
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

/** `useTerminalSize()` reads `process.stdout`, not the stream Ink writes to. */
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

/** Visible lines of the last frame, trailing blanks dropped. */
function visibleLines(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const tick = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const diagnostics: DiagnosticsInfo = {
  gitBranch: "feature/live-layout",
  gitClean: false,
  worktreeSandbox: true,
  runtimeName: "opencode",
  thinkerModel: "anthropic/claude-3-7-sonnet",
  executorModel: "opencode/gpt-5.1-codex",
  memoryStats: { entitiesCount: 42, observationsCount: 137 },
};

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "opencode/gpt-5.1-codex",
  cwd: "/mock/project",
} as unknown as RunConfig;

function createMockLive(overrides?: Partial<LiveEngine>): LiveEngine {
  return {
    cfg: mockCfg,
    runtime: {
      name: "opencode",
      id: "opencode",
      capabilities: { streaming: true, systemPrompts: true, tools: true },
      getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    },
    models: { thinker: mockCfg.thinker, executor: mockCfg.executor },
    currentStage: "refine",
    ideaText: "",
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
    switchRuntime: vi.fn(),
    getDiagnostics: vi.fn().mockResolvedValue(diagnostics),
    ...overrides,
  } as unknown as LiveEngine;
}

interface Harness {
  stdin: PassThrough;
  output: () => string;
  unmount: () => void;
}

/** Mounts the live view at a pinned size and captures what Ink writes. */
async function mountLive(
  live: LiveEngine,
  columns: number,
  rows: number,
  cfg: RunConfig = mockCfg,
): Promise<Harness> {
  const restore = stubTerminalSize(rows, columns);
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  const instance = render(React.createElement(LiveApp, { live, cfg }), {
    stdout,
    stdin,
    patchConsole: false,
  });
  await tick();
  return {
    stdin,
    output: () => output,
    unmount: () => {
      instance.unmount();
      restore();
    },
  };
}

/** Types a slash command and presses Enter. */
async function run(stdin: PassThrough, command: string): Promise<void> {
  for (const char of command) {
    stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  stdin.write("\r");
  await tick(80);
}

// ── sidePanelPlan ────────────────────────────────────────────────────────────

describe("side panel geometry (REQ-12)", () => {
  it("shows a fixed-width panel beside the cards from the width threshold up", () => {
    const plan = sidePanelPlan({ columns: SIDE_PANEL_MIN_COLUMNS, availableHeight: 20, inset: 2 });
    expect(plan.visible).toBe(true);
    expect(plan.width).toBe(SIDE_PANEL_WIDTH);
    expect(plan.contentWidth).toBe(SIDE_PANEL_WIDTH - 4);
    // The cards keep the rest of the content width, with one blank column between.
    expect(plan.cardsWidth).toBe(SIDE_PANEL_MIN_COLUMNS - 2 - SIDE_PANEL_WIDTH - 1);
    expect(plan.height).toBe(20);
  });

  it("keeps the panel, its gap and a usable conversation inside the threshold width (REQ-76)", () => {
    const inset = 2;
    // The width the panel pays for is the width it must leave behind: at the
    // narrowest supported terminal the three shares still add up, so widening
    // the panel can never starve the conversation it sits beside.
    expect(
      SIDE_PANEL_WIDTH + SIDE_PANEL_GAP_COLUMNS + SIDE_PANEL_MIN_CARD_COLUMNS,
    ).toBeLessThanOrEqual(SIDE_PANEL_MIN_COLUMNS - inset);
    const plan = sidePanelPlan({ columns: SIDE_PANEL_MIN_COLUMNS, availableHeight: 30, inset });
    expect(plan.visible).toBe(true);
    expect(plan.width + SIDE_PANEL_GAP_COLUMNS + plan.cardsWidth).toBe(SIDE_PANEL_MIN_COLUMNS - inset);
    expect(plan.cardsWidth).toBeGreaterThanOrEqual(SIDE_PANEL_MIN_CARD_COLUMNS);
    // The value column is wide enough for the longest value the panel reports.
    expect(plan.contentWidth - PANEL_LABEL_COLUMNS).toBe(23);
  });

  it("stands down below the width threshold and leaves the layout untouched", () => {
    for (const columns of [24, 40, 64, 80, 99]) {
      const plan = sidePanelPlan({ columns, availableHeight: 30, inset: 2 });
      expect(plan.visible, `${columns} columns`).toBe(false);
      expect(plan.width).toBe(0);
      expect(plan.height).toBe(0);
      // No panel: the cards own the whole content width — exactly the old layout.
      expect(plan.cardsWidth).toBe(columns - 2);
    }
  });

  it("stands down when the main region is too short for any content", () => {
    const short = sidePanelPlan({ columns: 140, availableHeight: SIDE_PANEL_MIN_ROWS - 1, inset: 2 });
    const tall = sidePanelPlan({ columns: 140, availableHeight: SIDE_PANEL_MIN_ROWS, inset: 2 });
    expect(short.visible).toBe(false);
    expect(tall.visible).toBe(true);
  });

  it("never shows the panel when the conversation would be starved of columns", () => {
    // A caller whose container already spends most of the row (e.g. a very wide
    // outer inset) leaves the cards too little room to share.
    const plan = sidePanelPlan({ columns: 100, availableHeight: 30, inset: 60 });
    expect(plan.visible).toBe(false);
    expect(plan.cardsWidth).toBe(40);
  });
});

// ── panelLines / slicePanelLines ─────────────────────────────────────────────

const panelData: PanelData = {
  agentName: "opencode",
  mcpText: "MCP: ✓ 2 connected · opencode",
  mcpToken: "ok",
  git: { branch: "feature/parser", clean: false, sandbox: true },
  memory: { entitiesCount: 42, observationsCount: 137 },
  context: { turns: 3, chars: 1_450 },
  tip: "type / for commands",
};

/** The visible text of a line — what the row actually draws. */
function lineText(line: PanelLine): string {
  if (line.kind === "row") return `${line.label.padEnd(PANEL_LABEL_COLUMNS)}${line.value}`;
  if (line.kind === "section") return line.label;
  if (line.kind === "note") return `${PANEL_TIP_PREFIX}${line.text}`;
  if (line.kind === "badge") return line.text;
  if (line.kind === "title") return line.text;
  return "─".repeat(30);
}

describe("card split and ephemeral log tail", () => {
  it("gives the conversation the whole cards row when the stream is absent", () => {
    expect(
      liveCardHeights({
        availableHeight: 20,
        splitRatio: DEFAULT_SPLIT_RATIO,
        maximized: null,
        showStream: false,
      }),
    ).toEqual({ chatHeight: 20, streamHeight: 0 });
    // A remembered `z` never outlives the stream content it maximized.
    expect(
      liveCardHeights({
        availableHeight: 20,
        splitRatio: DEFAULT_SPLIT_RATIO,
        maximized: "stream",
        showStream: false,
      }),
    ).toEqual({ chatHeight: 20, streamHeight: 0 });
  });

  it("never hands either card a negative or fractional row count", () => {
    for (const availableHeight of [0, 1, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const heights = liveCardHeights({
        availableHeight,
        splitRatio: DEFAULT_SPLIT_RATIO,
        maximized: null,
        showStream: true,
      });
      const where = String(availableHeight);
      expect(Number.isInteger(heights.chatHeight), where).toBe(true);
      expect(Number.isInteger(heights.streamHeight), where).toBe(true);
      expect(heights.chatHeight, where).toBeGreaterThanOrEqual(0);
      expect(heights.streamHeight, where).toBeGreaterThanOrEqual(0);
    }
    // One row of room is the conversation's: a split cannot make it negative.
    expect(
      liveCardHeights({ availableHeight: 1, splitRatio: 0.5, maximized: null, showStream: true }),
    ).toEqual({ chatHeight: 1, streamHeight: 0 });
  });

  it("remembers the conversation/stream split instead of hard-coding one", () => {
    const mid = liveCardHeights({
      availableHeight: 20,
      splitRatio: 0.5,
      maximized: null,
      showStream: true,
    });
    expect(mid).toEqual({ chatHeight: 10, streamHeight: 10 });
    const wide = liveCardHeights({
      availableHeight: 20,
      splitRatio: SPLIT_RATIO_MIN,
      maximized: null,
      showStream: true,
    });
    expect(wide).toEqual({ chatHeight: 6, streamHeight: 14 });
  });

  it("maximizes either card and restores the remembered split", () => {
    const maximizedChat = liveCardHeights({
      availableHeight: 18,
      splitRatio: 0.5,
      maximized: "chat",
      showStream: true,
    });
    expect(maximizedChat).toEqual({ chatHeight: 18, streamHeight: 0 });
    const maximizedStream = liveCardHeights({
      availableHeight: 18,
      splitRatio: 0.5,
      maximized: "stream",
      showStream: true,
    });
    expect(maximizedStream).toEqual({ chatHeight: 0, streamHeight: 18 });
    // Restoring is just "no maximized card": the ratio was never overwritten.
    expect(
      liveCardHeights({
        availableHeight: 18,
        splitRatio: 0.5,
        maximized: null,
        showStream: true,
      }),
    ).toEqual({ chatHeight: 9, streamHeight: 9 });
  });

  it("moves the split in 0.08 steps and clamps it to [0.30, 0.80]", () => {
    expect(adjustSplitRatio(0.58, SPLIT_RATIO_STEP)).toBeCloseTo(0.66);
    expect(adjustSplitRatio(0.58, -SPLIT_RATIO_STEP)).toBeCloseTo(0.5);
    expect(adjustSplitRatio(SPLIT_RATIO_MIN, -SPLIT_RATIO_STEP)).toBe(SPLIT_RATIO_MIN);
    expect(adjustSplitRatio(SPLIT_RATIO_MAX, SPLIT_RATIO_STEP)).toBe(SPLIT_RATIO_MAX);
  });

  it("keeps the step exact, so one press up and one down is the same split", () => {
    // 0.58 - 0.08 is 0.49999999999999994 in binary floating point, and a split a
    // hair under a half paints one row less than the user asked for.
    expect(adjustSplitRatio(0.58, -SPLIT_RATIO_STEP)).toBe(0.5);
    expect(adjustSplitRatio(0.58, SPLIT_RATIO_STEP)).toBe(0.66);
    const up = adjustSplitRatio(DEFAULT_SPLIT_RATIO, SPLIT_RATIO_STEP);
    expect(adjustSplitRatio(up, -SPLIT_RATIO_STEP)).toBe(DEFAULT_SPLIT_RATIO);
    // A non-finite ratio falls back to the default instead of poisoning the split.
    expect(adjustSplitRatio(Number.NaN, SPLIT_RATIO_STEP)).toBe(0.66);
  });

  it("keeps at least six conversation body rows at 100x30 with logs collapsed", () => {
    // 100x30 spends a 9-row header, a 4-row composer and the 1-row footer, so
    // the cards row is 16 rows. With the stream active and the log tail hidden,
    // the default split must still leave the conversation six body rows.
    const heights = liveCardHeights({
      availableHeight: 16,
      splitRatio: DEFAULT_SPLIT_RATIO,
      maximized: null,
      showStream: true,
    });
    expect(heights.chatHeight - cardChrome("primary").rows).toBeGreaterThanOrEqual(6);
  });
});

describe("live card sizing and ephemeral logs (keyboard)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.useRealTimers();
  });

  it("still types z into the composer instead of maximizing a card", async () => {
    const h = await mountLive(createMockLive(), 120, 40);
    h.stdin.write("z");
    await tick(80);
    h.unmount();

    expect(h.output()).toContain("❯ z");
  });

  it("keeps focus on the card after z maximizes it and z restores the split", async () => {
    const h = await mountLive(createMockLive(), 120, 40);
    events.emit("phaseStream", { text: "reasoning…" });
    await tick(140);
    h.stdin.write("\t"); // composer → conversation
    await tick(60);
    h.stdin.write("z");
    await tick(80);
    h.stdin.write("z");
    await tick(80);
    h.unmount();

    expect(h.output()).toContain("Conversation ● [Focused]");
    expect(h.output()).toContain("[Tab] Focus: chat");
    expect(h.output()).not.toContain("❯ z");
  });

  /** Let React flush an external event without relying on the faked timers. */
  const flushReact = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("collapses the log tail after the idle timer and L reopens it from a focused card", async () => {
    const h = await mountLive(createMockLive(), 100, 30);
    try {
      // Only the collapse timer is faked: React's scheduler keeps its real
      // macrotasks, so an `events.emit` becomes a render before time advances.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      events.emit("log", { level: "info", message: "ephemeral-log" });
      await flushReact();
      await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
      await flushReact();
      h.stdin.write("\t"); // composer → conversation
      await flushReact();
      h.stdin.write("L");
      await flushReact();
      await vi.advanceTimersByTimeAsync(80);
      await flushReact();
    } finally {
      h.unmount();
      vi.useRealTimers();
    }

    // `L` pinned it back open; the collapse itself is asserted by the next test.
    expect(h.output()).toContain("SYSTEM LOGS");
    expect(h.output()).toContain("ephemeral-log");
    expect(h.output()).not.toContain("[L] logs ·");
  });

  it("types L into the composer instead of reopening a collapsed log tail", async () => {
    const h = await mountLive(createMockLive(), 100, 30);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      events.emit("log", { level: "info", message: "composer-log" });
      await flushReact();
      await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
      await flushReact();
      h.stdin.write("L");
      await flushReact();
    } finally {
      h.unmount();
      vi.useRealTimers();
    }

    // The uppercase key is a shortcut only on a focused card; in the composer it
    // is ordinary draft text, and the collapsed tail stays exactly as it was.
    expect(h.output()).toContain("❯ L");
    expect(h.output()).not.toContain("SYSTEM LOGS");
    expect(h.output()).toContain("[L] logs · 1");
  });

  it("collapses the log tail out of the frame after the idle timer", async () => {
    const h = await mountLive(createMockLive(), 100, 30);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      events.emit("log", { level: "info", message: "ephemeral-log" });
      await flushReact();
      await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
      await flushReact();
    } finally {
      h.unmount();
      vi.useRealTimers();
    }

    expect(h.output()).toContain("[L] logs · 1");
  });

  it("never auto-collapses a tail that contains an error", async () => {
    const h = await mountLive(createMockLive(), 100, 30);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      events.emit("log", { level: "error", message: "boom" });
      await flushReact();
      await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS * 2);
      await flushReact();
    } finally {
      h.unmount();
      vi.useRealTimers();
    }

    expect(h.output()).toContain("boom");
    expect(h.output()).not.toContain("[L] logs ·");
  });
});

describe("maximized cards, the moved split and persistent logs (keyboard)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.useRealTimers();
  });

  /**
   * The painted height of one card in the final frame — border rows, title row
   * and body — or `null` when the layout did not render it at all. The console
   * writes one frame on unmount (no TTY here), so this is exactly what the user
   * would see.
   */
  function cardRows(output: string, title: string): number | null {
    const lines = visibleLines(output);
    const titleAt = lines.findIndex((line) => line.includes(title));
    // `Card` draws the border first and the title under it, so the card starts
    // one row above its title.
    if (titleAt < 1) return null;
    for (let index = titleAt + 1; index < lines.length; index += 1) {
      const trimmed = lines[index]!.trimStart();
      if (trimmed.startsWith("╰") || trimmed.startsWith("└")) {
        return index - (titleAt - 1) + 1;
      }
    }
    return null;
  }

  const CHAT = "Conversation";
  const STREAM = "THINKING & LIVE AGENT STREAM";

  /** Mounts the console with a live stream and returns the painted card sizes. */
  async function cardsAfter(
    keys: string[] = [],
    columns = 100,
    rows = 30,
  ): Promise<{ chat: number | null; stream: number | null; output: string }> {
    const harness = await mountLive(createMockLive(), columns, rows);
    events.emit("phaseStream", { text: "reasoning…" });
    await tick(140);
    for (const key of keys) {
      harness.stdin.write(key);
      await tick(70);
    }
    harness.unmount();
    const output = harness.output();
    return { chat: cardRows(output, CHAT), stream: cardRows(output, STREAM), output };
  }

  it("keeps the pre-maximize split as the baseline at 100x30", async () => {
    const base = await cardsAfter();
    // 30 rows spend the header, the composer and the footer; the cards row is
    // 16 and the conversation keeps its default 0.58 share of it.
    expect(base.chat).toBe(9);
    expect(base.stream).toBe(7);
    expect(base.chat! + base.stream!).toBe(16);
  });

  it("maximizes the focused stream card and gives the rows back on a second z", async () => {
    const base = await cardsAfter();
    const maximized = await cardsAfter(["\t", "\t", "z"]);
    // The stream owns the whole cards row; the conversation is not rendered at
    // all instead of being squeezed to a one-row stub.
    expect(maximized.chat).toBeNull();
    expect(maximized.stream).toBe(base.chat! + base.stream!);
    expect(maximized.output).not.toContain(CHAT);
    // Focus stays on the card that owns the row, so `z`/Tab still act on it.
    expect(maximized.output).toContain("[Tab] Focus: stream");

    const restored = await cardsAfter(["\t", "\t", "z", "z"]);
    expect(restored.chat).toBe(base.chat);
    expect(restored.stream).toBe(base.stream);
    expect(restored.output).toContain("[Tab] Focus: stream");
    // `z` is a command on a card and ordinary text in the composer, never both.
    expect(restored.output).not.toContain("❯ z");
  });

  it("maximizes the focused conversation and restores it the same way", async () => {
    const base = await cardsAfter();
    const maximized = await cardsAfter(["\t", "z"]);
    expect(maximized.chat).toBe(base.chat! + base.stream!);
    expect(maximized.stream).toBeNull();
    expect(maximized.output).toContain("[Tab] Focus: chat");

    const restored = await cardsAfter(["\t", "z", "z"]);
    expect(restored.chat).toBe(base.chat);
    expect(restored.stream).toBe(base.stream);
  });

  it("keeps the stream card closed for a blank-only stream buffer", async () => {
    const base = await cardsAfter();
    const harness = await mountLive(createMockLive(), 100, 30);
    // Every phase that emits nothing leaves a newline in the buffer: that is
    // not content, so the card must not open (and must not take focus).
    events.emit("phaseStream", { text: "\n" });
    await tick(140);
    harness.stdin.write("\t"); // composer → conversation
    await tick(70);
    harness.unmount();

    const output = harness.output();
    expect(output).toContain(CHAT);
    expect(output).not.toContain(STREAM);
    // The conversation owns the whole row, exactly as if no stream existed.
    expect(cardRows(output, CHAT)).toBe(base.chat! + base.stream!);
    expect(output).toContain("[Tab] Focus: chat");
  });

  /** `\u001B[1;5A`/`B` is xterm's Ctrl+↑/↓. */
  const CTRL_UP = "\u001B[1;5A";
  const CTRL_DOWN = "\u001B[1;5B";

  it("moves the split by one 0.08 step per Ctrl+↑/↓ from a focused card", async () => {
    const base = await cardsAfter();
    const grown = await cardsAfter(["\t", CTRL_UP]);
    // 0.58 → 0.66 of 16 rows: 9 → 10, and the stream pays for it.
    expect(grown.chat).toBe(base.chat! + 1);
    expect(grown.stream).toBe(base.stream! - 1);

    const shrunk = await cardsAfter(["\t", CTRL_DOWN]);
    expect(shrunk.chat).toBe(base.chat! - 1);
    expect(shrunk.stream).toBe(base.stream! + 1);
  });

  it("clamps the split to [0.30, 0.80] however many times it is pressed", async () => {
    const many = Array.from({ length: 30 }, () => CTRL_UP);
    const maxed = await cardsAfter(["\t", ...many]);
    // 0.80 of 16 rows is 12; the conversation never takes the stream's last rows.
    expect(maxed.chat).toBe(12);
    expect(maxed.stream).toBe(4);

    const drained = await cardsAfter(["\t", ...Array.from({ length: 30 }, () => CTRL_DOWN)]);
    // 0.30 of 16 is 4; the conversation is never squeezed below it.
    expect(drained.chat).toBe(4);
    expect(drained.stream).toBe(12);
  });

  it("leaves the split alone while the composer owns the keys", async () => {
    const base = await cardsAfter();
    const composer = await cardsAfter([CTRL_UP, CTRL_UP, CTRL_UP]);
    expect(composer.chat).toBe(base.chat);
    expect(composer.stream).toBe(base.stream);
    // The chord never leaks into the draft either: the placeholder still shows.
    expect(composer.output).toContain("❯ Message...");
    expect(composer.output).toContain("[Tab] Focus: input");
  });

  it("never focuses a card the maximized layout hid", () => {
    // Composer → (no conversation) → stream → composer.
    expect(nextFocus("composer", true, false, false)).toBe("stream");
    expect(nextFocus("stream", true, false, false)).toBe("composer");
    expect(nextFocus("composer", true, true, false)).toBe("stream");
    // Neither card: Tab stays on the composer instead of announcing nothing.
    expect(nextFocus("composer", false, false, false)).toBe("composer");
  });

  /** Let React flush an external event without relying on the faked timers. */
  const flushReact = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** Mounts, emits the given logs and runs `act`, all under faked timers. */
  async function withLogs(
    logs: Array<{ level: "info" | "warn" | "error"; message: string }>,
    act: (harness: Harness) => Promise<void>,
    withStream = false,
  ): Promise<string> {
    const harness = await mountLive(createMockLive(), 100, 30);
    if (withStream) {
      // The cards row is only split when the stream has content, and the split
      // is what the collapsed tail gives its rows back to.
      events.emit("phaseStream", { text: "reasoning…" });
      await tick(140);
    }
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (const entry of logs) {
        events.emit("log", entry);
        await flushReact();
      }
      await act(harness);
    } finally {
      harness.unmount();
      vi.useRealTimers();
    }
    return harness.output();
  }

  it("lets the visible tail own exactly its entries plus its title row", async () => {
    const base = await cardsAfter();
    const output = await withLogs(
      [0, 1, 2].map((index) => ({ level: "info" as const, message: `entry-${index}` })),
      async () => {},
      true,
    );
    const chat = cardRows(output, CHAT);
    const stream = cardRows(output, STREAM);
    // Three entries and the tertiary card's one title row come out of the cards
    // row, not out of the terminal: nothing is pushed off the frame.
    expect(chat! + stream!).toBe(base.chat! + base.stream! - (3 + cardChrome("tertiary").rows));
    expect(output).toContain("SYSTEM LOGS");
    expect(visibleLines(output).length).toBeLessThanOrEqual(30);
  });

  it("collapses the idle tail out of the frame and advertises the hidden count", async () => {
    const base = await cardsAfter();
    const output = await withLogs(
      [0, 1, 2].map((index) => ({ level: "info" as const, message: `entry-${index}` })),
      async () => {
        await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
        await flushReact();
      },
      true,
    );
    const chat = cardRows(output, CHAT);
    const stream = cardRows(output, STREAM);
    // Collapsed logs occupy no row at all: the cards row is the un-logged one.
    expect(chat! + stream!).toBe(base.chat! + base.stream!);
    expect(output).not.toContain("SYSTEM LOGS");
    expect(output).not.toContain("entry-0");
    // ...and the footer says how many rows `L` would bring back.
    expect(output).toContain("[L] logs · 3");
  });

  it("keeps a tail holding an error open past the idle timeout", async () => {
    const output = await withLogs(
      [
        { level: "info", message: "first" },
        { level: "error", message: "boom" },
      ],
      async () => {
        await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS * 2);
        await flushReact();
      },
    );
    expect(output).toContain("boom");
    expect(output).toContain("SYSTEM LOGS");
    expect(output).not.toContain("[L] logs ·");
  });

  it("advertises every hidden entry, not just the visible tail size", async () => {
    const output = await withLogs(
      Array.from({ length: 6 }, (_, index) => ({
        level: "info" as const,
        message: `queued-${index}`,
      })),
      async () => {
        await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
        await flushReact();
      },
      true,
    );
    // The 30-row frame only holds a three-entry tail, but all six queued entries
    // are hidden by the collapse and `L` brings all of them back.
    expect(output).toContain("[L] logs · 6");
  });

  it("auto-collapses once a stale error has scrolled out of the visible tail", async () => {
    const output = await withLogs(
      [
        { level: "error", message: "old-boom" },
        ...Array.from({ length: 5 }, (_, index) => ({
          level: "info" as const,
          message: `after-${index}`,
        })),
      ],
      async () => {
        await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
        await flushReact();
      },
    );
    // The error is still in the ring buffer but no longer in the visible tail,
    // so it must not disable auto-collapse for the rest of the session.
    expect(output).not.toContain("SYSTEM LOGS");
    expect(output).toContain("[L] logs · 6");
  });

  it("pins the tail with L past every timeout and releases it to a fresh minute", async () => {
    const pinned = await withLogs([{ level: "info", message: "pinned-entry" }], async (harness) => {
      harness.stdin.write("\t"); // composer → conversation
      await flushReact();
      harness.stdin.write("L");
      await flushReact();
      await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS * 2);
      await flushReact();
    });
    expect(pinned).toContain("pinned-entry");
    expect(pinned).not.toContain("[L] logs ·");

    const released = await withLogs([{ level: "info", message: "pinned-entry" }], async (harness) => {
      harness.stdin.write("\t"); // composer → conversation
      await flushReact();
      harness.stdin.write("L");
      await flushReact();
      harness.stdin.write("L");
      await flushReact();
      // Unpinning starts a new minute: the tail is not hidden on the same
      // keypress just because the last event is already older than the timeout.
      await vi.advanceTimersByTimeAsync(200);
      await flushReact();
    });
    expect(released).toContain("pinned-entry");
    expect(released).not.toContain("[L] logs ·");
  });

  it("collapses the tail again one minute after the pin is released", async () => {
    const output = await withLogs([{ level: "info", message: "pinned-entry" }], async (harness) => {
      harness.stdin.write("\t"); // composer → conversation
      await flushReact();
      harness.stdin.write("L");
      await flushReact();
      harness.stdin.write("L");
      await flushReact();
      await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 200);
      await flushReact();
    });
    expect(output).not.toContain("SYSTEM LOGS");
    expect(output).toContain("[L] logs · 1");
  });

  it("reopens a collapsed tail when a new event arrives", async () => {
    const output = await withLogs([{ level: "info", message: "first" }], async () => {
      await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
      await flushReact();
      events.emit("log", { level: "info", message: "second" });
      await flushReact();
      await vi.advanceTimersByTimeAsync(200);
      await flushReact();
    });
    expect(output).toContain("SYSTEM LOGS");
    expect(output).toContain("second");
    expect(output).toContain("first");
    expect(output).not.toContain("[L] logs ·");
  });

  it("keeps six conversation body rows at 100x30 with the stream and collapsed logs", async () => {
    const output = await withLogs(
      [0, 1].map((index) => ({ level: "info" as const, message: `entry-${index}` })),
      async () => {
        await vi.advanceTimersByTimeAsync(LOG_AUTO_COLLAPSE_MS + 80);
        await flushReact();
      },
      true,
    );
    const chat = cardRows(output, CHAT);
    const stream = cardRows(output, STREAM);
    expect(chat).not.toBeNull();
    // The frame the user gets: the conversation's body rows, title and borders
    // paid for out of the painted card.
    expect(chat! - cardChrome("primary").rows).toBeGreaterThanOrEqual(6);
    // And the pure layout function the dashboard called agrees with that frame:
    // the cards row it was handed is the two cards it painted, and its default
    // split still leaves six body rows (AC: verified by the layout function).
    const heights = liveCardHeights({
      availableHeight: chat! + stream!,
      splitRatio: DEFAULT_SPLIT_RATIO,
      maximized: null,
      showStream: true,
    });
    expect(heights.chatHeight).toBe(chat);
    expect(heights.chatHeight - cardChrome("primary").rows).toBeGreaterThanOrEqual(6);
  });

  it("draws no metric the diagnostics never reported", async () => {
    const harness = await mountLive(createMockLive(), 120, 40);
    events.emit("phaseStream", { text: "reasoning…" });
    await tick(140);
    harness.unmount();
    const output = harness.output();
    // `DiagnosticsInfo` exposes no iteration counter, so no progress bar, no
    // percentage and no iteration row may be drawn to fill the panel's space.
    expect(output).not.toMatch(/\d+\s*%/);
    expect(output.toLowerCase()).not.toContain("iteration");
    expect(output.toLowerCase()).not.toContain("progress");
  });
});

/**
 * The live console's decision keys (REQ-37 / AC-37.3). Every decision kind owns a
 * small alphabet, and a key outside it must never answer anything — Ink sends
 * `""` for every non-alphanumeric keypress, which is exactly how the first option
 * used to get picked by accident.
 */
describe("live decision keys (REQ-37 / AC-37.3)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  async function answer(
    request: DecisionRequest,
    keys: string[],
  ): Promise<{ live: LiveEngine; output: string }> {
    const live = createMockLive();
    const harness = await mountLive(live, 100, 34);
    events.emit("decision", request);
    await tick(140);
    for (const key of keys) {
      harness.stdin.write(key);
      await tick(80);
    }
    harness.unmount();
    return { live, output: harness.output() };
  }

  const permission: DecisionRequest = {
    id: "perm-1",
    kind: "permission",
    iteration: 0,
    phase: "EXECUTE",
    attempt: 1,
    message: "Allow writing src/index.ts?",
  };

  it("maps the permission keys to allow, retry and deny", async () => {
    const expected: Array<[string, "continue" | "retry" | "deny"]> = [
      ["a", "continue"],
      ["o", "retry"],
      ["d", "deny"],
    ];
    for (const [key, choice] of expected) {
      const { live } = await answer(permission, [key]);
      expect(live.resolveDecision, `key ${key}`).toHaveBeenCalledWith(choice, undefined);
    }
  });

  it("leaves an unadvertised permission key unanswered", async () => {
    const { live } = await answer(permission, ["x"]);
    expect(live.resolveDecision).not.toHaveBeenCalled();
  });

  it("maps the question keys to the chosen option, a skip and an abort", async () => {
    const question: DecisionRequest = {
      id: "q-2",
      kind: "question",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message: "Which database?",
      questionItems: [
        {
          question: "Which database?",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
      ],
    };
    const accepted = await answer(question, ["\r"]);
    expect(accepted.live.resolveDecision).toHaveBeenCalledWith("continue", ["Postgres"]);

    const skipped = await answer(question, ["d"]);
    expect(skipped.live.resolveDecision).toHaveBeenCalledWith("deny", undefined);

    const aborted = await answer(question, ["\u001B"]);
    expect(aborted.live.resolveDecision).toHaveBeenCalledWith("abort", undefined);
  });

  it("tells the user what to press instead of swallowing an unknown question key", async () => {
    const question: DecisionRequest = {
      id: "q-3",
      kind: "question",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message: "Which queue?",
      questionItems: [
        {
          question: "Which queue?",
          options: [{ label: "SQS" }, { label: "RabbitMQ" }, { label: "Kafka" }],
        },
      ],
    };
    const { live, output } = await answer(question, ["x"]);
    expect(live.resolveDecision).not.toHaveBeenCalled();
    // The count comes from the question, so the hint can never advertise an
    // option the question does not have.
    expect(output).toContain("Press 1-3 to pick an option");
  });

  it("offers the promotion-recovery keys only when the prompt offers them", async () => {
    const full: DecisionRequest = {
      id: "post-1",
      kind: "post-cycle-live",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message: "Cycle failed.",
      choices: ["retry-promotion", "repair", "retry", "continue", "abort"],
    };
    const expected: Array<[string, "retry-promotion" | "repair" | "retry" | "continue" | "abort"]> = [
      ["t", "retry-promotion"],
      ["p", "repair"],
      ["r", "retry"],
      ["c", "continue"],
      ["a", "abort"],
    ];
    for (const [key, choice] of expected) {
      const { live } = await answer(full, [key]);
      expect(live.resolveDecision, `key ${key}`).toHaveBeenCalledWith(choice, undefined);
    }

    const plain: DecisionRequest = {
      ...full,
      choices: ["retry", "continue", "abort"],
    };
    const offered = await answer(plain, ["t"]);
    expect(offered.live.resolveDecision).not.toHaveBeenCalled();
    const other = await answer(plain, ["p"]);
    expect(other.live.resolveDecision).not.toHaveBeenCalled();
  });
});

describe("panel lines (REQ-12)", () => {
  const contentWidth = SIDE_PANEL_WIDTH - 4;

  it("renders every section the session really has, in priority order", () => {
    const lines = panelLines(panelData, contentWidth);
    const labels = lines.filter((line) => line.kind === "row").map((line) => line.label);
    expect(lines[0]).toEqual({ kind: "title", text: PANEL_TITLE });
    // The live stage lives in the header badge, never in the panel (ADR-73).
    expect(labels).not.toContain("stage");
    expect(labels).toContain("agent");
    // The models live in the header; repeating them in the panel cost two rows
    // and told the same story twice.
    expect(labels).not.toContain("thinker");
    expect(labels).not.toContain("executor");
    expect(labels).toContain("git");
    expect(labels).toContain("sandbox");
    expect(labels).toContain("muninn");
    expect(labels).toContain("ctx");
    // The MCP line is the attributed badge itself, so it is not clipped to the
    // label column the way a `label: value` row is.
    expect(lines.some((line) => line.kind === "badge" && line.text.includes("MCP:"))).toBe(true);
    expect(lines[lines.length - 1]?.kind).toBe("note");
    for (const line of lines) {
      expect(lineText(line).length, lineText(line)).toBeLessThanOrEqual(contentWidth);
    }
  });

  it("drops a row whose data is missing instead of inventing one", () => {
    const bare = panelLines(
      {
        ...panelData,
        git: null,
        memory: null,
        context: { turns: 0, chars: 0 },
        tip: "",
      },
      contentWidth,
    );
    const labels = bare.filter((line) => line.kind === "row").map((line) => line.label);
    expect(labels).not.toContain("git");
    expect(labels).not.toContain("sandbox");
    expect(labels).not.toContain("muninn");
    // An empty conversation has no context size to report (NFR-10).
    expect(labels).not.toContain("ctx");
    expect(bare.some((line) => line.kind === "note")).toBe(false);
  });

  it("shows an unavailable Muninn database as unavailable, never as empty", () => {
    const lines = panelLines(
      { ...panelData, memory: { entitiesCount: 0, observationsCount: 0, error: "locked" } },
      contentWidth,
    );
    const muninn = lines.find((line) => line.kind === "row" && line.label === "muninn");
    expect(muninn).toEqual({
      kind: "row",
      label: "muninn",
      value: "unavailable — locked",
      token: "danger",
    });
    expect(JSON.stringify(lines)).not.toContain("0 entities");
  });

  it("clamps a long branch, badge or tip to the columns the box has", () => {
    const lines = panelLines(
      {
        ...panelData,
        git: { branch: "feature/".repeat(20), clean: true, sandbox: false },
        mcpText: "MCP: ! error — " + "x".repeat(80) + " · opencode",
        tip: "t".repeat(90),
      },
      contentWidth,
    );
    for (const line of lines) {
      expect(lineText(line).length, lineText(line)).toBeLessThanOrEqual(contentWidth);
    }
  });

  it("keeps only the rows that fit, without a dangling divider", () => {
    const lines = panelLines(panelData, contentWidth);
    const sliced = slicePanelLines(lines, 4);
    expect(sliced).toHaveLength(4);
    expect(sliced[0]?.kind).toBe("title");
    // The divider before the tip can never be the last thing on screen.
    const tipOnly = slicePanelLines(lines, lines.length - 1);
    expect(tipOnly[tipOnly.length - 1]?.kind).not.toBe("divider");
    expect(slicePanelLines(lines, 0)).toEqual([]);
    expect(slicePanelLines(lines, 99)).toEqual(lines);
  });

  it("groups the rows into SESSION / REPO / MEMORY sections", () => {
    const lines = panelLines(panelData, contentWidth);
    const headings = lines.filter((line) => line.kind === "section").map((line) => line.label);
    expect(headings).toEqual(["SESSION", "REPO", "MEMORY"]);
    const at = (label: string): number =>
      lines.findIndex((line) => line.kind === "section" && line.label === label);
    expect(at("SESSION")).toBeLessThan(
      lines.findIndex((line) => line.kind === "row" && line.label === "agent"),
    );
    expect(at("REPO")).toBeLessThan(
      lines.findIndex((line) => line.kind === "row" && line.label === "git"),
    );
    expect(at("MEMORY")).toBeLessThan(
      lines.findIndex((line) => line.kind === "row" && line.label === "muninn"),
    );
  });

  it("does not draw a section whose data is missing", () => {
    const lines = panelLines(
      {
        ...panelData,
        git: null,
        memory: null,
        context: { turns: 0, chars: 0 },
        tip: "",
      },
      contentWidth,
    );
    expect(lines.filter((line) => line.kind === "section").map((line) => line.label)).toEqual([
      "SESSION",
    ]);
  });

  it("drops a section header left without any row under it", () => {
    const lines = panelLines(panelData, contentWidth);
    const memoryAt = lines.findIndex((line) => line.kind === "section" && line.label === "MEMORY");
    const sliced = slicePanelLines(lines, memoryAt + 1);
    expect(sliced[sliced.length - 1]?.kind).not.toBe("section");
  });

  it("defaults the caller's inset to two columns when it is omitted", () => {
    const plan = sidePanelPlan({ columns: 120, availableHeight: 20 });
    // The default inset is the shared outer `paddingX={1}` on both sides.
    expect(plan.cardsWidth).toBe(120 - 2 - SIDE_PANEL_WIDTH - 1);
    expect(plan.contentWidth).toBe(SIDE_PANEL_WIDTH - 4);
  });

  it("drops the agent and MCP rows when the session has neither", () => {
    const lines = panelLines({ ...panelData, agentName: "", mcpText: "" }, contentWidth);
    const labels = lines.filter((line) => line.kind === "row").map((line) => line.label);
    expect(labels).not.toContain("agent");
    expect(lines.some((line) => line.kind === "badge")).toBe(false);
    // The stage is not a panel row at all: its home is the header badge.
    expect(labels).not.toContain("stage");
  });

  it("renders nothing at all when the plan says the panel is hidden", () => {
    const plan = sidePanelPlan({ columns: 80, availableHeight: 30, inset: 2 });
    expect(InfoPanel({ plan, data: panelData })).toBeNull();
  });
});

// ── header viewport budget ───────────────────────────────────────────────────

describe("live header viewport budget (REQ-73)", () => {
  it("charges the palette rows only while the palette is open", () => {
    // The open budget is the closed one plus the tallest palette (its content
    // rows and its own two border rows).
    expect(VIEWPORT_RESERVED_ROWS_OPEN - VIEWPORT_RESERVED_ROWS_CLOSED).toBe(
      MAX_SUGGESTION_ROWS + 2,
    );
  });

  it("re-derives the header plan when the palette opens, and returns the art on close", () => {
    const sizing = { columns: 80, rows: 24, contextRows: 2, outerInset: 2 } as const;
    const closed = ravenHeaderPlan({
      ...sizing,
      reservedRows: VIEWPORT_RESERVED_ROWS_CLOSED,
    });
    expect(closed.variant).toBe("full");
    expect(closed.artRows).toBe(RAVEN_ART_ROWS);

    // 24 rows cannot pay for the palette's 8 extra rows plus the five-row art,
    // so the header shrinks (here to plain text) instead of squeezing the frame.
    const open = ravenHeaderPlan({
      ...sizing,
      reservedRows: VIEWPORT_RESERVED_ROWS_OPEN,
    });
    expect(open.variant).toBe("text");
    expect(open.height).toBeLessThan(closed.height);

    // Closing the palette gives the art back: the same terminal, the closed
    // budget, the full plan again.
    const reopened = ravenHeaderPlan({
      ...sizing,
      reservedRows: VIEWPORT_RESERVED_ROWS_CLOSED,
    });
    expect(reopened).toEqual(closed);
  });

  it("keeps the compact row at 80×28 when the palette opens", () => {
    const sizing = { columns: 80, rows: 28, contextRows: 2, outerInset: 2 } as const;
    const closed = ravenHeaderPlan({ ...sizing, reservedRows: VIEWPORT_RESERVED_ROWS_CLOSED });
    const open = ravenHeaderPlan({ ...sizing, reservedRows: VIEWPORT_RESERVED_ROWS_OPEN });
    expect(closed.variant).toBe("full");
    expect(open.variant).toBe("compact");
    expect(open.height).toBeLessThan(closed.height);
    expect(open.height).toBe(closed.height - RAVEN_ART_ROWS + 1);
  });
});

// ── heroPlan ─────────────────────────────────────────────────────────────────

describe("empty-state hero (REQ-12)", () => {
  it("degrades width-first, exactly like the raven header", () => {
    // The hero works on the card's *body* columns, so it can show the full art
    // wherever the 54-column composed block fits (the header needs 72 terminal
    // columns because it pays for its own border and padding).
    expect(heroPlan({ rows: 20, columns: 74 }).variant).toBe("full");
    expect(heroPlan({ rows: 20, columns: 60 }).variant).toBe("full");
    expect(heroPlan({ rows: 20, columns: 50 }).variant).toBe("wordmark");
    // Below the wordmark, the one-row raven head is the last art rung (REQ-73).
    expect(heroPlan({ rows: 20, columns: 30 }).variant).toBe("compact");
    expect(heroPlan({ rows: 20, columns: 30 }).artRows.map((row) => `${row.mark}${row.wordmark}`)).toEqual([
      "<(o  HUGINN",
    ]);
    expect(heroPlan({ rows: 20, columns: 8 }).variant).toBe("text");
    // The wordmark-only variant drops the mark column entirely.
    expect(heroPlan({ rows: 20, columns: 50 }).artRows.every((row) => row.mark === "")).toBe(true);
    expect(heroPlan({ rows: 20, columns: 74 }).artRows.some((row) => row.mark.includes("<(o"))).toBe(
      true,
    );
  });

  it("carries the raven's mood into the art on the header's exact grid", () => {
    const idle = heroPlan({ rows: 20, columns: 74, mood: "idle" });
    const thinking = heroPlan({ rows: 20, columns: 74, mood: "thinking" });
    const sleeping = heroPlan({ rows: 20, columns: 74, mood: "sleeping" });
    expect(idle.variant).toBe("full");
    expect(thinking.variant).toBe("full");
    expect(sleeping.variant).toBe("full");
    expect(thinking.artRows).toHaveLength(idle.artRows.length);
    expect(sleeping.artRows).toHaveLength(idle.artRows.length);
    for (const [index, row] of idle.artRows.entries()) {
      // Wordmark and column budget are mood-independent.
      expect(thinking.artRows[index]?.wordmark).toBe(row.wordmark);
      expect(sleeping.artRows[index]?.wordmark).toBe(row.wordmark);
      expect(thinking.artRows[index]?.mark.length).toBe(row.mark.length);
      expect(sleeping.artRows[index]?.mark.length).toBe(row.mark.length);
    }
    expect(idle.artRows[2]?.mark).toContain("<(o");
    expect(thinking.artRows[2]?.mark).toContain("<(O");
    expect(sleeping.artRows[2]?.mark).toContain("<(- ");
    // The default is idle, so an omitted mood never silently differs.
    expect(heroPlan({ rows: 20, columns: 74 }).artRows).toEqual(idle.artRows);
  });

  it("blinks the thinking hero to the idle mark without reflowing the grid", () => {
    const thinking = heroPlan({ rows: 20, columns: 74, mood: "thinking" });
    const blinked = heroPlan({ rows: 20, columns: 74, mood: "thinking", blink: true });
    const idle = heroPlan({ rows: 20, columns: 74, mood: "idle" });
    // The hero and the header share the blink: the closed-eye frame is the idle
    // mark, same rows, same widths, no new glyph.
    expect(blinked.rows).toBe(thinking.rows);
    expect(blinked.artRows).toHaveLength(thinking.artRows.length);
    expect(blinked.artRows).toEqual(idle.artRows);
    // `blink` is ignored for every mood other than `thinking`.
    expect(heroPlan({ rows: 20, columns: 74, mood: "idle", blink: true }).artRows).toEqual(
      idle.artRows,
    );
    expect(
      heroPlan({ rows: 20, columns: 74, mood: "sleeping", blink: true }).artRows,
    ).toEqual(heroPlan({ rows: 20, columns: 74, mood: "sleeping" }).artRows);
  });

  it("draws nothing when the card body has no rows, and clamps nonsense", () => {
    const empty = heroPlan({ rows: 0, columns: 74 });
    expect(empty.rows).toBe(0);
    expect(empty.copyRows).toEqual([]);
    expect(LiveHero({ rows: 0, columns: 74 })).toBeNull();

    const clamped = heroPlan({ rows: -10, columns: -4 });
    expect(clamped.variant).toBe("text");
    expect(clamped.artRows).toEqual([]);
    expect(clamped.rows).toBe(0);
  });

  it("hides a blank tip and clamps the tip box to the card's own width", () => {
    expect(heroPlan({ rows: 19, columns: 74, tip: "   " }).showTip).toBe(false);
    const narrow = heroPlan({ rows: 19, columns: 30, tip: "type / for commands" });
    expect(narrow.showTip).toBe(true);
    expect(narrow.tipWidth).toBe(30);
    expect(narrow.tipWidth).toBeLessThanOrEqual(30);
  });

  it("never draws more rows than the card body has, and is never blank", () => {
    for (const rows of [1, 2, 3, 6, 7, 13, 23]) {
      const plan = heroPlan({ rows, columns: 74, tip: "type / for commands" });
      expect(plan.rows, `rows=${rows}`).toBeLessThanOrEqual(rows);
      expect(plan.rows, `rows=${rows}`).toBeGreaterThan(0);
    }
    // One row of room is still the brand, not an empty box — and at 74 columns
    // it is the compact raven head rather than the plain text fallback.
    const single = heroPlan({ rows: 1, columns: 74 });
    expect(single.variant).toBe("compact");
    expect(single.artRows).toHaveLength(1);
    expect(single.copyRows).toEqual([]);
    expect(single.rows).toBe(1);
  });

  it("shows the whole first-run guidance before it spends a row on the tip", () => {
    // 80×24: room for the art and every hint, but not for the tip box.
    const compact = heroPlan({ rows: 13, columns: 74, tip: "type / for commands" });
    expect(compact.copyRows).toHaveLength(EMPTY_CHAT_HINTS.length);
    expect(compact.showTip).toBe(false);

    // A taller card pays for it without losing a hint.
    const roomy = heroPlan({ rows: 19, columns: 74, tip: "type / for commands" });
    expect(roomy.copyRows).toHaveLength(EMPTY_CHAT_HINTS.length);
    expect(roomy.showTip).toBe(true);
    expect(roomy.tipWidth).toBeLessThanOrEqual(74);
  });

  it("renders the brand and the guidance inside the card", async () => {
    const harness = await mountLive(createMockLive(), 80, 36);
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("<(o");
    expect(output).toContain("Huginn the raven is listening");
    expect(output).toContain("/draft");
    expect(output).toContain("/mcp");
    expect(output).toContain("TIP");
    // Narrow terminal: no side panel, exactly as before Phase 7B.
    expect(output).not.toContain(PANEL_TITLE);
    for (const line of output.replace(ANSI, "").split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("falls back to the one-line brand when the card is too narrow for even the compact art", () => {
    expect(heroPlan({ rows: 6, columns: 8 }).variant).toBe("text");
    expect(LiveHero({ rows: 6, columns: 8 })).not.toBeNull();
    expect(HERO_BRAND_TEXT).toBe("HUGINN LIVE");
  });
});

// ── busy raven ───────────────────────────────────────────────────────────────

describe("busy raven (REQ-73)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("opens the raven's beak while a turn is in flight", async () => {
    const live = createMockLive({ chat: vi.fn().mockReturnValue(new Promise(() => {})) });
    const harness = await mountLive(live, 80, 36);
    await run(harness.stdin, "hello");
    await tick(120);
    expect(live.chat).toHaveBeenCalledWith("hello");
    harness.unmount();
    // Busy: the header and the empty-state hero both draw the thinking mood.
    expect(harness.output()).toContain("<(O");
    expect(harness.output()).not.toContain("<(o");
  });
});

// ── the rendered frame ───────────────────────────────────────────────────────

/** The final frame, ANSI-stripped, one entry per terminal row. */
function frameRows(output: string): string[] {
  const rows = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** The header box's painted row range, borders included. */
function headerBox(rows: string[]): { top: number; bottom: number } {
  const top = rows.findIndex((row) => row.includes("╭"));
  expect(top, "header box top border").toBeGreaterThanOrEqual(0);
  const bottom = rows.findIndex((row, index) => index > top && row.includes("╰"));
  expect(bottom, "header box bottom border").toBeGreaterThan(top);
  return { top, bottom };
}

/**
 * ADR-73 — one home per fact.
 *
 * These tests fix the *division*, not the wording: the header is identity and
 * ephemeral state (the live stage and the project path, then the two models),
 * the panel is the environment, and the footer is the keys plus `usage`. A
 * regression that lets the environment back onto row 1 fails here, because the
 * header row would grow a second copy of a fact the panel already reports.
 */
describe("one home per fact (ADR-73)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("keeps the header to the stage badge, the project and the models", async () => {
    const harness = await mountLive(createMockLive(), 140, 40);
    harness.unmount();

    const rows = frameRows(harness.output());
    const { bottom } = headerBox(rows);
    const stageRow = rows[bottom - 2] ?? "";
    const modelRow = rows[bottom - 1] ?? "";

    expect(stageRow).toMatch(/\[[^\]]*REFINE\]/);
    expect(stageRow).toContain(mockCfg.projectPath);
    expect(modelRow).toContain("thinker:");
    expect(modelRow).toContain("executor:");

    // Every environment fact has exactly one surface — the panel. The header
    // must not carry a second copy of any of them.
    for (const [name, row] of [
      ["stage row", stageRow],
      ["models row", modelRow],
    ] as const) {
      expect(row, name).not.toContain("MCP:");
      expect(row, name).not.toContain("runtime:");
      expect(row, name).not.toContain("⎇");
      expect(row, name).not.toContain("sandbox");
      expect(row, name).not.toMatch(/\bctx\b/);
    }
  });

  it("still spends two header context rows, so the header's height does not move", async () => {
    const harness = await mountLive(createMockLive(), 140, 40);
    harness.unmount();

    // The literal the acceptance criteria fixes: the header's height and every
    // budget derived from it (reserved rows, card heights, the decision modal)
    // must not move when values leave the header.
    expect(LIVE_HEADER_CONTEXT_ROWS).toBe(2);

    const rows = frameRows(harness.output());
    const { top, bottom } = headerBox(rows);
    const plan = ravenHeaderPlan({
      columns: 140,
      rows: 40,
      contextRows: LIVE_HEADER_CONTEXT_ROWS,
      reservedRows: VIEWPORT_RESERVED_ROWS_CLOSED,
      outerInset: 2,
    });

    // The painted box is exactly what a two-context-row header costs: the art,
    // the stage row, the models row and the two borders. Dropping the values
    // that left did not drop a row, and nothing new was added in their place.
    expect(plan.contextRows).toBe(2);
    expect(plan.variant).toBe("full");
    expect(bottom - top + 1).toBe(plan.height);
    // The plan and the render agree on how many context rows there are: the
    // interior the frame paints is the art plus the promised context rows.
    expect(bottom - top - 1 - plan.artRows).toBe(LIVE_HEADER_CONTEXT_ROWS);
    // The two context rows are the last two inside the box.
    expect(rows[bottom - 2]).toMatch(/\[[^\]]*REFINE\]/);
    expect(rows[bottom - 1]).toContain("thinker:");
  });

  it("paints the environment nowhere while the panel is hidden", async () => {
    const live = createMockLive();
    const harness = await mountLive(live, SIDE_PANEL_MIN_COLUMNS - 10, 30);
    harness.unmount();

    // Below the panel threshold the environment has no surface at all; the
    // header must not silently take the job back (ADR-73's accepted cost).
    expect(live.getDiagnostics).not.toHaveBeenCalled();
    const output = harness.output();
    expect(output).not.toContain("MCP:");
    expect(output).not.toContain("runtime:");
    expect(output).not.toContain("⎇");
  });

  it("announces a project path too long for row 1 instead of wrapping it", async () => {
    const projectPath = `/${"deeply-nested-segment/".repeat(12)}`;
    const cfg = { ...mockCfg, projectPath, cwd: projectPath } as RunConfig;
    const harness = await mountLive(createMockLive(), 100, 30, cfg);
    harness.unmount();

    const rows = frameRows(harness.output());
    const { top, bottom } = headerBox(rows);
    const stageRow = rows[bottom - 2] ?? "";

    expect(stageRow).toMatch(/\[[^\]]*REFINE\]/);
    // A value that does not fit is clamped in display columns and says so —
    // never a silent crop and never a second painted row.
    expect(stageRow).toContain("…");
    expect(stageRow).not.toContain(projectPath);
    expect(stringWidth(stageRow)).toBeLessThanOrEqual(100);
    expect(bottom - top + 1).toBe(
      ravenHeaderPlan({
        columns: 100,
        rows: 30,
        contextRows: LIVE_HEADER_CONTEXT_ROWS,
        reservedRows: VIEWPORT_RESERVED_ROWS_CLOSED,
        outerInset: 2,
      }).height,
    );
  });

  it("keeps the two header context rows on a terminal too narrow for both models", async () => {
    // 40 columns leaves the models row less than the 16 columns both ids need,
    // so the executor is dropped — not wrapped and not pushed onto a third row.
    const harness = await mountLive(createMockLive(), 40, 24);
    harness.unmount();

    const rows = frameRows(harness.output());
    const { top, bottom } = headerBox(rows);
    const stageRow = rows[bottom - 2] ?? "";
    const modelRow = rows[bottom - 1] ?? "";

    expect(stageRow).toMatch(/\[[^\]]*REFINE\]/);
    expect(modelRow).toContain("thinker:");
    expect(modelRow).not.toContain("executor:");
    // No row may claim a column the terminal does not have, and the header's
    // height is still the stage row plus the models row.
    for (const [index, row] of rows.entries()) {
      expect(stringWidth(row), `row ${index}`).toBeLessThanOrEqual(40);
    }
    expect(bottom - top + 1).toBe(
      ravenHeaderPlan({
        columns: 40,
        rows: 24,
        contextRows: LIVE_HEADER_CONTEXT_ROWS,
        reservedRows: VIEWPORT_RESERVED_ROWS_CLOSED,
        outerInset: 2,
      }).height,
    );
  });

  it("keeps the footer to the keys and the usage figure, never the stage", async () => {
    const harness = await mountLive(createMockLive(), 140, 40);
    try {
      events.emit("usage", {
        total: { inputTokens: 12_400, outputTokens: 3_200, costUsd: 0.42 },
      });
      await tick();
    } finally {
      harness.unmount();
    }

    const rows = frameRows(harness.output());
    const footer = rows[rows.length - 1] ?? "";
    // The keys live on the left, `usage` on the right (H-13), and the stage is
    // the header badge's fact, so it cannot appear in either cell.
    expect(footer).toContain("[Enter] Send");
    expect(footer).toContain("12.4k in / 3.2k out · $0.42");
    expect(footer).not.toContain("stage:");
    expect(footer).not.toContain("REFINE");
  });
});

describe("live frame with the side panel (REQ-12)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("shows the panel with the agent, models, MCP, git, sandbox and Muninn from diagnostics", async () => {
    const harness = await mountLive(createMockLive(), SIDE_PANEL_MIN_COLUMNS, 30);
    harness.unmount();

    const output = harness.output();
    expect(output).toContain(PANEL_TITLE);
    // The stage is the header's badge; the panel no longer repeats it.
    expect(output).toMatch(/\[[^\]]*REFINE\]/);
    expect(output).not.toContain("stage");
    expect(output).toContain("agent");
    expect(output).toContain("thinker");
    expect(output).toContain("executor");
    expect(output).toContain("MCP:");
    // The panel is the only home of the working-tree state: the branch is
    // clamped to its value column, but the `dirty` fact always survives.
    expect(output).toContain("feature/live");
    expect(output).toContain("dirty");
    expect(output).toContain("sandbox");
    expect(output).toContain("42 entities");
    expect(output).toContain("137 obs");
    // The tip has a home in the panel on a terminal this size.
    expect(output).toContain("TIP");
  });

  it("paints the mapped healthy badge, not the engine's pictographs (REQ-76)", async () => {
    const live = createMockLive({
      runtime: {
        name: "pi",
        id: "pi",
        capabilities: { streaming: false, systemPrompts: true, tools: true },
        getMcpStatus: async () => ({
          servers: [
            { id: "pi:pi", name: "pi", status: "connected", transport: "stdio", toolsCount: 3 },
            { id: "pi:muninn", name: "muninn", status: "connected", transport: "stdio", toolsCount: 0 },
          ],
          totalTools: 0,
          healthy: true,
        }),
      } as unknown as LiveEngine["runtime"],
    });
    const harness = await mountLive(live, SIDE_PANEL_MIN_COLUMNS, 30);
    harness.unmount();

    const output = harness.output();
    // The exact wording REQ-76 promises for a healthy report, in both surfaces.
    expect(output).toContain("MCP: ✓ 2 connected · pi");
    expect(output).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("hides the panel below the threshold and keeps the old layout", async () => {
    const harness = await mountLive(createMockLive(), SIDE_PANEL_MIN_COLUMNS - 1, 30);
    harness.unmount();

    const output = harness.output();
    expect(output).not.toContain(PANEL_TITLE);
    expect(output).toContain("Conversation");
    expect(output).toMatch(/\[[^\]]*REFINE\]/);
    expect(output).not.toContain("stage:");
  });

  it("never probes diagnostics on a terminal too narrow for the panel", async () => {
    const live = createMockLive();
    const harness = await mountLive(live, 80, 30);
    harness.unmount();

    expect(live.getDiagnostics).not.toHaveBeenCalled();
  });

  it("shares one diagnostics probe between the panel and /status (REQ-12)", async () => {
    const live = createMockLive();
    const harness = await mountLive(live, 120, 40);
    await run(harness.stdin, "/status");
    harness.unmount();

    // One probe serves the panel and the command: the panel's `git status` is not
    // paid for twice just because the user asked for the same numbers.
    expect(live.getDiagnostics).toHaveBeenCalledTimes(1);
    expect(harness.output()).toContain("System Diagnostics");
  });

  it("renders the branch, its dirtiness and the sandbox in the panel only", async () => {
    const harness = await mountLive(createMockLive(), 140, 40);
    harness.unmount();

    const output = harness.output();
    expect(output).toContain(PANEL_TITLE);
    const plain = output.replace(ANSI, "");
    // One home per fact (ADR-73): the environment lives in the panel, so the
    // branch appears exactly once and never on the header's models row. The
    // value column clamps the branch, but the dirty state keeps its columns.
    expect(plain.split("⎇ feature/live").length - 1).toBe(1);
    expect(plain).toContain("dirty");
    expect(plain).toContain("sandbox");
    const modelRow = plain.split("\n").find((line) => line.includes("thinker:"));
    expect(modelRow).toBeDefined();
    expect(modelRow).not.toContain("⎇");
  });

  it("counts the conversation in the panel only, and omits an empty one", async () => {
    // The panel is the environment's one home, so the counter there is the only
    // one — the header's second row carries the models and nothing else.
    const compact = createMockLive({
      getDiagnostics: vi.fn().mockResolvedValue({
        ...diagnostics,
        gitBranch: "main",
        gitClean: true,
        worktreeSandbox: false,
      }),
      getTranscript: vi.fn().mockReturnValue([
        { role: "user", text: "add a notifications module" },
        { role: "assistant", text: "Scope captured." },
      ]),
    });
    const harness = await mountLive(compact, 120, 40);
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("2 turns · 41 chars");
    expect(output).not.toContain("ctx 2 turns");
    const plain = output.replace(ANSI, "");
    expect(plain.split("2 turns").length - 1).toBe(1);

    // An empty conversation reports no context size at all (NFR-10).
    const empty = await mountLive(createMockLive(), 120, 40);
    empty.unmount();
    expect(empty.output()).not.toContain("ctx 0 turns");
    expect(empty.output()).not.toContain("0 turns");
  });

  it("spends the columns the header freed on the project path (100x30)", async () => {
    const projectPath = "/home/dev/workspaces/huginn-project-with-a-very-long-name-for-layout";
    const cfg = { ...mockCfg, projectPath, cwd: projectPath } as RunConfig;
    const harness = await mountLive(createMockLive(), 100, 30, cfg);
    harness.unmount();

    const output = harness.output();
    // Row 1 no longer pays for the MCP badge or the runtime name, so a path that
    // used to be clamped is painted whole — and nothing else claims its row.
    expect(projectPath.length).toBeGreaterThan(60);
    expect(output).toContain(projectPath);
    expect(output).not.toContain("runtime:");
    const stageRow = output.replace(ANSI, "").split("\n").find((line) => line.includes("REFINE"));
    expect(stageRow).toBeDefined();
    expect(stageRow).toContain(projectPath);
    expect(stageRow!.length).toBeLessThanOrEqual(100);
  });

  it("wraps a long paragraph one terminal row at a time (REV-6201)", async () => {
    // Ink's own `wrap` lets a text node claim one row while it paints several,
    // over the siblings below (and over the card's bottom border). The console
    // pre-wraps, so the frame has to stay intact with a paragraph longer than
    // the card is wide.
    const paragraph =
      "El correo se guarda unicamente en el navegador de quien se apunta y la lista crece local: " +
      "un wrapper de almacenamiento centraliza el acceso, valida los datos y maneja los errores, " +
      "pero no vuelve seguro un almacenamiento que no lo es. La landing explicara esa limitacion.";
    const transcript = Array.from({ length: 10 }, (_, index) => [
      { role: "user" as const, text: `pregunta ${index} sobre el alcance de la landing` },
      { role: "assistant" as const, text: paragraph },
    ]).flat();
    const harness = await mountLive(createMockLive({ getTranscript: vi.fn().mockReturnValue(transcript) }), 120, 40);
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("La landing explicara esa limitacion.");
    const lines = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
    const start = lines.findIndex((line) => line.includes("Conversation"));
    expect(start).toBeGreaterThanOrEqual(0);
    const bottom = lines.findIndex((line, index) => index > start && line.trimStart().startsWith("╰"));
    expect(bottom).toBeGreaterThan(start);
    // The conversation card's bottom border must be pure border: a wrapped row
    // painted over it is exactly the corruption this guards against.
    const trimmed = lines[bottom]!.trimStart();
    expect(trimmed.slice(0, trimmed.indexOf("╯") + 1)).toMatch(/^╰─+╯$/);
  }, 30000);

  it("keeps only the log tail a 30-row frame can pay for (REQ-70)", async () => {
    const harness = await mountLive(createMockLive(), 80, 30);
    for (let index = 0; index < 5; index += 1) {
      events.emit("log", { level: "info", message: `log-entry-${index}` });
    }
    await tick(120);
    harness.unmount();

    const output = harness.output();
    const logRows = visibleLines(output).filter((line) => line.includes("log-entry-"));
    // 30 rows allow three entries; the tertiary card spends one title row, not
    // the old two-border rows, so the tail is exactly title + 3.
    expect(logRows).toHaveLength(3);
    expect(output).toContain("SYSTEM LOGS");
    expect(output).toContain("log-entry-4");
    expect(output).not.toContain("log-entry-0");
    expect(output).not.toContain("log-entry-1");
  });

  it("keeps the chat, the stream, the panel, the composer and the footer inside the terminal", async () => {
    for (const [columns, rows] of [
      [80, 24],
      [99, 30],
      [100, 24],
      [100, 30],
      [120, 40],
      [140, 40],
    ] as const) {
      const harness = await mountLive(createMockLive(), columns, rows);
      events.emit("phaseStream", { text: "reasoning…" } as never);
      await tick(140);
      harness.unmount();

      const output = harness.output();
      const where = `${columns}x${rows}`;
      expect(output, where).toContain("Conversation");
      expect(output, where).toContain("THINKING & LIVE AGENT STREAM");
      expect(output, where).toContain("❯");
      expect(output, where).toMatch(/\[[^\]]*REFINE\]/);
      expect(output, where).not.toContain("stage:");
      // The panel appears exactly from the threshold up.
      expect(output.includes(PANEL_TITLE), where).toBe(columns >= SIDE_PANEL_MIN_COLUMNS);
      expect(visibleLines(output).length, where).toBeLessThanOrEqual(rows);
      for (const line of output.replace(ANSI, "").split("\n")) {
        expect(line.length, `${where}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
      }
    }
  }, 30000);
});

// ── a pending decision cannot eat the frame (REQ-69) ────────────────────────

describe("live frame under the decision modal (REQ-69)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  /** The tall case: three described options and two follow-up questions. */
  const tallDecision: DecisionRequest = {
    id: "d-24",
    kind: "question",
    iteration: 0,
    phase: "LIVE",
    attempt: 1,
    message: "Which database should I use?",
    questionItems: [
      {
        question: "Which database should I use?",
        options: [
          { label: "Postgres", description: "production-ready" },
          { label: "SQLite", description: "zero-config" },
          { label: "DuckDB", description: "analytics-first" },
        ],
      },
      { question: "Which migration tool?", options: [{ label: "Prisma" }, { label: "Drizzle" }] },
      { question: "Where do backups go?", options: [{ label: "S3" }, { label: "Local" }] },
    ],
  };

  it("keeps the composer and the footer inside a 24-row terminal", async () => {
    const harness = await mountLive(createMockLive(), 80, 24);
    events.emit("decision", tallDecision);
    await tick(140);
    harness.unmount();

    const output = harness.output();
    expect(visibleLines(output).length, "the frame never exceeds 24 rows").toBeLessThanOrEqual(24);
    // The composer and the footer are the parts that must never disappear
    // beneath the modal, whatever the body does.
    // The composer is disabled under a decision, so it shows its dot prompt —
    // but it and the footer are still inside the frame, not under the modal.
    expect(output).toContain("Message...");
    expect(output).toContain("[Tab] Focus:");
    expect(output).toMatch(/\[[^\]]*REFINE\]/);
    expect(output).not.toContain("stage:");
    // The modal is there, with its alert border and a windowed body.
    expect(output).toContain(decisionTitle(tallDecision));
    expect(output).toContain("╔");
    expect(output).toContain("… +");
    expect(output).toContain("[1-9/Enter]");
    for (const line of output.replace(ANSI, "").split("\n")) {
      expect(line.length, JSON.stringify(line)).toBeLessThanOrEqual(80);
    }
  });

  it("keeps the composer and the footer on an 18-row terminal too", async () => {
    const harness = await mountLive(createMockLive(), 80, 18);
    events.emit("decision", tallDecision);
    await tick(140);
    harness.unmount();

    const output = harness.output();
    expect(visibleLines(output).length, "the frame never exceeds 18 rows").toBeLessThanOrEqual(18);
    expect(output).toContain("Message...");
    expect(output).toContain("[Tab] Focus:");
    expect(output).toContain(decisionTitle(tallDecision));
  });

  it("gives ↑/↓ to the windowed modal instead of answering or echoing the question", async () => {
    const live = createMockLive();
    const harness = await mountLive(live, 80, 24);
    events.emit("decision", tallDecision);
    await tick(140);
    // Scroll keys belong to the modal's window: they must not resolve the
    // decision, and they must not be re-read as "press a number".
    harness.stdin.write("\u001B[B");
    await tick(60);
    harness.stdin.write("\u001B[A");
    await tick(80);
    harness.unmount();

    const output = harness.output();
    expect(live.resolveDecision).not.toHaveBeenCalled();
    expect(output).not.toContain("Press 1-");
    // The frame is still intact after the scroll keys.
    expect(output).toContain(decisionTitle(tallDecision));
    expect(output).toContain("[1-9/Enter]");
  });

  it("still answers the first question by number after the body scrolled", async () => {
    const live = createMockLive();
    const harness = await mountLive(live, 80, 24);
    events.emit("decision", tallDecision);
    await tick(140);
    // Walk the window to its tail, then answer with a number: the keys belong
    // to the first question even when its options are above the visible window.
    for (let index = 0; index < 4; index += 1) {
      harness.stdin.write("\u001B[B");
      await tick(30);
    }
    harness.stdin.write("2");
    await tick(100);
    harness.unmount();

    expect(live.resolveDecision).toHaveBeenCalledWith("continue", ["SQLite"]);
  });
});
