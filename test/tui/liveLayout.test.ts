import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { events } from "../../src/engine/engineEvents";
import type { DiagnosticsInfo, LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";
import { LiveApp } from "../../src/tui/LiveDashboard";
import {
  PANEL_LABEL_COLUMNS,
  PANEL_TITLE,
  PANEL_TIP_PREFIX,
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
  const instance = render(React.createElement(LiveApp, { live, cfg: mockCfg }), {
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
  stageLabel: "REFINE",
  stageToken: "accent",
  busy: true,
  spinner: "⠋",
  agentName: "opencode",
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "opencode/gpt-5.1-codex",
  mcpText: "MCP: 🟢 2 connected · opencode",
  mcpToken: "ok",
  git: { branch: "feature/parser", clean: false, sandbox: true },
  memory: { entitiesCount: 42, observationsCount: 137 },
  context: { turns: 3, chars: 1_450 },
  tip: "type / for commands",
};

/** The visible text of a line — what the row actually draws. */
function lineText(line: PanelLine): string {
  if (line.kind === "row") return `${line.label.padEnd(PANEL_LABEL_COLUMNS)}${line.value}`;
  if (line.kind === "note") return `${PANEL_TIP_PREFIX}${line.text}`;
  if (line.kind === "badge") return line.text;
  if (line.kind === "title") return line.text;
  return "─".repeat(30);
}

describe("panel lines (REQ-12)", () => {
  const contentWidth = SIDE_PANEL_WIDTH - 4;

  it("renders every section the session really has, in priority order", () => {
    const lines = panelLines(panelData, contentWidth);
    const labels = lines.filter((line) => line.kind === "row").map((line) => line.label);
    expect(lines[0]).toEqual({ kind: "title", text: PANEL_TITLE });
    expect(labels).toContain("stage");
    expect(labels).toContain("agent");
    expect(labels).toContain("thinker");
    expect(labels).toContain("executor");
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
        mcpText: "MCP: 🟡 error — " + "x".repeat(80) + " · opencode",
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

  it("renders nothing at all when the plan says the panel is hidden", () => {
    const plan = sidePanelPlan({ columns: 80, availableHeight: 30, inset: 2 });
    expect(InfoPanel({ plan, data: panelData })).toBeNull();
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
    expect(heroPlan({ rows: 20, columns: 30 }).variant).toBe("text");
    // The wordmark-only variant drops the mark column entirely.
    expect(heroPlan({ rows: 20, columns: 50 }).artRows.every((row) => row.mark === "")).toBe(true);
    expect(heroPlan({ rows: 20, columns: 74 }).artRows.some((row) => row.mark.includes("<(o"))).toBe(
      true,
    );
  });

  it("never draws more rows than the card body has, and is never blank", () => {
    for (const rows of [1, 2, 3, 6, 7, 13, 23]) {
      const plan = heroPlan({ rows, columns: 74, tip: "type / for commands" });
      expect(plan.rows, `rows=${rows}`).toBeLessThanOrEqual(rows);
      expect(plan.rows, `rows=${rows}`).toBeGreaterThan(0);
    }
    // One row of room is still the brand, not an empty box.
    const single = heroPlan({ rows: 1, columns: 74 });
    expect(single.variant).toBe("text");
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

  it("falls back to the one-line brand when the card is too narrow for art", () => {
    expect(heroPlan({ rows: 6, columns: 20 }).variant).toBe("text");
    expect(LiveHero({ rows: 6, columns: 20 })).not.toBeNull();
    expect(HERO_BRAND_TEXT).toBe("HUGINN LIVE");
  });
});

// ── the rendered frame ───────────────────────────────────────────────────────

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
    expect(output).toContain("stage");
    expect(output).toContain("REFINE");
    expect(output).toContain("agent");
    expect(output).toContain("thinker");
    expect(output).toContain("executor");
    expect(output).toContain("MCP:");
    expect(output).toContain("feature/live-layout");
    expect(output).toContain("dirty");
    expect(output).toContain("sandbox");
    expect(output).toContain("42 entities");
    expect(output).toContain("137 obs");
    // The tip has a home in the panel on a terminal this size.
    expect(output).toContain("TIP");
  });

  it("hides the panel below the threshold and keeps the old layout", async () => {
    const harness = await mountLive(createMockLive(), SIDE_PANEL_MIN_COLUMNS - 1, 30);
    harness.unmount();

    const output = harness.output();
    expect(output).not.toContain(PANEL_TITLE);
    expect(output).toContain("Conversation");
    expect(output).toContain("stage: REFINE");
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

  it("renders the branch, its dirtiness and the sandbox in the header too", async () => {
    const harness = await mountLive(createMockLive(), 140, 40);
    harness.unmount();

    const output = harness.output();
    // The header's own status cell: git state on the right of the models row.
    expect(output).toMatch(/thinker:.*executor:.*⎇/);
    expect(output).toContain("⎇ feature/live-layout");
    expect(output).toContain("dirty");
    expect(output).toContain("sandbox");
  });

  it("counts the conversation in the header and the panel, and omits an empty one", async () => {
    // A compact git status leaves the header's own status cell room for the
    // counter; the panel always carries it on its own row.
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
    expect(output).toContain("⎇ main · clean · ctx 2 turns");
    // The panel carries the same count on a row of its own.
    expect(output).toContain("2 turns · 41 chars");

    // An empty conversation reports no context size at all (NFR-10).
    const empty = await mountLive(createMockLive(), 120, 40);
    empty.unmount();
    expect(empty.output()).not.toContain("ctx 0 turns");
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
      expect(output, where).toContain("stage: REFINE");
      // The panel appears exactly from the threshold up.
      expect(output.includes(PANEL_TITLE), where).toBe(columns >= SIDE_PANEL_MIN_COLUMNS);
      expect(visibleLines(output).length, where).toBeLessThanOrEqual(rows);
      for (const line of output.replace(ANSI, "").split("\n")) {
        expect(line.length, `${where}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
      }
    }
  }, 30000);
});
