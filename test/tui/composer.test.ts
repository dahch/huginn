import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { LiveApp } from "../../src/tui/LiveDashboard";
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

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Types a string and presses Enter. */
async function submit(stdin: MockStdin, text: string): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick(12);
  }
  stdin.write("\r");
  await tick(80);
}

/** Mounts the live view at a pinned 120×40 and captures what Ink writes. */
async function mountLive(
  live: LiveEngine,
): Promise<{ stdin: MockStdin; output: () => string; unmount: () => void }> {
  const restore = stubTerminalSize(40, 120);
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 120;
  stdout.rows = 40;
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

describe("Composer history & adaptive panels (REQ-34, REQ-35)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("recalls the most recent submission first with ↑ (AC-34.1)", async () => {
    const h = await mountLive(createMockLive());
    await submit(h.stdin, "first task");
    await submit(h.stdin, "second task");

    h.stdin.write("\u001B[A");
    await tick();
    h.unmount();

    expect(h.output()).toContain("❯ second task");
  });

  it("walks further back with repeated ↑, and the recalled draft stays editable (AC-34.1)", async () => {
    const h = await mountLive(createMockLive());
    await submit(h.stdin, "first task");
    await submit(h.stdin, "second task");

    h.stdin.write("\u001B[A");
    await tick();
    h.stdin.write("\u001B[A");
    await tick();
    expect(h.output()).toBe(""); // frames flush on unmount in this harness

    // Editing the recalled draft appends to it.
    h.stdin.write("!");
    await tick();
    h.unmount();

    expect(h.output()).toContain("❯ first task!");
  });

  it("ends the recall at the empty draft with ↓ (AC-34.1)", async () => {
    const h = await mountLive(createMockLive());
    await submit(h.stdin, "only task");

    h.stdin.write("\u001B[A"); // recall the submission
    await tick();
    h.stdin.write("\u001B[B"); // walk forward, back to the empty draft
    await tick();
    h.unmount();

    expect(h.output()).toContain("type / for commands");
  });

  it("does not put slash commands in the prompt history (AC-34.1)", async () => {
    const h = await mountLive(createMockLive());
    await submit(h.stdin, "real prompt");
    await submit(h.stdin, "/status");

    h.stdin.write("\u001B[A"); // recalls the *prompt*, never the command
    await tick();
    h.unmount();

    expect(h.output()).toContain("❯ real prompt");
  });

  it("shows the composer as the view's anchor (AC-34.2)", async () => {
    const h = await mountLive(createMockLive());
    h.unmount();

    const output = h.output();
    expect(output).toContain("❯");
    // The composer is boxed, unlike the plain card titles.
    expect(output).toContain("╭");
  });

  it("collapses the agent-output panel while idle (AC-35.2)", async () => {
    const h = await mountLive(createMockLive());
    h.unmount();

    // Idle: the conversation owns the space, no empty bordered box.
    expect(h.output()).toContain("Conversation");
    expect(h.output()).not.toContain("THINKING & LIVE AGENT STREAM");
  });

  it("stays collapsed after a phase that emitted no reasoning at all (AC-35.2)", async () => {
    const h = await mountLive(createMockLive());
    // The greenfield path emits phaseStart/phaseEnd with no stream text: the
    // buffer yields a blank line, which must not count as content.
    events.emit("phaseStart", { phase: "SPEC_AUDIT" } as never);
    await tick(80);
    events.emit("phaseEnd", { phase: "SPEC_AUDIT" } as never);
    await tick(80);
    h.unmount();

    expect(h.output()).not.toContain("THINKING & LIVE AGENT STREAM");
  });

  it("shows the agent-output panel once real stream content arrives (AC-35.2)", async () => {
    const h = await mountLive(createMockLive());
    events.emit("phaseStream", { text: "reasoning…" });
    await tick(140);
    h.unmount();

    expect(h.output()).toContain("THINKING & LIVE AGENT STREAM");
  });

  it("keeps arrow-scrolling available on the focused stream card, not history (AC-34.3)", async () => {
    const h = await mountLive(createMockLive());
    await submit(h.stdin, "a prompt that becomes history");

    // With stream content present, Tab focuses the stream card (both cards mounted).
    events.emit("phaseStream", { text: "streaming…" });
    await tick(120);
    h.stdin.write("\t");
    await tick();
    h.stdin.write("\u001B[A"); // must scroll the card, never recall into the composer
    await tick();
    h.unmount();

    // The composer is untouched by the arrow press.
    expect(h.output()).not.toContain("❯ a prompt that becomes history\n");
  });
});
