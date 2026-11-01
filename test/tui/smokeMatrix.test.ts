import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import { events } from "../../src/engine/engineEvents";
import type { CycleEngine } from "../../src/engine/cycle";
import type { DiagnosticsInfo, LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";
import type { HarnessState } from "../../src/state/schema";

/**
 * REQ-21 / REQ-76 (ADR-72) — the visual pass is a test, not a screenshot.
 *
 * Every terminal surface is a fixed grid: a row wider than `columns` wraps over
 * the row below it (Ink paints one logical line as several rows), one row too
 * many pushes the footer off the frame, and a pictograph occupies two columns
 * while nobody budgeted for it. This matrix mounts both surfaces at the four
 * canonical terminal sizes, with colour on, off (`NO_COLOR`) and on the dark
 * palette, and inspects what Ink actually painted.
 *
 * Width is measured with `string-width`, never `.length`: box drawing, `…`,
 * braille spinners and accented prose all disagree with code-unit counts.
 */

/** The sizes the TUI is actually used at, smallest first. */
const SIZES = [
  [80, 24],
  [100, 30],
  [120, 40],
  [160, 50],
] as const;

/** How long a mounted surface gets to paint its first frame before it is looked at. */
const FLUSH_MS = 20;

/**
 * ANSI control sequences: CSI (colour, cursor, erase) and OSC (hyperlinks).
 * A frame's *display* width is measured after these are removed.
 */
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/** Colour-bearing SGR only: bold (`1`/`22`) is not colour and stays allowed. */
const COLOR_SGR = /\u001B\[(?:3[0-9]|9[0-9])m|\u001B\[(?:38|48);/g;

/** An emoji (or any other double-width pictograph) inside console chrome. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

interface TuiModules {
  React: typeof import("react");
  render: typeof import("./inkRender").render;
  LiveApp: typeof import("../../src/tui/LiveDashboard").LiveApp;
  Dashboard: typeof import("../../src/tui/Dashboard").Dashboard;
}

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "opencode/gpt-5.1-codex",
  cwd: "/mock/project",
} as unknown as RunConfig;

const diagnostics: DiagnosticsInfo = {
  gitBranch: "feature/live-layout",
  gitClean: false,
  worktreeSandbox: true,
  runtimeName: "opencode",
  thinkerModel: "anthropic/claude-3-7-sonnet",
  executorModel: "opencode/gpt-5.1-codex",
  memoryStats: { entitiesCount: 42, observationsCount: 137 },
};

function createMockLive(): LiveEngine {
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
    getTranscript: () => [],
    getResumePoint: () => undefined,
    clearTranscript: () => undefined,
    start: async () => undefined,
    chat: async () => undefined,
    draft: async () => "aborted",
    approvePlan: async () => undefined,
    requestAbort: () => undefined,
    resolveDecision: () => undefined,
    updateModels: () => undefined,
    switchRuntime: () => undefined,
    getDiagnostics: async () => diagnostics,
  } as unknown as LiveEngine;
}

function createMockEngine(): CycleEngine {
  const state = {
    currentIteration: 1,
    currentPhase: "SPEC_AUDIT",
  } as unknown as HarnessState;
  return {
    getState: () => state,
    runtime: {
      id: "commandcode",
      getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    },
    resolveDecision: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    requestAbort: () => undefined,
  } as unknown as CycleEngine;
}

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

/** The visible rows of the frame, without escapes and without trailing blanks. */
function displayLines(output: string): string[] {
  const lines = output.replace(ANSI, "").replace(/\r/g, "").split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines;
}

/**
 * What is wrong with one painted frame. Every problem names the surface, the
 * terminal size, the offending row and what paints there, so a failure in CI is
 * a location instead of a mystery.
 */
function frameProblems(surface: string, columns: number, rows: number, output: string): string[] {
  const where = `${surface} at ${columns}x${rows}`;
  const lines = displayLines(output);
  const problems: string[] = [];

  if (lines.length === 0) {
    problems.push(`${where}: painted no frame`);
    return problems;
  }
  if (lines.length > rows) {
    problems.push(`${where}: painted ${lines.length} rows, but the terminal only has ${rows}`);
  }

  lines.forEach((line, index) => {
    const row = index + 1;
    const width = stringWidth(line);
    if (width > columns) {
      problems.push(
        `${where}: row ${row} is ${width} display columns wide (max ${columns}): ${JSON.stringify(line)}`,
      );
    }
    if (PICTOGRAPH.test(line)) {
      problems.push(
        `${where}: row ${row} contains a double-width pictograph: ${JSON.stringify(line)}`,
      );
    }
  });

  return problems;
}

/** Colour escapes are a failure only where the contract says there are none. */
function colorProblems(surface: string, columns: number, rows: number, output: string): string[] {
  const matches = output.match(COLOR_SGR);
  if (!matches) return [];
  return [
    `${surface} at ${columns}x${rows}: NO_COLOR still emitted colour SGR ${JSON.stringify(
      matches.slice(0, 4),
    )}`,
  ];
}

/** Load Ink *after* the environment is pinned, so chalk's level is the real one. */
async function loadModules(): Promise<TuiModules> {
  const React = (await import("react")).default;
  const { render } = await import("./inkRender");
  const { LiveApp } = await import("../../src/tui/LiveDashboard");
  const { Dashboard } = await import("../../src/tui/Dashboard");
  return { React, render, LiveApp, Dashboard };
}

function createStdout(columns: number, rows: number): PassThrough & {
  columns: number;
  rows: number;
} {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  return stdout;
}

/** Mount, let one frame flush, unmount, and return exactly what Ink painted. */
async function paint(
  modules: TuiModules,
  columns: number,
  rows: number,
  tree: Parameters<TuiModules["render"]>[0],
  stdin: PassThrough,
): Promise<string> {
  const restore = stubTerminalSize(rows, columns);
  const stdout = createStdout(columns, rows);
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  let instance: ReturnType<TuiModules["render"]> | undefined;
  try {
    instance = modules.render(tree, { stdout, stdin, patchConsole: false });
    await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
  } finally {
    // Unmount and restore even when rendering threw: a leaked terminal size
    // would corrupt every frame the rest of the suite paints.
    instance?.unmount();
    // Ink flushes the final frame on unmount; one macrotask is enough.
    await new Promise((resolve) => setImmediate(resolve));
    restore();
  }
  return output;
}

async function paintLive(modules: TuiModules, columns: number, rows: number): Promise<string> {
  return paint(
    modules,
    columns,
    rows,
    modules.React.createElement(modules.LiveApp, { live: createMockLive(), cfg: mockCfg }),
    createMockStdin(),
  );
}

async function paintDashboard(modules: TuiModules, columns: number, rows: number): Promise<string> {
  return paint(
    modules,
    columns,
    rows,
    modules.React.createElement(modules.Dashboard, {
      engine: createMockEngine(),
      cfg: mockCfg,
      autoExit: false,
    }),
    createMockStdin(),
  );
}

interface EnvironmentCase {
  name: string;
  /** Set before Ink is imported, because chalk freezes its colour level on import. */
  env: NodeJS.ProcessEnv;
  /** `NO_COLOR` promises the frame carries no colour escape at all. */
  colorSuppressed: boolean;
}

const ENVIRONMENTS: EnvironmentCase[] = [
  {
    name: "colour on (auto palette)",
    env: { FORCE_COLOR: "3" },
    colorSuppressed: false,
  },
  {
    name: "NO_COLOR=1",
    // Colour is forced at the shell too: the assertion must prove the theme
    // suppresses it, not that a non-TTY test runner happened to lose it.
    env: { FORCE_COLOR: "3", NO_COLOR: "1" },
    colorSuppressed: true,
  },
  {
    name: "HUGINN_THEME=dark",
    env: { FORCE_COLOR: "3", HUGINN_THEME: "dark" },
    colorSuppressed: false,
  },
];

const ENV_KEYS = ["FORCE_COLOR", "NO_COLOR", "HUGINN_THEME"] as const;

function setEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  events.clear();
  vi.resetModules();
});

describe.each(ENVIRONMENTS)("visual smoke matrix — $name", ({ env, colorSuppressed }) => {
  it("paints both surfaces inside every canonical terminal, with no pictographs", async () => {
    events.clear();
    setEnvironment(env);
    vi.resetModules();
    const modules = await loadModules();

    const problems: string[] = [];
    for (const [columns, rows] of SIZES) {
      const liveOutput = await paintLive(modules, columns, rows);
      problems.push(...frameProblems("live console", columns, rows, liveOutput));
      if (colorSuppressed) {
        problems.push(...colorProblems("live console", columns, rows, liveOutput));
      }

      const dashboardOutput = await paintDashboard(modules, columns, rows);
      problems.push(...frameProblems("run dashboard", columns, rows, dashboardOutput));
      if (colorSuppressed) {
        problems.push(...colorProblems("run dashboard", columns, rows, dashboardOutput));
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });
});

/**
 * The matrix is only as good as the checks that inspect a frame: a validator
 * that silently accepts a wide row or a pictograph would let the whole suite
 * go green while the console wraps. These exercise the inspector directly,
 * including every failure branch the matrix depends on.
 */
describe("frame inspection", () => {
  it("strips ANSI colour, OSC links and carriage returns before measuring", () => {
    const output =
      "\u001B[31mred\u001B[0m\r\n" +
      "\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007\n" +
      "plain\n\n   \n";

    expect(displayLines(output)).toEqual(["red", "link", "plain"]);
  });

  it("accepts a frame that fits exactly and reports nothing", () => {
    expect(frameProblems("live console", 10, 2, "1234567890\nshort")).toEqual([]);
  });

  it("measures display columns, so a wide character needs two columns", () => {
    // `界` is two display columns but one UTF-16 code unit.
    expect(frameProblems("live console", 2, 1, "界")).toEqual([]);

    const problems = frameProblems("live console", 1, 1, "界");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("live console at 1x1");
    expect(problems[0]).toContain("row 1 is 2 display columns wide (max 1)");
  });

  it("names the surface, the size, the offending row and what paints there", () => {
    const problems = frameProblems("run dashboard", 10, 2, "12345678901");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("run dashboard at 10x2");
    expect(problems[0]).toContain("row 1");
    expect(problems[0]).toContain("11 display columns");
    expect(problems[0]).toContain(JSON.stringify("12345678901"));
  });

  it("reports a frame with more rows than the terminal owns", () => {
    const problems = frameProblems("live console", 10, 2, "a\nb\nc");

    expect(problems).toEqual(["live console at 10x2: painted 3 rows, but the terminal only has 2"]);
  });

  it("reports an empty frame instead of quietly passing", () => {
    expect(frameProblems("live console", 10, 2, "\n  \n")).toEqual([
      "live console at 10x2: painted no frame",
    ]);
  });

  it("rejects a pictograph even when its width would fit", () => {
    const problems = frameProblems("run dashboard", 10, 1, "\u{1F7E2} ok");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("run dashboard at 10x1");
    expect(problems[0]).toContain("double-width pictograph");
  });
});

describe("colour inspection", () => {
  it("does not mistake bold or reset SGR for colour", () => {
    expect(colorProblems("live console", 10, 1, "\u001B[1mbold\u001B[22m\u001B[0m")).toEqual([]);
  });

  it("names the surface, size and the colour runs it found", () => {
    const problems = colorProblems("run dashboard", 100, 30, "\u001B[31mred\u001B[0m");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("run dashboard at 100x30");
    expect(problems[0]).toContain("NO_COLOR still emitted colour SGR");
    expect(problems[0]).toContain("\\u001b[31m");
  });

  it("detects 256-colour and true-colour sequences", () => {
    expect(colorProblems("live console", 10, 1, "\u001B[38;5;196mred\u001B[0m")).toHaveLength(1);
    expect(colorProblems("live console", 10, 1, "\u001B[48;2;1;2;3mred\u001B[0m")).toHaveLength(1);
  });
});

describe("environment and terminal stubs", () => {
  it("replaces only the variables the matrix owns", () => {
    setEnvironment({ NO_COLOR: "1" });

    expect(process.env.NO_COLOR).toBe("1");
    expect(process.env.FORCE_COLOR).toBeUndefined();
    expect(process.env.HUGINN_THEME).toBeUndefined();
  });

  it("restores terminal dimensions to the values it replaced", () => {
    const originalRows = process.stdout.rows;
    const originalColumns = process.stdout.columns;

    const restore = stubTerminalSize(30, 100);
    expect(process.stdout.rows).toBe(30);
    expect(process.stdout.columns).toBe(100);

    restore();
    expect(process.stdout.rows).toBe(originalRows);
    expect(process.stdout.columns).toBe(originalColumns);
  });

  it("restores the terminal size when rendering throws", async () => {
    const modules = await loadModules();
    const originalRows = process.stdout.rows;
    const originalColumns = process.stdout.columns;
    const exploding: TuiModules = {
      ...modules,
      render: (() => {
        throw new Error("render boom");
      }) as TuiModules["render"],
    };

    await expect(
      paint(exploding, 80, 24, modules.React.createElement("ink-box"), createMockStdin()),
    ).rejects.toThrow("render boom");

    expect(process.stdout.rows).toBe(originalRows);
    expect(process.stdout.columns).toBe(originalColumns);
  });
});
