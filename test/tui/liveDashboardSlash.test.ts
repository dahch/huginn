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
    // Phase 4D: the view hydrates its conversation from the transcript at mount.
    getTranscript: vi.fn().mockReturnValue([]),
    clearTranscript: vi.fn(),
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

    // Assert on cheat-sheet-only copy: this non-TTY harness concatenates Ink's
    // incremental frames, so the modal's *border/title* row can be overwritten by
    // neighbouring frames while its body rows survive intact.
    expect(output).toContain("Show this command cheat sheet");
    expect(output).toContain("Press Esc, q, or Enter to close cheat sheet");
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
    // AC-31.1/AC-31.2: the failure is prefixed, names the skill and says what to
    // do next — and the ANSI sequences in the query are stripped (SEC-LOW-001).
    expect(notFoundMsg).toBe(
      '⚠ Skill "unknown-skill" not found — type /skills to browse the available skills.',
    );
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

    // AC-31.2: the next step leads, the raw (sanitized) cause follows.
    const failure = systemMessages.find((m) => m.includes("Diagnostics failed"));
    expect(failure).toBeDefined();
    expect(failure).toContain("⚠ Diagnostics failed");
    expect(failure).toContain("run `/mcp`");
    expect(failure).toContain("cause: diagnostics probe failed");
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

  it("routes plain prompts whose first word matches a command to the model, not the dispatcher (REV-001)", async () => {
    const prompts = [
      "clear the cache please",
      "help me write a test for the parser",
      "status of the build",
      "go ahead and refactor the module",
    ];

    for (const prompt of prompts) {
      const stdout = createMockStdout();
      const stdin = createMockStdin();
      const live = createMockLive();

      const instance = render(React.createElement(LiveApp, { live, cfg: mockCfg }), {
        stdout,
        stdin,
        patchConsole: false,
      });

      await new Promise((r) => setTimeout(r, 60));
      await typeCommand(stdin, prompt);
      instance.unmount();

      const forwarded = (live.chat as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        (call) => call[0] === prompt,
      );
      expect(forwarded, `"${prompt}" must be forwarded to the model, not dispatched`).toBe(true);
    }
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

  it("opens the interactive runtime picker on bare /agent (REQ-33)", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk: any) => {
      output += chunk.toString();
    });
    const stdin = createMockStdin();
    const live = createMockLive({ switchRuntime: vi.fn() });

    const instance = render(
      React.createElement(LiveApp, {
        live,
        cfg: mockCfg,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    await typeCommand(stdin, "/agent");
    // This harness flushes Ink's frame on unmount, so read afterwards.
    instance.unmount();

    expect(output).toContain("SELECT AGENT RUNTIME");
    expect(live.switchRuntime).not.toHaveBeenCalled();
  });

  it("fails closed and keeps the picker open when a runtime cannot be switched (AC-33.2)", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const live = createMockLive({
      switchRuntime: vi.fn().mockRejectedValue(new Error('Agent runtime "cursor" is not available')),
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
    await new Promise((r) => setTimeout(r, 150));

    // Enter attempts the switch; it rejects.
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 120));
    // Enter again: if the modal had closed, this would submit an empty draft and
    // change nothing — so a second switch attempt proves it stayed open (REV-301).
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 120));
    instance.unmount();
    off();

    expect(live.switchRuntime).toHaveBeenCalledTimes(2);
    expect(systemMessages.some((m) => m.includes("Runtime switch failed"))).toBe(true);
    // The failure carries an actionable next step, never the raw cause alone.
    expect(systemMessages.some((m) => m.includes("run `/agent`"))).toBe(true);
  });

  it("still switches runtime via /agent <id> and reports the result (REQ-33)", async () => {
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
    await typeCommand(stdin, "/agent claude");
    instance.unmount();
    off();

    expect(live.switchRuntime).toHaveBeenCalledWith("claude");
    expect(systemMessages.some((m) => m.includes("Runtime switched to"))).toBe(true);
    expect(systemMessages.some((m) => m.includes("Runtime switch failed"))).toBe(false);
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
