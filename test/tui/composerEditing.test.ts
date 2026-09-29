/**
 * Phase 6 / REQ-6 — the live composer as a real editor.
 *
 * These mount the real `LiveApp` and drive it with the escape sequences a
 * terminal sends, so they check the wiring the pure model tests cannot: the
 * caret key bindings, the multi-line growth, the internal scroll and the fact
 * that no rendered line ever exceeds the terminal.
 *
 * In this non-TTY harness Ink flushes the *final* frame on unmount, which is why
 * every assertion reads the output after `unmount()`.
 */
import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { LiveApp } from "../../src/tui/LiveDashboard";
import { CURSOR_GLYPH, MAX_INPUT_ROWS } from "../../src/tui/composer";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";

type MockStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: () => MockStdin;
  ref: () => MockStdin;
  unref: () => MockStdin;
};

function createMockStdin(): MockStdin {
  const stdin = new PassThrough() as MockStdin;
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

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "anthropic/claude-3-7-sonnet",
  cwd: "/mock/project",
} as unknown as RunConfig;

function createMockLive(overrides?: Partial<LiveEngine>): LiveEngine {
  return {
    cfg: mockCfg,
    runtime: { name: "MockRuntime", id: "opencode" },
    models: { thinker: "a/b", executor: "a/b" },
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
    getDiagnostics: vi.fn().mockResolvedValue({
      gitBranch: "main",
      gitClean: true,
      worktreeSandbox: false,
      runtimeName: "MockRuntime",
      thinkerModel: "a/b",
      executorModel: "a/b",
      memoryStats: { entitiesCount: 0, observationsCount: 0 },
    }),
    ...overrides,
  } as unknown as LiveEngine;
}

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LEFT = "\u001B[D";
const RIGHT = "\u001B[C";
const UP = "\u001B[A";
const DOWN = "\u001B[B";
const HOME = "\u001B[H";
const END = "\u001B[F";
const DELETE = "\u001B[3~";
const BACKSPACE = "\u007F";
/** Ctrl/⌥ chords: xterm sends `;5` for Ctrl, kitty sends the CSI-u form. */
const CTRL_LEFT = "\u001B[1;5D";
const CTRL_BACKSPACE = "\u001B[127;5u";
const CTRL_DELETE = "\u001B[3;5~";

interface Harness {
  stdin: MockStdin;
  /** Type characters one key at a time, as a terminal would. */
  type: (text: string) => Promise<void>;
  /** Insert a whole block at once (Ink delivers it as a single paste event). */
  bulk: (text: string) => Promise<void>;
  /** Press a raw key sequence (arrow, Home/End/Delete…). */
  press: (sequence: string, delay?: number) => Promise<void>;
  /** What Ink wrote. Only meaningful after `unmount()`. */
  output: () => string;
  unmount: () => void;
}

async function mountLive(rows: number, columns: number, live = createMockLive()): Promise<Harness> {
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
    type: async (text: string) => {
      for (const char of text) {
        stdin.write(char);
        await tick(10);
      }
      await tick();
    },
    bulk: async (text: string) => {
      stdin.write(text);
      await tick(40);
    },
    press: async (sequence: string, delay = 40) => {
      stdin.write(sequence);
      await tick(delay);
    },
    output: () => output,
    unmount: () => {
      instance.unmount();
      restore();
    },
  };
}

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** Visible lines of the last rendered frame, trailing blanks dropped. */
function visibleLines(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Lines of the frame that start a box (`╭`) or close one (`╰`). */
function boxEdges(lines: string[]): { opened: number; closed: number; deformed: string[] } {
  const edges = lines.filter((line) => /^[╭╰]/.test(line.trimStart()));
  return {
    opened: edges.filter((line) => line.trimStart().startsWith("╭")).length,
    closed: edges.filter((line) => line.trimStart().startsWith("╰")).length,
    // A squeezed box leaks its content into its own border, or loses it.
    deformed: edges.filter((line) => /[^╭╮╰╯─\s]/.test(line.trimStart())),
  };
}

/**
 * The composer's *content* rows in the final frame — from the prompt row down to
 * the box's bottom border — so the tests can count exactly how tall it grew.
 */
function composerContentRows(output: string): string[] {
  const lines = visibleLines(output);
  // The `❯ ` prompt is unique to the composer (the header's `· ` badge is not).
  const start = lines.findIndex((line) => line.includes("❯ "));
  if (start === -1) return [];
  const rows: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.includes("╰") || !line.includes("│")) break;
    rows.push(line);
  }
  return rows;
}

describe("Composer caret & in-place editing (REQ-6)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("moves the caret left and inserts in place, not at the end", async () => {
    const h = await mountLive(40, 100);
    await h.type("ac");
    await h.press(LEFT);
    await h.type("b");
    h.unmount();

    expect(h.output()).toContain(`❯ ab${CURSOR_GLYPH}c`);
  });

  it("moves the caret right and to the start of the line", async () => {
    const h = await mountLive(40, 100);
    await h.type("ac");
    await h.press(LEFT);
    await h.press(LEFT); // now at index 0
    await h.type("X");
    h.unmount();

    expect(h.output()).toContain(`❯ X${CURSOR_GLYPH}ac`);
  });

  it("jumps to the ends with Home and End", async () => {
    const h = await mountLive(40, 100);
    await h.type("abc");
    await h.press(HOME);
    await h.type("X");
    await h.press(END);
    await h.type("!");
    h.unmount();

    expect(h.output()).toContain(`❯ Xabc!${CURSOR_GLYPH}`);
  });

  it("deletes the character at the caret with Delete", async () => {
    const h = await mountLive(40, 100);
    await h.type("abc");
    await h.press(HOME);
    await h.press(DELETE);
    h.unmount();

    expect(h.output()).toContain(`❯ ${CURSOR_GLYPH}bc`);
  });

  it("backspaces the character before the caret", async () => {
    const h = await mountLive(40, 100);
    await h.type("abc");
    await h.press(LEFT); // caret between b and c
    await h.press(BACKSPACE);
    h.unmount();

    expect(h.output()).toContain(`❯ a${CURSOR_GLYPH}c`);
  });

  it("soft-wraps onto a second row and keeps the caret at the edge (REQ-6)", async () => {
    const columns = 100;
    // textWidth = columns - inset(8) - no history hint = 92.
    const width = 92;
    const h = await mountLive(40, columns);
    await h.bulk("a".repeat(width));
    await h.bulk("b".repeat(8));
    h.unmount();

    const output = h.output();
    const rows = visibleLines(output);
    const first = rows.findIndex((line) => line.includes("a".repeat(width)));
    expect(first, "the first wrapped row is on screen").toBeGreaterThanOrEqual(0);
    // The border row + the segment proves it wrapped instead of truncating.
    expect(rows[first]).not.toContain("b");
    expect(rows[first + 1]).toContain(`b${"b".repeat(7)}${CURSOR_GLYPH}`);
    // Two content rows: the box grew with the draft.
    expect(composerContentRows(output).length).toBe(2);
    for (const line of rows) expect(line.length).toBeLessThanOrEqual(columns);
    expect(rows.length).toBeLessThanOrEqual(40);
  });

  it("grows to MAX_INPUT_ROWS and then scrolls internally (REQ-6)", async () => {
    const columns = 100;
    const width = 92;
    const h = await mountLive(40, columns);
    // Eight full rows of distinct characters: MAX_INPUT_ROWS(6) cannot show them
    // all, so the earliest must scroll off while the latest stays visible.
    for (const char of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      await h.bulk(char.repeat(width));
    }
    h.unmount();

    const output = h.output();
    const rows = visibleLines(output);
    // The caret's own row (the last one) is on screen…
    expect(output).toContain("h".repeat(width));
    // …and the rows above the window scrolled away.
    expect(output).not.toContain("a".repeat(width));
    expect(output).not.toContain("b".repeat(width));
    expect(output).not.toContain("c".repeat(width));
    // The composer grew to — but never past — its cap of content rows.
    expect(composerContentRows(output).length).toBe(MAX_INPUT_ROWS);
    expect(rows.length).toBeLessThanOrEqual(40);
    for (const line of rows) expect(line.length).toBeLessThanOrEqual(columns);
  });

  it("moves the caret between visual rows with ↑ on a wrapped draft (REQ-6)", async () => {
    const h = await mountLive(40, 100);
    await h.bulk("a".repeat(92)); // fills row 0 exactly
    await h.bulk("bc"); // wraps onto row 1
    await h.press(UP); // caret back up to row 0, same column
    await h.type("Z");
    h.unmount();

    // The "Z" landed at the start of the first row — proof the caret moved up.
    expect(h.output()).toContain("❯ aa" + "Z");
  });

  it("recalls the last submission with ↑ while the draft is empty (REQ-34)", async () => {
    const h = await mountLive(40, 120);
    await h.type("old prompt");
    await h.press("\r", 80);

    await h.press(UP);
    h.unmount();

    expect(h.output()).toContain(`❯ old prompt${CURSOR_GLYPH}`);
  });

  it("moves the caret on a wrapped draft instead of recalling history (REQ-6)", async () => {
    const h = await mountLive(40, 120);
    // A submission exists, but the draft is not empty, so ↑ must edit the caret.
    await h.type("old prompt");
    await h.press("\r", 80);
    await h.bulk("x".repeat(110)); // wraps over two rows
    await h.press(UP);
    await h.type("Z");
    h.unmount();

    const output = h.output();
    expect(output).toContain("❯ xxxxxxxx" + "Z");
    expect(output).not.toContain(`❯ old prompt${CURSOR_GLYPH}`);
  });

  it("never renders a line wider than the terminal, at any size (REQ-6)", async () => {
    for (const [columns, rows] of [
      [80, 24],
      [100, 30],
      [120, 40],
    ] as const) {
      const h = await mountLive(rows, columns);
      await h.bulk("w".repeat(columns * 2)); // a draft several rows long
      await h.press(LEFT);
      await h.press(HOME);
      await h.type("q");
      h.unmount();

      const output = h.output();
      for (const line of output.replace(ANSI, "").split("\n")) {
        expect(line.length, `${columns}x${rows}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
      }
      expect(visibleLines(output).length, `${columns}x${rows}`).toBeLessThanOrEqual(rows);
    }
  }, 20000);

  it("keeps the composer and the footer on screen on a short terminal (REV-6001)", async () => {
    for (const [columns, rows] of [
      [80, 20],
      [80, 22],
    ] as const) {
      const where = `${columns}x${rows}`;
      const h = await mountLive(rows, columns);
      // The log tail is part of the frame too, and it has to be paid for before
      // the composer may grow — the short-terminal bug (REV-6001).
      events.emit("log", { level: "info", message: "something happened" });
      await tick(80);
      // Six visual rows of draft: more than a short terminal can afford.
      await h.bulk("x".repeat((columns - 8) * 6));
      await tick(80);
      h.unmount();

      const output = h.output();
      const lines = visibleLines(output);

      // Nothing spills over the terminal …
      expect(lines.length, where).toBeLessThanOrEqual(rows);
      for (const line of output.replace(ANSI, "").split("\n")) {
        expect(line.length, `${where}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
      }
      // … the composer and the footer are the rows that survive …
      expect(output, where).toContain("❯ ");
      expect(output, where).toContain("stage: REFINE");
      // … and the frame is not just *shorter*: every box is intact, with its
      // content inside it, instead of being squeezed until it bleeds into its
      // own border (which is what the composer used to do).
      const edges = boxEdges(lines);
      expect(edges.deformed, where).toEqual([]);
      expect(edges.opened, where).toBe(edges.closed);
    }
  }, 20000);

  it("keeps the character the caret sits on when its row is full (REV-6002)", async () => {
    const columns = 100;
    const width = columns - 8;
    const h = await mountLive(40, columns);
    await h.bulk("a".repeat(width - 1) + "b"); // row 0 exactly full
    await h.bulk("c"); // wraps onto row 1
    await h.press(LEFT); // caret back to the start of row 1
    await h.press(LEFT); // caret at col width-1 of the *full* row 0
    h.unmount();

    const flat = h.output().replace(ANSI, "");
    const row = visibleLines(h.output()).find((line) => line.includes("❯ "))!;
    // The caret cell is the last character: it is painted over, never dropped.
    expect(flat).toContain(`❯ ${"a".repeat(width - 1)}b`);
    expect(row.length).toBeLessThanOrEqual(columns);
  });

  it("moves Home to the start of the caret's visual row (REV-6004)", async () => {
    const columns = 100;
    const width = columns - 8;
    const h = await mountLive(40, columns);
    await h.bulk("a".repeat(width));
    await h.bulk("bc"); // caret at the end of row 1
    await h.press(HOME); // start of row 1 (index width), not of the draft
    await h.type("X");
    h.unmount();

    const flat = h.output().replace(ANSI, "");
    expect(flat).toContain(`  X${CURSOR_GLYPH}bc`);
    // Row 0 is untouched — Home did not jump to the start of the draft.
    expect(flat).toContain(`❯ ${"a".repeat(width)}`);
  });

  it("moves End to the end of the caret's visual row (REV-6004)", async () => {
    const columns = 100;
    const width = columns - 8;
    const h = await mountLive(40, columns);
    await h.bulk("a".repeat(width));
    await h.bulk("bc"); // caret at the end of row 1
    await h.press(UP); // caret back onto row 0
    await h.press(END); // end of row 0 (index width), not of the draft
    await h.type("Z");
    h.unmount();

    const flat = h.output().replace(ANSI, "");
    expect(flat).toContain(`  Z${CURSOR_GLYPH}bc`);
  });

  it("deletes a word with Ctrl+Backspace (REV-6006)", async () => {
    const h = await mountLive(40, 100);
    await h.type("alpha beta gamma");
    await h.press(CTRL_BACKSPACE);
    h.unmount();

    // A whole word, never one character: "gamm" would be the single-char edit.
    expect(h.output()).toContain(`❯ alpha beta ${CURSOR_GLYPH}`);
  });

  it("deletes a word with Ctrl+Delete and keeps Ctrl+← a word jump (REV-6006)", async () => {
    const h = await mountLive(40, 100);
    await h.type("alpha beta gamma");
    await h.press(CTRL_LEFT); // word jump to the start of "gamma"
    await h.press(CTRL_DELETE); // delete forward, word by word
    h.unmount();

    const output = h.output();
    expect(output).toContain(`❯ alpha beta ${CURSOR_GLYPH}`);
    // Had either chord been swallowed, "gamma" would still be in the draft.
    expect(output).not.toContain("gamma");
  });
});
