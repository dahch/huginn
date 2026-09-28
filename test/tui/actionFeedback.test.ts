import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";
import { LiveApp } from "../../src/tui/LiveDashboard";
import { SLASH_COMMANDS } from "../../src/tui/commandRegistry";
import { EMPTY_CHAT_HINTS, hasFeedbackPrefix } from "../../src/tui/feedback.js";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

function createMockStdin(): PassThrough {
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
      getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
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
    switchRuntime: vi.fn().mockResolvedValue({ id: "claude", name: "Claude Code" }),
    getDiagnostics: vi.fn().mockResolvedValue({
      gitBranch: "main",
      gitClean: true,
      worktreeSandbox: false,
      runtimeName: "MockRuntime",
      thinkerModel: "anthropic/claude-3-7-sonnet",
      executorModel: "anthropic/claude-3-7-sonnet",
      memoryStats: { entitiesCount: 4, observationsCount: 9 },
    }),
    ...overrides,
  } as unknown as LiveEngine;
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

interface Harness {
  stdin: PassThrough;
  output: () => string;
  messages: string[];
  unmount: () => void;
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function mountLive(live: LiveEngine, onMessage?: (text: string) => void): Promise<Harness> {
  const stdout = new PassThrough() as unknown as PassThrough & { columns: number; rows: number };
  stdout.columns = 120;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  const messages: string[] = [];
  const off = events.on("liveChat", (e) => {
    if (e.role !== "system") return;
    messages.push(e.text);
    onMessage?.(e.text);
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
    messages,
    unmount: () => {
      off();
      instance.unmount();
    },
  };
}

/** Type one character at a time so Ink sees the same events a terminal would. */
async function type(stdin: PassThrough, text: string, charDelay = 10): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick(charDelay);
  }
  await tick(20);
}

/** Type a line and submit it. */
async function run(stdin: PassThrough, line: string, charDelay = 10): Promise<void> {
  await type(stdin, line, charDelay);
  stdin.write("\r");
  await tick(60);
}

/**
 * How each registry command is exercised. Keyed by canonical id so the drift
 * guard below fails if a new command is added without feedback coverage.
 */
const DISPATCH: Record<string, string> = {
  "/help": "/help",
  "/agent": "/agent claude",
  "/model": "/model anthropic/claude-3-7-sonnet",
  "/mcp": "/mcp",
  "/skills": "/skills audit",
  "/status": "/status",
  "/clear": "/clear",
  "/draft": "/draft",
  "/quit": "/quit",
};

describe("every command acknowledges itself (REQ-31 / AC-31.1)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("has a dispatcher entry for every registered command (drift guard)", () => {
    expect(Object.keys(DISPATCH).sort()).toEqual(SLASH_COMMANDS.map((c) => c.id).sort());
  });

  it("emits a visible, prefixed system message for every slash command", async () => {
    for (const command of SLASH_COMMANDS) {
      const line = DISPATCH[command.id];
      expect(line, `${command.id} has no dispatcher entry`).toBeDefined();

      const harness = await mountLive(createMockLive());
      await run(harness.stdin, line!);
      await tick(40);
      harness.unmount();

      expect(harness.messages.length, `${command.id} produced no acknowledgement`).toBeGreaterThan(0);
      for (const message of harness.messages) {
        expect(message.trim().length, `${command.id}: ${JSON.stringify(message)}`).toBeGreaterThan(0);
      }
      // One voice: every acknowledgement opens with ✓ / ⚠ / … — except the
      // `/status` diagnostics panel, which draws its own boxed report.
      const first = harness.messages[0]!;
      const isPanel = first.startsWith("╭─");
      expect(
        hasFeedbackPrefix(first) || isPanel,
        `${command.id} must acknowledge with a ✓/⚠/… line: ${JSON.stringify(first)}`,
      ).toBe(true);
    }
  });

  it("runs a prompt without a silent no-op and shows a busy indicator while it works", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = createMockLive({ chat: vi.fn().mockImplementation(() => pending) });

    const harness = await mountLive(live);
    await run(harness.stdin, "build me a payments module");
    harness.unmount();

    // The card titles spin while the prompt is in flight…
    expect(harness.output()).toContain("thinking...");
    // …and the prompt reached the engine, so nothing was swallowed.
    expect(live.chat).toHaveBeenCalledWith("build me a payments module");
    release?.();
  });

  it("acknowledges /draft immediately, then reports the outcome", async () => {
    const harness = await mountLive(createMockLive({ draft: vi.fn().mockResolvedValue("aborted") }));
    await run(harness.stdin, "/draft");
    harness.unmount();

    expect(harness.messages[0]).toBe("… Drafting spec.md, adr.md and plan.md from the refined scope…");
    expect(harness.messages[1]).toContain("⚠ Draft aborted");
  });

  it("confirms a model switch, and an agent switch, with a result line", async () => {
    const models = await mountLive(createMockLive());
    await run(models.stdin, "/model anthropic/claude-3-7-sonnet executor/x");
    models.unmount();
    expect(models.messages[0]).toBe(
      "✓ Active models updated: thinker = anthropic/claude-3-7-sonnet, executor = executor/x (session only)",
    );

    const agent = await mountLive(createMockLive());
    await run(agent.stdin, "/agent claude");
    // The engine owns the switch result; the console announces that it started.
    expect(agent.messages[0]).toBe('… Switching runtime to "claude"…');
    agent.unmount();
    expect((agent.messages as string[]).some((m) => m.startsWith("…"))).toBe(true);
  });

  it("acknowledges every modal it opens (REQ-31 / AC-31.1)", async () => {
    // The modal-body strings are asserted rather than the banner rows: this
    // non-TTY harness concatenates Ink's incremental frames, which can overwrite
    // a modal's first/last line.
    const cases: Array<[string, string, string]> = [
      ["/help", "Cheat sheet open", "Show this command cheat sheet"],
      ["/skills", "Skill browser open", "Available Skills"],
      ["/model", "Model picker open", "MODEL SELECTOR · Step 1/3"],
      ["/mcp", "MCP inspector open", "MCP SERVER INSPECTOR"],
    ];

    for (const [line, acknowledgement, modalTitle] of cases) {
      const harness = await mountLive(createMockLive());
      await run(harness.stdin, line);
      await tick(60);
      harness.unmount();

      const message = harness.messages.find((m) => m.includes(acknowledgement));
      expect(message, `${line} must acknowledge opening its modal`).toBeDefined();
      expect(message?.startsWith("✓"), `${line}: ${message}`).toBe(true);
      expect(harness.output(), `${line} must actually open its modal`).toContain(modalTitle);
    }
  });

  it("is never silent for an unknown command or a bare slash", async () => {
    const unknown = await mountLive(createMockLive());
    await run(unknown.stdin, "/nope");
    unknown.unmount();
    expect(unknown.messages[0]).toBe(
      '⚠ Unknown command "/nope" — type /help for the command reference.',
    );

    const bare = await mountLive(createMockLive());
    await type(bare.stdin, "/");
    bare.stdin.write("\r");
    await tick(60);
    bare.unmount();
    expect(bare.messages[0]).toContain('"/" is not a command yet');
    expect(bare.messages[0]?.startsWith("⚠")).toBe(true);
  });

  it("confirms before /quit and acknowledges the exit", async () => {
    const live = createMockLive();
    const harness = await mountLive(live);

    await run(harness.stdin, "/quit");
    expect(live.requestAbort).not.toHaveBeenCalled();
    expect(harness.messages[0]).toBe(
      "⚠ Type /quit or /abort again to confirm exit — anything else cancels.",
    );
    harness.unmount();
  });
});

describe("actionable errors (REQ-31 / AC-31.2)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("points at /mcp when diagnostics fail, keeping the sanitized cause", async () => {
    const live = createMockLive({
      getDiagnostics: vi.fn().mockRejectedValue(new Error("sqlite busy \u001b[31m")),
    });
    const harness = await mountLive(live);
    await run(harness.stdin, "/status");
    harness.unmount();

    const failure = harness.messages.find((m) => m.includes("Diagnostics failed"));
    expect(failure).toBeDefined();
    expect(failure?.startsWith("⚠ Diagnostics failed — run `/mcp`")).toBe(true);
    expect(failure).toContain("cause: sqlite busy");
    expect(failure).not.toContain("\u001b[31m");
  });

  it("points at /agent when a runtime switch fails", async () => {
    const live = createMockLive({
      switchRuntime: vi.fn().mockRejectedValue(new Error("binary not found")),
    });
    const harness = await mountLive(live);
    await run(harness.stdin, "/agent claude");
    harness.unmount();

    expect(live.switchRuntime).toHaveBeenCalledWith("claude");
    const failure = harness.messages.find((m) => m.includes("Runtime switch failed"));
    expect(failure).toContain("⚠ Runtime switch failed — run `/agent`");
    expect(failure).toContain("cause: binary not found");
  });

  it("points at /model when a model update fails", async () => {
    const live = createMockLive({
      updateModels: vi.fn().mockImplementation(() => {
        throw new Error("registry unreachable");
      }),
    });
    const harness = await mountLive(live);
    await run(harness.stdin, "/model anthropic/claude-3-7-sonnet");
    harness.unmount();

    const failure = harness.messages.find((m) => m.includes("Failed to update models"));
    expect(failure).toContain("⚠ Failed to update models — run `/model <id>`");
    expect(failure).toContain("cause: registry unreachable");
  });

  it("reports the failing turn and the next step before the session closes", async () => {
    const live = createMockLive({
      chat: vi.fn().mockRejectedValue(new Error("model overloaded")),
    });
    const harness = await mountLive(live);
    await run(harness.stdin, "and then what?");
    await tick(40);
    harness.unmount();

    const failure = harness.messages.find((m) => m.includes("Live session failed"));
    expect(failure).toContain("⚠ Live session failed — retry the turn, or switch with `/model <id>`");
    expect(failure).toContain("cause: model overloaded");
  });
});

describe("first-run guidance (REQ-31 / AC-31.3)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("renders the raven hint list in an empty conversation, naming the palette", async () => {
    const harness = await mountLive(createMockLive());
    harness.unmount();

    const output = harness.output();
    for (const hint of EMPTY_CHAT_HINTS) {
      expect(output, `missing hint: ${hint}`).toContain(hint);
    }
    expect(output).toContain("command palette");
    expect(output).toContain("/draft");
    expect(output).toContain("/mcp");
    expect(output).toContain("/status");
    expect(output).toContain("Huginn the raven");
    // The generic placeholder is gone.
    expect(output).not.toContain("I'll help you refine the scope.");
  });

  it("replaces the hints with the conversation once something is said", async () => {
    const live = createMockLive();
    const harness = await mountLive(live);
    await run(harness.stdin, "/clear");
    harness.unmount();

    expect(harness.messages[0]).toBe("✓ Conversation and stream viewport cleared.");
    const output = harness.output();
    expect(output).toContain("─ ✓ Conversation and stream viewport cleared.");
    // The first-run guidance steps aside for real content.
    expect(output).not.toContain("Huginn the raven is listening");
  });

  it("keeps the hint list inside the card on the canonical 80×24 terminal", async () => {
    const restore = stubTerminalSize(24, 80);
    try {
      const harness = await mountLive(createMockLive());
      harness.unmount();

      const output = harness.output();
      // The palette, the draft flow and the diagnostics remain reachable from the hint.
      expect(output).toContain("command palette");
      expect(output).toContain("/draft");
      expect(output).toContain("REFINEMENT CONVERSATION");
      expect(output).toContain("stage: REFINE");

      const plain = output.replace(ANSI, "");
      const lines = plain.split("\n").map((line) => line.replace(/\s+$/, ""));
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      expect(lines.length, "the hint must not push the frame past 24 rows").toBeLessThanOrEqual(24);
      for (const line of plain.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    } finally {
      restore();
    }
  });
});
