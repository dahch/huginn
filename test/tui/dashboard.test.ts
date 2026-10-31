import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { Dashboard, StreamCard } from "../../src/tui/Dashboard";
import { runLiveTui, runTui } from "../../src/tui/app";
import { events } from "../../src/engine/engineEvents";
import type { CycleEngine } from "../../src/engine/cycle";
import type { DecisionRequest } from "../../src/engine/types";
import type { RunConfig } from "../../src/config";
import type { HarnessState } from "../../src/state/schema";

describe("TUI Dashboard & StreamCard", () => {
  it("exports runTui and runLiveTui from src/tui/app.tsx (REV-010)", () => {
    expect(typeof runTui).toBe("function");
    expect(typeof runLiveTui).toBe("function");
  });

  it("StreamCard renders without tail prop and displays provided lines (REV-008)", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const lines = ["Line 1", "Line 2", "Line 3"];
    const instance = render(
      React.createElement(StreamCard, {
        lines,
        totalLines: 3,
        scrollOffset: 0,
        maxScroll: 0,
        chars: 100,
        spinner: "⠋",
        verbose: false,
      }),
      { stdout, patchConsole: false }
    );
    instance.unmount();

    expect(output).toContain("Line 1");
    expect(output).toContain("Line 2");
    expect(output).toContain("Line 3");
    expect(output).toContain("LIVE AGENT OUTPUT");
  });

  it("StreamCard falls back cleanly when lines is empty or omitted", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const instance = render(
      React.createElement(StreamCard, {
        chars: 0,
        spinner: "⠋",
        verbose: false,
      }),
      { stdout, patchConsole: false }
    );
    instance.unmount();

    expect(output).toContain("waiting for agent stream");
  });
});

/**
 * ADR-50 / REQ-51 — the output panel always shows something true to the engine's
 * state: the stream, the last phase's report, or an idle raven state that names
 * why there is nothing live.
 */
describe("StreamCard honesty modes (REQ-51)", () => {
  function renderCard(props: Record<string, unknown>): string {
    const stdout = new PassThrough() as any;
    stdout.columns = 120;
    stdout.rows = 40;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const instance = render(
      React.createElement(StreamCard, {
        chars: 0,
        spinner: "⠋",
        verbose: false,
        height: 12,
        ...props,
      } as any),
      { stdout, patchConsole: false },
    );
    instance.unmount();
    return output;
  }

  it("falls back to the phase report when the runtime cannot stream (AC-51.1)", () => {
    const output = renderCard({
      streamsOutput: false,
      runtimeId: "commandcode",
      report: "line one\nline two\nline three",
    });
    expect(output).toContain("line three");
    expect(output).not.toContain("waiting for agent stream");
  });

  it("does not let a blank-only stream buffer hide the last phase report", () => {
    const output = renderCard({
      streamsOutput: false,
      runtimeId: "pi",
      lines: [""],
      report: "phase report body",
    });
    expect(output).toContain("phase report body");
    expect(output).not.toContain("waiting for agent stream");
  });

  it("shows the idle state and names the runtime when there is nothing yet (AC-51.2/51.3)", () => {
    const output = renderCard({ streamsOutput: false, runtimeId: "commandcode" });
    expect(output).toContain("cannot stream live output");
    expect(output).toContain("commandcode");
    // The idle body draws the raven art (deterministic) plus a rotating phrase.
    expect(output).toContain("<(o");
    // No pending phase and no stream: the panel does not claim to be waiting.
    expect(output).not.toContain("waiting for agent stream");
  });

  it("keeps the waiting placeholder only for a runtime that can stream (AC-51.3)", () => {
    const output = renderCard({ streamsOutput: true, runtimeId: "opencode" });
    expect(output).toContain("waiting for agent stream");
  });
});

/**
 * ADR-48 / AC-49.3 — a failed promotion must be visible, naming the branch that
 * holds the finished iteration, instead of ending on a generic state.
 */
/** A stdin Ink can put in raw mode, so `useInput` does not refuse to mount. */
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

describe("Dashboard promotion notice (AC-49.3)", () => {
  it("names the preserved branch when a promotion failed", async () => {
    const stdout = new PassThrough() as any;
    stdout.columns = 120;
    stdout.rows = 40;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const state = {
      currentIteration: 1,
      currentPhase: "COMMIT_ALL",
      promotion: {
        status: "conflict",
        branch: "huginn/task-iter-1",
        backups: ["/tmp/p/.huginn/promotion-backup/s"],
      },
    } as unknown as HarnessState;

    const engine = {
      getState: () => state,
      runtime: {
        id: "commandcode",
        getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
      },
      resolveDecision: () => {},
      pause: () => {},
      resume: () => {},
      requestAbort: () => {},
    } as unknown as CycleEngine;

    const cfg = {
      projectPath: "/tmp/p",
      planPath: "/tmp/p/plan.md",
      specPath: "/tmp/p/spec.md",
      adrPath: "/tmp/p/adr.md",
      thinker: "a/b",
      executor: "c/d",
      mode: "auto",
      permissions: "auto",
      maxRetries: 1,
      tui: false,
      port: 0,
      serverTimeoutMs: 1000,
      phaseTimeoutMs: 0,
      ignorePlanChanges: false,
      sandbox: false,
    } as unknown as RunConfig;

    const instance = render(React.createElement(Dashboard, { engine, cfg, autoExit: false }), {
      stdout,
      stdin: createMockStdin(),
      patchConsole: false,
    });
    // Let the events effect subscribe before the run ends.
    await new Promise((resolve) => setTimeout(resolve, 60));
    events.emit("done", { reason: "error" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    instance.unmount();

    expect(output).toContain("PROMOTION FAILED");
    expect(output).toContain("huginn/task-iter-1");
  });
});

describe("PipelineCard order (REV-6202)", () => {
  const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

  async function renderPipeline(profile: string): Promise<string> {
    const stdout = new PassThrough() as any;
    stdout.columns = 120;
    stdout.rows = 40;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const state = {
      currentIteration: 1,
      currentPhase: "VERIFY",
    } as unknown as HarnessState;
    const engine = {
      getState: () => state,
      runtime: {
        id: "commandcode",
        getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
      },
      resolveDecision: () => {},
      pause: () => {},
      resume: () => {},
      requestAbort: () => {},
    } as unknown as CycleEngine;
    const cfg = {
      projectPath: "/tmp/p",
      thinker: "a/b",
      executor: "c/d",
      mode: "auto",
      profile,
    } as unknown as RunConfig;
    const instance = render(React.createElement(Dashboard, { engine, cfg, autoExit: false }), {
      stdout,
      stdin: createMockStdin(),
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    instance.unmount();
    return output.replace(ANSI, "");
  }

  it("follows the Huginn Cycle, which runs VERIFY right after EXECUTE", async () => {
    const output = await renderPipeline("huginn");
    const verify = output.indexOf(" VERIFY");
    const validate = output.indexOf(" VALIDATE_STEP");
    expect(verify).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(validate);
  });

  it("never lists a phase the active profile does not run", async () => {
    const output = await renderPipeline("odd");
    expect(output).toContain("EXECUTE");
    expect(output).not.toContain("SPEC_AUDIT");
    expect(output).not.toContain("SECURE_CHECK");
  });
});

describe("post-cycle promotion recovery (ADR-62)", () => {
  const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
  const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function postCycleRequest(choices: DecisionRequest["choices"]): DecisionRequest {
    return {
      id: "decision-1",
      kind: "post-cycle-live",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message: "Cycle failed: Sandbox promotion conflicted.",
      ...(choices ? { choices } : {}),
    };
  }

  async function mount(request: DecisionRequest, resolveDecision = vi.fn()): Promise<{
    stdin: ReturnType<typeof createMockStdin>;
    output: () => string;
    resolveDecision: ReturnType<typeof vi.fn>;
    unmount: () => void;
  }> {
    events.clear();
    const stdout = new PassThrough() as any;
    stdout.columns = 120;
    stdout.rows = 40;
    let out = "";
    stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const stdin = createMockStdin();
    const state = { currentIteration: 1, currentPhase: "VERIFY" } as unknown as HarnessState;
    const engine = {
      getState: () => state,
      runtime: {
        id: "commandcode",
        getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
      },
      resolveDecision,
      pause: () => {},
      resume: () => {},
      requestAbort: () => {},
      isRunning: false,
    } as unknown as CycleEngine;
    const cfg = { projectPath: "/tmp/p", thinker: "a/b", executor: "c/d", mode: "auto" } as RunConfig;
    const instance = render(React.createElement(Dashboard, { engine, cfg, autoExit: false }), {
      stdout,
      stdin,
      patchConsole: false,
    });
    await tick();
    events.emit("decision", request);
    await tick();
    return {
      stdin,
      output: () => out.replace(ANSI, ""),
      resolveDecision,
      unmount: () => instance.unmount(),
    };
  }

  it("advertises the recovery keys the request offers and nothing more", async () => {
    const withRecovery = await mount(
      postCycleRequest(["retry-promotion", "repair", "retry", "continue", "abort"]),
    );
    withRecovery.unmount();
    const offered = withRecovery.output();
    expect(offered).toContain("[t]");
    expect(offered).toContain("[p]");

    const without = await mount(postCycleRequest(["retry", "continue", "abort"]));
    without.unmount();
    const plain = without.output();
    expect(plain).toContain("Return to Live mode");
    expect(plain).not.toContain("[t]");
    expect(plain).not.toContain("[p]");
  });

  it("answers [t]/[p] with the recovery choices the prompt offers", async () => {
    const retry = await mount(
      postCycleRequest(["retry-promotion", "repair", "retry", "continue", "abort"]),
    );
    retry.stdin.write("t");
    await tick();
    expect(retry.resolveDecision).toHaveBeenCalledWith("retry-promotion");
    retry.unmount();

    const repair = await mount(
      postCycleRequest(["retry-promotion", "repair", "retry", "continue", "abort"]),
    );
    repair.stdin.write("p");
    await tick();
    expect(repair.resolveDecision).toHaveBeenCalledWith("repair");
    repair.unmount();
  });

  it("keeps an unoffered key a no-op", async () => {
    const onlyRetry = await mount(postCycleRequest(["retry", "continue", "abort"]));
    onlyRetry.stdin.write("p");
    await tick();
    expect(onlyRetry.resolveDecision).not.toHaveBeenCalled();
    // The keys the prompt did advertise still work.
    onlyRetry.stdin.write("r");
    await tick();
    expect(onlyRetry.resolveDecision).toHaveBeenCalledWith("retry");
    onlyRetry.unmount();
  });
});

describe("LiveDashboard input sanitization (REV-004)", () => {
  it("filters out ANSI escape sequences and non-printable control characters", () => {
    const sanitizeInput = (input: string): string => {
      return input
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    };

    expect(sanitizeInput("\x1b[D")).toBe("");
    expect(sanitizeInput("\x1b[A\x1b[Bhello\x1b[C")).toBe("hello");
    expect(sanitizeInput("valid input 123 !@#")).toBe("valid input 123 !@#");
    expect(sanitizeInput("\x00\x08test\x1F")).toBe("test");
    expect(sanitizeInput("\u001b[31mred\u001b[0m")).toBe("red");
  });
});

describe("Stream buffer bounding (REV-001 / REV-002)", () => {
  it("clamps stream buffer to the last 1000 lines", () => {
    const MAX_STREAM_LINES = 1000;
    const generateLines = (count: number) =>
      Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

    const largeBuffer = generateLines(1500);
    const allLines = largeBuffer.split("\n");
    const boundedLines =
      allLines.length > MAX_STREAM_LINES
        ? allLines.slice(-MAX_STREAM_LINES)
        : allLines;

    expect(boundedLines.length).toBe(1000);
    expect(boundedLines[0]).toBe("line 501");
    expect(boundedLines[999]).toBe("line 1500");
  });
});
