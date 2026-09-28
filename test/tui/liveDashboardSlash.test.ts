import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, afterEach } from "vitest";
import { render } from "ink";
import { LiveApp } from "../../src/tui/LiveDashboard";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";

function createMockStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function createMockStdout(): PassThrough & { columns: number; rows: number } {
  const stdout = new PassThrough() as any;
  stdout.columns = 120;
  stdout.rows = 40;
  return stdout;
}

const mockCfg: RunConfig = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "anthropic/claude-3-7-sonnet",
  cwd: "/mock/project",
} as any;

function createMockLive(overrides?: Partial<LiveEngine>): LiveEngine {
  return {
    cfg: mockCfg,
    runtime: {
      name: "MockRuntime",
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
    draft: vi.fn().mockResolvedValue("approved"),
    approvePlan: vi.fn().mockResolvedValue(undefined),
    requestAbort: vi.fn(() => {
      events.emit("done", { reason: "aborted", error: "live session aborted" });
    }),
    resolveDecision: vi.fn(),
    updateModels: vi.fn(),
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

async function typeCommand(stdin: PassThrough, command: string): Promise<void> {
  for (const c of command) {
    stdin.write(c);
    await new Promise((r) => setTimeout(r, 15));
  }
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 70));
}

describe("LiveDashboard Slash Commands", () => {
  afterEach(() => {
    events.clear();
  });

  it("opens HelpModal when /help is entered", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk: any) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const live = createMockLive();

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/help");
    instance.unmount();

    expect(output).toContain("HUGINN LIVE CHEAT SHEET");
    expect(output).toContain("Slash Commands");
  });

  it("opens SkillsModal when /skills or bare /skill is entered", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk: any) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const live = createMockLive();

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/skills");
    instance.unmount();

    expect(output).toContain("PROJECT SKILLS BROWSER");
    expect(output).toContain("Available Skills");
  });

  it("opens SkillsModal when bare /skill is entered", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk: any) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const live = createMockLive();

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/skill");
    instance.unmount();

    expect(output).toContain("PROJECT SKILLS BROWSER");
    expect(output).toContain("Available Skills");
  });

  it("executes matched skill when /skill <name> is entered", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/skill audit");
    instance.unmount();
    off();

    expect(live.chat).toHaveBeenCalledTimes(1);
    expect(systemMessages.some((msg) => msg.includes("Executing skill: Audit Code (audit)"))).toBe(true);
  });

  it("handles unmatched skill and sanitizes terminal injection (SEC-LOW-001)", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    // Provide a query with ANSI escape sequences
    await typeCommand(stdin, "/skill \u001b[31munknown-skill\u001b[0m");
    instance.unmount();
    off();

    expect(live.chat).not.toHaveBeenCalled();
    const notFoundMsg = systemMessages.find((msg) => msg.includes("not found"));
    expect(notFoundMsg).toBeDefined();
    // ANSI sequences must be stripped
    expect(notFoundMsg).toContain('Skill "unknown-skill" not found. Type /skills to browse available skills.');
    expect(notFoundMsg).not.toContain("\u001b[31m");
  });

  it("displays diagnostics on /status with sanitized and clamped gitBranch (SEC-LOW-001)", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const veryLongBranch = "feature/\u001b[32mvery-long-branch-name-that-definitely-exceeds-thirty-five-characters\u001b[0m";
    const live = createMockLive({
      getDiagnostics: vi.fn().mockResolvedValue({
        gitBranch: veryLongBranch,
        gitClean: true,
        worktreeSandbox: false,
        runtimeName: "MockRuntime",
        thinkerModel: "anthropic/claude-3-7-sonnet",
        executorModel: "anthropic/claude-3-7-sonnet",
        memoryStats: { entitiesCount: 8, observationsCount: 24 },
      }),
    });

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/status");
    instance.unmount();
    off();

    expect(live.getDiagnostics).toHaveBeenCalledTimes(1);
    const statusMsg = systemMessages.find((msg) => msg.includes("System Diagnostics"));
    expect(statusMsg).toBeDefined();
    expect(statusMsg).toContain("Active Runtime:   MockRuntime");
    expect(statusMsg).toContain("Muninn Memory:    8 entities, 24 observations");

    // Check branch sanitization and 35-char clamp:
    // "feature/very-long-branch-name-that-definitely-exceeds-thirty-five-characters".slice(0, 35)
    // = "feature/very-long-branch-name-that-" (exactly 35 characters)
    expect(statusMsg).not.toContain("\u001b[32m");
    const expectedClamped = "feature/very-long-branch-name-that-";
    expect(statusMsg).toContain(`│ Git Branch:       ${expectedClamped}│`);
  });

  it("handles diagnostics error on /status gracefully", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive({
      getDiagnostics: vi.fn().mockRejectedValue(new Error("diagnostics probe failed")),
    });

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/status");
    instance.unmount();
    off();

    expect(systemMessages.some((m) => m.includes("Failed to retrieve diagnostics: diagnostics probe failed"))).toBe(true);
  });

  it("clears messages on /clear", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/clear");
    instance.unmount();
    off();

    expect(systemMessages.some((m) => m.includes("Conversation and stream viewport cleared."))).toBe(true);
  });

  it("requires confirmation before /quit exits", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const doneEvents: any[] = [];
    const systemMessages: string[] = [];
    const offDone = events.on("done", (e) => {
      doneEvents.push(e);
    });
    const offChat = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // First /quit asks for confirmation and does not abort
    await typeCommand(stdin, "/quit");
    expect(live.requestAbort).not.toHaveBeenCalled();
    expect(systemMessages.some((m) => m.includes("confirm exit"))).toBe(true);

    // Second /quit confirms: abort fires and "done" is emitted exactly once
    await typeCommand(stdin, "/quit");
    instance.unmount();
    offDone();
    offChat();

    expect(live.requestAbort).toHaveBeenCalledTimes(1);
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].reason).toBe("aborted");
  });

  it("requires confirmation before /abort exits", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const doneEvents: any[] = [];
    const off = events.on("done", (e) => {
      doneEvents.push(e);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/abort");
    expect(live.requestAbort).not.toHaveBeenCalled();
    await typeCommand(stdin, "/abort");
    instance.unmount();
    off();

    expect(live.requestAbort).toHaveBeenCalledTimes(1);
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].reason).toBe("aborted");
  });

  it("never forwards an unknown slash command to the model", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/nonexistent");
    instance.unmount();
    off();

    expect(live.chat).not.toHaveBeenCalled();
    expect(systemMessages.some((m) => m.includes('Unknown command "/nonexistent"'))).toBe(true);
  });

  it("does not forward a malformed /models command to the model", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/models not-a-model");
    instance.unmount();
    off();

    expect(live.chat).not.toHaveBeenCalled();
    expect(live.updateModels).not.toHaveBeenCalled();
    expect(systemMessages.some((m) => m.includes('Invalid model format "not-a-model"'))).toBe(true);
  });

  it("lists and switches agent runtimes via /agent and /agent <id>", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive({
      switchRuntime: vi.fn().mockResolvedValue({ id: "claude", name: "Claude Code" }),
    });

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/agent");
    expect(systemMessages.some((m) => m.includes("Available agent runtimes"))).toBe(true);

    await typeCommand(stdin, "/agent claude");
    instance.unmount();
    off();

    expect(live.switchRuntime).toHaveBeenCalledWith("claude");
    expect(systemMessages.some((m) => m.includes("Failed to switch runtime"))).toBe(false);
  });

  it("aborts session immediately with 'q' key when busy (input disabled)", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    let resolveChat: (() => void) | undefined;
    const chatPromise = new Promise<void>((resolve) => {
      resolveChat = resolve;
    });
    const live = createMockLive({
      chat: vi.fn().mockImplementation(() => chatPromise),
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    // Trigger skill to set busy = true
    await typeCommand(stdin, "/skill audit");

    // Press 'q' while busy
    stdin.write("q");
    await new Promise((r) => setTimeout(r, 60));

    expect(live.requestAbort).toHaveBeenCalledTimes(1);

    instance.unmount();
    if (resolveChat) resolveChat();
  });

  it("opens ModelPickerModal on /models and updates models on /model <thinker> <executor>", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk: any) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const live = createMockLive();

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    // Test direct model setting
    await typeCommand(stdin, "/model anthropic/claude-3-7-sonnet opencode/gpt-5.1-codex");

    expect(live.updateModels).toHaveBeenCalledWith({
      thinker: "anthropic/claude-3-7-sonnet",
      executor: "opencode/gpt-5.1-codex",
    });

    // Test /models opens model picker modal
    await typeCommand(stdin, "/models");
    instance.unmount();

    expect(output).toContain("MODEL SELECTOR");
  });

  it("validates model format on /model <invalid>", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/model invalid-model-format");
    instance.unmount();
    off();

    expect(live.updateModels).not.toHaveBeenCalled();
    expect(systemMessages.some((m) => m.includes('Invalid model format "invalid-model-format"'))).toBe(true);
  });

  it("renders a rectangular /status box with aligned borders", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const systemMessages: string[] = [];
    const off = events.on("liveChat", (e) => {
      if (e.role === "system") systemMessages.push(e.text);
    });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/status");
    instance.unmount();
    off();

    const statusMsg = systemMessages.find((m) => m.includes("System Diagnostics"));
    expect(statusMsg).toBeDefined();
    const widths = new Set(statusMsg!.split("\n").map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("cancels a pending /quit confirmation when a different command is entered", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive();

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/quit");
    expect(live.requestAbort).not.toHaveBeenCalled();

    // Any other command clears the pending confirmation
    await typeCommand(stdin, "/status");
    await typeCommand(stdin, "/quit");
    instance.unmount();

    expect(live.requestAbort).not.toHaveBeenCalled();
  });
});
