/**
 * Phase tables in the live chat (iteration 7, REQ-H-06).
 *
 * A markdown table only aligns if the whole contiguous block is formatted
 * together: `RefineView` used to hand one line at a time to `wrapSegments`, so a
 * report's table reached the user as raw pipes. This mounts the real `LiveApp`
 * with a transcript that contains a table and checks what Ink actually painted:
 * one terminal row per source row, the same separator column on every row, and
 * no markdown syntax left behind.
 */
import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import { render } from "./inkRender";
import { LiveApp } from "../../src/tui/LiveDashboard";
import type { LiveEngine, TranscriptTurn } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

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

function stubTerminalSize(rows: number, columns: number): () => void {
  const originalRows = process.stdout.rows;
  const originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true, writable: true });
  Object.defineProperty(process.stdout, "columns", {
    value: columns,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(process.stdout, "rows", {
      value: originalRows,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  };
}

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "anthropic/claude-3-7-sonnet",
  cwd: "/mock/project",
} as unknown as RunConfig;

const tick = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeLive(transcript: TranscriptTurn[]): LiveEngine {
  return {
    cfg: mockCfg,
    runtime: {
      name: "MockRuntime",
      id: "opencode",
      capabilities: { streaming: true, systemPrompts: true, tools: true },
    },
    models: { thinker: mockCfg.thinker, executor: mockCfg.executor },
    currentStage: "refine",
    ideaText: "",
    getTranscript: () => transcript.map((turn) => ({ ...turn })),
    clearTranscript: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn().mockResolvedValue(undefined),
    draft: vi.fn().mockResolvedValue("approved"),
    execute: vi.fn(),
    ask: vi.fn().mockResolvedValue("retry"),
    requestAbort: vi.fn(),
    resolveDecision: vi.fn(),
    updateModels: vi.fn(),
    switchRuntime: vi.fn(),
    getDiagnostics: vi.fn().mockResolvedValue({
      gitBranch: "main",
      gitClean: true,
      worktreeSandbox: false,
      runtimeName: "MockRuntime",
      thinkerModel: mockCfg.thinker,
      executorModel: mockCfg.executor,
      memoryStats: { entitiesCount: 0, observationsCount: 0 },
    }),
  } as unknown as LiveEngine;
}

/** Renders the live view at a pinned size and returns the painted rows. */
async function paint(live: LiveEngine, columns = 120, rows = 40): Promise<string[]> {
  const restore = stubTerminalSize(rows, columns);
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const instance = render(React.createElement(LiveApp, { live, cfg: mockCfg }), {
    stdout,
    stdin: createMockStdin(),
    patchConsole: false,
  });
  await tick();
  instance.unmount();
  restore();
  return output
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
}

/** The `│` that separates two cells: it has content, not padding, on its left. */
function cellSeparatorColumn(line: string): number {
  const match = /[^\s│]\s*│/.exec(line);
  if (match === null) return -1;
  const at = match.index + match[0].length - 1;
  return stringWidth(line.slice(0, at));
}

/** Table rows have a cell separator with content on both sides; card borders do not. */
function isCellRow(line: string): boolean {
  return /[^\s│]\s*│\s*[^\s│]/.test(line);
}

const TABLE_MESSAGE = [
  "Reporte de la iteración:",
  "| Fase | Resultado |",
  "| --- | --- |",
  "| EXECUTE | ok |",
  "| VALIDATE_STEP | a cell with a very long value that will never fit the conversation card |",
].join("\n");

describe("live chat renders contiguous tables (RefineView)", () => {
  it("paints one aligned row per table row instead of raw pipes", async () => {
    const live = createFakeLive([{ role: "assistant", text: TABLE_MESSAGE }]);
    const lines = await paint(live);
    const tableRows = lines.filter(isCellRow);

    expect(tableRows).toHaveLength(4);
    // The markdown source is gone: no `|---|` separator and no `[text](url)`.
    expect(lines.some((line) => line.includes("| ---"))).toBe(false);
    expect(lines.some((line) => line.includes("|---|"))).toBe(false);
    // Every row agrees on the column the cells meet at.
    const columns = tableRows.map(cellSeparatorColumn);
    expect(new Set(columns).size).toBe(1);
    expect(columns[0]).toBeGreaterThan(0);
    // The header, the drawn separator and the truncated cell are all present.
    expect(tableRows[0]).toContain("Fase");
    expect(tableRows[1]).toContain("─");
    expect(tableRows[3]).toContain("…");
  });

  it("keeps every table row inside the conversation card's column budget", async () => {
    const live = createFakeLive([{ role: "assistant", text: TABLE_MESSAGE }]);
    const lines = await paint(live);
    const tableRows = lines.filter(isCellRow);
    const chatTop = lines.findIndex((line) => line.includes("Conversation"));
    expect(chatTop).toBeGreaterThan(0);
    // The conversation card's top border sets its width; a row that overflowed
    // would either wrap or paint over the side border.
    const cardWidth = stringWidth(lines[chatTop - 1]!.trimEnd());
    expect(cardWidth).toBeGreaterThan(40);
    for (const row of tableRows) {
      expect(stringWidth(row.trimEnd())).toBeLessThanOrEqual(cardWidth);
    }
    // The card still closes after the table: chrome was not pushed off-frame.
    const firstTableRow = lines.indexOf(tableRows[0]!);
    const closing = lines.findIndex(
      (line, index) => index > firstTableRow && /^\s*[╰└]/.test(line),
    );
    expect(closing).toBeGreaterThan(firstTableRow);
  });
});
