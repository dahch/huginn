import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { LiveApp } from "../../src/tui/LiveDashboard";
import { SLASH_COMMANDS } from "../../src/tui/commandRegistry";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";

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

function createMockStdout(): PassThrough & { columns: number; rows: number } {
  const stdout = new PassThrough() as unknown as PassThrough & { columns: number; rows: number };
  stdout.columns = 120;
  stdout.rows = 40;
  return stdout;
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
    runtime: {
      name: "MockRuntime",
      id: "opencode",
      capabilities: { streaming: true, systemPrompts: true, tools: true },
    },
    models: {
      thinker: "anthropic/claude-3-7-sonnet",
      executor: "anthropic/claude-3-7-sonnet",
    },
    currentStage: "refine",
    ideaText: "",
    start: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn().mockResolvedValue(undefined),
    draft: vi.fn().mockResolvedValue("aborted"),
    approvePlan: vi.fn().mockResolvedValue(undefined),
    requestAbort: vi.fn(),
    resolveDecision: vi.fn(),
    updateModels: vi.fn(),
    switchRuntime: vi.fn().mockResolvedValue({ id: "claude", name: "Claude Code" }),
    getDiagnostics: vi.fn().mockResolvedValue({
      gitBranch: "main",
      gitClean: true,
      worktreeSandbox: false,
      runtimeName: "MockRuntime",
      thinkerModel: "anthropic/claude-3-7-sonnet",
      executorModel: "anthropic/claude-3-7-sonnet",
      memoryStats: { entitiesCount: 5, observationsCount: 12 },
    }),
    ...overrides,
  } as unknown as LiveEngine;
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  stdin: ReturnType<typeof createMockStdin>;
  output: () => string;
  systemMessages: string[];
  unmount: () => void;
}

async function mountLive(live: LiveEngine): Promise<Harness> {
  const stdout = createMockStdout();
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  const systemMessages: string[] = [];
  const off = events.on("liveChat", (e) => {
    if (e.role === "system") systemMessages.push(e.text);
  });
  const instance = render(React.createElement(LiveApp, { live, cfg: mockCfg }), {
    stdout,
    stdin,
    patchConsole: false,
  });
  await tick();
  return {
    stdin,
    output: () => output,
    systemMessages,
    unmount: () => {
      instance.unmount();
      off();
    },
  };
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

/** Type one character at a time so Ink sees the same events a terminal would. */
async function type(stdin: PassThrough, text: string, charDelay = 15): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick(charDelay);
  }
  await tick();
}

describe("Inline slash-command palette (AC-28.2, AC-28.3, AC-28.4)", () => {
  // The engine event bus is module-global: other suites leave log entries behind
  // (bun test runs every file in one process), which would render a log card and
  // change the layout budget these frame assertions depend on.
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("opens beneath the input as soon as '/' is typed", async () => {
    const harness = await mountLive(createMockLive());
    await type(harness.stdin, "/");
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("❯ /");
    expect(output).toContain("▸ /help");
    expect(output).toContain("/model <thinker> [executor]");
    expect(output).toContain("[↑/↓] Select · [Tab] Accept · [Enter] Run · [Esc] Dismiss");
    // Height-bounded: 9 commands, at most 6 content rows (5 here + scroll marker).
    expect(output).toContain("▼ 4 more below");
  });

  it("filters the palette as more characters are typed", async () => {
    const harness = await mountLive(createMockLive());
    await type(harness.stdin, "/mod");
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("❯ /mod");
    expect(output).toContain("▸ /model <thinker> [executor]");
    expect(output).not.toContain("/agent");
    expect(output).not.toContain("more below");
  });

  it("closes the palette once a space starts the arguments", async () => {
    const harness = await mountLive(createMockLive());
    await type(harness.stdin, "/status ");
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("❯ /status");
    expect(output).not.toContain("▸");
    expect(output).toContain("[Tab] Toggle focus");
  });

  it("moves the highlight with the arrow keys", async () => {
    const down = await mountLive(createMockLive());
    await type(down.stdin, "/");
    await type(down.stdin, "\u001B[B");
    down.unmount();
    expect(down.output()).toContain("▸ /agent [id]");

    const up = await mountLive(createMockLive());
    await type(up.stdin, "/");
    await type(up.stdin, "\u001B[B\u001B[B\u001B[A");
    up.unmount();
    expect(up.output()).toContain("▸ /agent [id]");
  });

  it("moves the highlight with j/k while the input is a bare slash", async () => {
    const harness = await mountLive(createMockLive());
    await type(harness.stdin, "/");
    await type(harness.stdin, "jj");
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("▸ /model <thinker> [executor]");
    expect(output).toContain("❯ /");
  });

  it("accepts the highlighted command with Tab without submitting", async () => {
    const live = createMockLive();
    const harness = await mountLive(live);
    await type(harness.stdin, "/mod");
    await type(harness.stdin, "\t");
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("❯ /model"); // accepted into the input row
    expect(output).not.toContain("▸");
    expect(live.chat).not.toHaveBeenCalled();
    expect(live.updateModels).not.toHaveBeenCalled();
  });

  it("runs the accepted command when the user then types arguments and submits", async () => {
    const live = createMockLive();
    const harness = await mountLive(live);
    await type(harness.stdin, "/mod");
    await type(harness.stdin, "\t");
    await type(harness.stdin, "invalid-model");
    await type(harness.stdin, "\r");
    harness.unmount();

    expect(live.updateModels).not.toHaveBeenCalled();
    // Accepted with a trailing space, so the argument attaches to `/model` and not `/modelinvalid-model`.
    expect(
      harness.systemMessages.some((m) => m.includes('Invalid model format "invalid-model"')),
    ).toBe(true);
    expect(harness.systemMessages.some((m) => m.includes("Unknown command"))).toBe(false);
  });

  it("submits a complete no-argument command with Enter", async () => {
    const harness = await mountLive(createMockLive());
    await type(harness.stdin, "/stat");
    await type(harness.stdin, "\r");
    harness.unmount();

    expect(harness.systemMessages.some((m) => m.includes("System Diagnostics"))).toBe(true);
  });

  it("accepts an argument-taking command with Enter and leaves room for its arguments", async () => {
    const live = createMockLive();
    const harness = await mountLive(live);
    await type(harness.stdin, "/mc");
    await type(harness.stdin, "\r");
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("❯ /mcp");
    expect(output).not.toContain("▸");
    expect(live.chat).not.toHaveBeenCalled();
  });

  it("dismisses the palette with Esc instead of aborting the session", async () => {
    const live = createMockLive();
    const harness = await mountLive(live);
    await type(harness.stdin, "/");
    await type(harness.stdin, "\u001B");
    expect(live.requestAbort).not.toHaveBeenCalled();
    expect(harness.output()).not.toContain("▸");

    // With the palette closed, Esc aborts again.
    await type(harness.stdin, "\u001B");
    harness.unmount();
    expect(live.requestAbort).toHaveBeenCalledTimes(1);
  });

  it("answers an unmatched slash token instead of forwarding it to the model", async () => {
    const live = createMockLive();
    const harness = await mountLive(live);
    await type(harness.stdin, "/nope");
    await type(harness.stdin, "\r");
    harness.unmount();

    expect(live.chat).not.toHaveBeenCalled();
    expect(harness.systemMessages.some((m) => m.includes('Unknown command "/nope"'))).toBe(true);
  });

  it("does not intercept Tab once the palette is closed", async () => {
    const harness = await mountLive(createMockLive());
    await type(harness.stdin, "/status ");
    await type(harness.stdin, "\t");
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("THINKING & LIVE AGENT STREAM ● [Focused");
    expect(output).toContain("❯ /status");
  });

  it("dispatches every registry alias instead of replying 'Unknown command' (AC-28.1, AC-28.5)", async () => {
    const aliases = SLASH_COMMANDS.flatMap((command) => command.aliases);
    expect(aliases.length).toBeGreaterThanOrEqual(13);

    for (const alias of aliases) {
      const live = createMockLive();
      const harness = await mountLive(live);
      await type(harness.stdin, alias, 5);
      await type(harness.stdin, "\r", 5);
      await tick(30);
      harness.unmount();

      const unknown = harness.systemMessages.filter((message) => message.includes("Unknown command"));
      expect(unknown, `${alias} is advertised by the registry but not dispatched`).toEqual([]);
      expect(live.chat, `${alias} must never reach the model`).not.toHaveBeenCalled();
    }
  });

  it("keeps the whole view on screen when the palette is open on a short terminal", async () => {
    const restore = stubTerminalSize(24, 100);
    try {
      const harness = await mountLive(createMockLive());
      await type(harness.stdin, "/");
      harness.unmount();

      const output = harness.output();
      expect(output).toContain("REFINEMENT CONVERSATION");
      expect(output).toContain("THINKING & LIVE AGENT STREAM");
      expect(output).toContain("▸ /help");
      expect(output).toContain("stage: REFINE");
      // AC-28.4: the palette may not push the layout past the terminal height.
      const frameRows = output
        .split("\n")
        .map((line) => line.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").trimEnd())
        .filter((line) => line.length > 0);
      expect(frameRows.length).toBeLessThanOrEqual(24);
    } finally {
      restore();
    }
  });
});
