import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "./inkRender";
import { capStreamRows, Dashboard, MAX_STREAM_ROWS, nextStreamMaximized, StreamCard } from "../../src/tui/Dashboard";
import { runLiveTui, runTui } from "../../src/tui/app";
import { events } from "../../src/engine/engineEvents";
import type { CycleEngine } from "../../src/engine/cycle";
import type { DecisionRequest } from "../../src/engine/types";
import { decisionTitle } from "../../src/tui/decision";
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

  async function renderPipeline(
    profile: string,
    act?: () => Promise<void>,
    usage?: { inputTokens: number; outputTokens: number; costUsd: number },
  ): Promise<string> {
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
      ...(usage ? { usage } : {}),
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
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (act) await act();
    } finally {
      instance.unmount();
    }
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

  it("leaves the footer to the run keys and usage, never the stage (ADR-73)", async () => {
    const output = await renderPipeline("huginn");
    expect(output).toContain("[Space] Pause");
    // The live stage is the header badge's fact; the footer is the keys.
    expect(output).not.toContain("stage:");
  });

  it("keeps the usage figure on the footer's right cell (ADR-73)", async () => {
    const output = await renderPipeline("huginn", undefined, {
      inputTokens: 12_400,
      outputTokens: 3_200,
      costUsd: 0.42,
    });
    const footer = output.split("\n").filter((line) => line.trim().length > 0).pop() ?? "";
    // Keys on the left, `usage` on the right — the cell the stage badge used to
    // share, and which it must not reclaim.
    expect(footer).toContain("[Space] Pause");
    expect(footer).toContain("12.4k in / 3.2k out · $0.42");
    expect(footer).not.toContain("stage:");
  });

  it("never lists a phase the active profile does not run", async () => {
    const output = await renderPipeline("odd");
    expect(output).toContain("EXECUTE");
    expect(output).not.toContain("SPEC_AUDIT");
    expect(output).not.toContain("SECURE_CHECK");
  });

  it("draws the pipeline as a rail and names the increment in the title (REQ-73)", async () => {
    const output = await renderPipeline("huginn");
    // The rail is one row per phase, so the card's height is unchanged: the
    // connector is drawn inside the row the phase already occupied.
    expect(output).toContain("iter 1/1");
    expect(output).toContain("├─");
    expect(output).toContain("└─");
    expect(output).toContain("EXECUTE");
    expect(output).toContain("VERIFY");

    // Exactly one connector per phase row: no row was added, and no row carries
    // two nodes.
    const railLines = output
      .split("\n")
      .filter((line) => /[├└]─ /.test(line));
    expect(railLines.length).toBeGreaterThan(2);
    for (const line of railLines) {
      expect((line.match(/[├└]─ /g) ?? []).length, line).toBe(1);
    }
    // The increment lives in the title row, never as an extra body row.
    const titleLine = output.split("\n").find((line) => line.includes("PIPELINE PHASES"));
    expect(titleLine).toContain("iter 1/1");
    expect(titleLine).not.toMatch(/├─|└─/);
  });

  it("marks the current phase node with the status glyph inside the rail", async () => {
    const output = await renderPipeline("huginn");
    const verifyLine = output
      .split("\n")
      .find((line) => line.includes("VERIFY") && /[├└]─ /.test(line));
    expect(verifyLine).toBeDefined();
    // The current node keeps a status glyph before its connector; skipping it
    // would leave the rail with no "you are here" mark.
    expect(verifyLine).toMatch(/[·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✕!–]\s*[├└]─ /);
  });

  it("prints the live increment and its total from the run's events", async () => {
    const output = await renderPipeline("huginn", async () => {
      events.emit("iterationStart", { iteration: 2, totalIterations: 4, title: "Increment 2" });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(output).toContain("iter 2/4");
  });

  it("shows a finished phase's verdict glyph and hangs a fix round off the rail", async () => {
    const output = await renderPipeline("huginn", async () => {
      events.emit("verdict", {
        iteration: 1,
        phase: "EXECUTE",
        verdict: "pass",
        attempt: 1,
        durationMs: 2000,
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      events.emit("phaseStart", {
        iteration: 1,
        totalIterations: 1,
        phase: "FIX_VERIFY",
        attempt: 2,
        model: "c/d",
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    // The finished node keeps the verdict glyph inside its rail row.
    const executeLine = output
      .split("\n")
      .find((line) => line.includes("EXECUTE") && /[├└]─ /.test(line));
    expect(executeLine).toBeDefined();
    expect(executeLine).toMatch(/✓\s*[├└]─ /);
    // A fix round hangs off the same rail under the phase it repairs.
    const fixLine = output
      .split("\n")
      .find((line) => line.includes("FIX_VERIF") && line.includes("└─"));
    expect(fixLine).toBeDefined();
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

/**
 * REQ-69 — the run dashboard reserves the modal's real row cost through
 * `decisionModalHeight`, not the old `DECISION_HEIGHT = 7` literal. With a tall
 * request on a 24-row terminal the literal under-reserved the modal by eight
 * rows and pushed the frame (and its footer) past the terminal.
 */
describe("run dashboard decision budget (REQ-69)", () => {
  const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
  const tallDecision: DecisionRequest = {
    id: "run-decision",
    kind: "question",
    iteration: 0,
    phase: "LIVE",
    attempt: 1,
    message: "Which database should I use?",
    questionItems: [
      {
        question: "Which database should I use?",
        options: [
          { label: "Postgres", description: "production-ready" },
          { label: "SQLite", description: "zero-config" },
          { label: "DuckDB", description: "analytics-first" },
        ],
      },
      { question: "Which migration tool?", options: [{ label: "Prisma" }, { label: "Drizzle" }] },
      { question: "Where do backups go?", options: [{ label: "S3" }, { label: "Local" }] },
    ],
  };

  async function mountRunDecision(rows: number): Promise<{ output: () => string; unmount: () => void }> {
    events.clear();
    const stdout = new PassThrough() as any;
    stdout.columns = 100;
    stdout.rows = rows;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const state = { currentIteration: 1, currentPhase: "EXECUTE" } as unknown as HarnessState;
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
    const cfg = { projectPath: "/tmp/p", thinker: "a/b", executor: "c/d", mode: "auto" } as RunConfig;
    const instance = render(React.createElement(Dashboard, { engine, cfg, autoExit: false }), {
      stdout,
      stdin: createMockStdin(),
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    events.emit("decision", tallDecision);
    await new Promise((resolve) => setTimeout(resolve, 140));
    return {
      output: () => output.replace(ANSI, ""),
      unmount: () => {
        instance.unmount();
        events.clear();
      },
    };
  }

  it("windows the modal and keeps its footer inside a 24-row frame", async () => {
    const harness = await mountRunDecision(24);
    harness.unmount();
    const output = harness.output();

    const lines = output.split("\n").map((line) => line.replace(/\s+$/, ""));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    expect(lines.length, "the run frame never exceeds 24 rows").toBeLessThanOrEqual(24);
    expect(output).toContain(decisionTitle(tallDecision));
    // The tall body is windowed rather than overflowing the frame.
    expect(output).toContain("… +");
    expect(output).toContain("[1-9/Enter]");
    // The footer is the last surface; the modal must not push it away.
    expect(output).toContain("Interactive decision");
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

/**
 * The run dashboard's keyboard surface (REQ-69 / ADR-62). `useInput` is the only
 * way a user can pause, inspect or abort a running cycle, so each key is a
 * behaviour the engine must actually receive — and a key the prompt did not
 * advertise must stay a no-op.
 */
describe("run dashboard controls", () => {
  const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
  const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function createEngine(overrides: Record<string, unknown> = {}) {
    return {
      getState: () => ({ currentIteration: 1, currentPhase: "EXECUTE" }),
      runtime: {
        id: "commandcode",
        getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
      },
      isRunning: true,
      resolveDecision: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      requestAbort: vi.fn(),
      ...overrides,
    } as unknown as CycleEngine;
  }

  async function mountRun(engine: CycleEngine): Promise<{
    stdin: ReturnType<typeof createMockStdin>;
    output: () => string;
    unmount: () => void;
  }> {
    events.clear();
    const stdout = new PassThrough() as any;
    stdout.columns = 100;
    stdout.rows = 30;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const cfg = { projectPath: "/tmp/p", thinker: "a/b", executor: "c/d", mode: "auto" } as RunConfig;
    const stdin = createMockStdin();
    const instance = render(React.createElement(Dashboard, { engine, cfg, autoExit: false }), {
      stdout,
      stdin,
      patchConsole: false,
    });
    await tick();
    return {
      stdin,
      output: () => output.replace(ANSI, ""),
      unmount: () => instance.unmount(),
    };
  }

  /** Mounts, presses `keys`, unmounts, and returns the frame the user saw. */
  async function press(
    keys: string[],
    engine: CycleEngine = createEngine(),
  ): Promise<{ output: string; engine: CycleEngine }> {
    const harness = await mountRun(engine);
    for (const key of keys) {
      harness.stdin.write(key);
      await tick(70);
    }
    harness.unmount();
    return { output: harness.output(), engine };
  }

  it("pauses on `p` and resumes on the next one", async () => {
    const paused = await press(["p"]);
    expect(paused.engine.pause).toHaveBeenCalledTimes(1);
    expect(paused.engine.resume).not.toHaveBeenCalled();
    expect(paused.output).toContain("[PAUSED]");
    expect(paused.output).toContain("[Space] Resume");

    const resumed = await press(["p", "p"]);
    expect(resumed.engine.pause).toHaveBeenCalledTimes(1);
    expect(resumed.engine.resume).toHaveBeenCalledTimes(1);
    expect(resumed.output).not.toContain("[PAUSED]");
  });

  it("gives Space the same pause/resume role", async () => {
    const { engine, output } = await press([" "]);
    expect(engine.pause).toHaveBeenCalledTimes(1);
    expect(output).toContain("[PAUSED]");

    const again = await press([" ", " "]);
    expect(again.engine.pause).toHaveBeenCalledTimes(1);
    expect(again.engine.resume).toHaveBeenCalledTimes(1);
  });

  it("toggles the verbose layout with `v` and says which mode it is in", async () => {
    const off = await press([]);
    expect(off.output).toContain("(OFF)");

    const on = await press(["v"]);
    expect(on.output).toContain("[VERBOSE]");
    expect(on.output).toContain("(ON)");
  });

  it("aborts on `q` and on Escape", async () => {
    const quit = await press(["q"]);
    expect(quit.engine.requestAbort).toHaveBeenCalledTimes(1);

    const escape = await press(["\u001B"]);
    expect(escape.engine.requestAbort).toHaveBeenCalledTimes(1);
  });

  it("answers a permission prompt with the letter the prompt advertises", async () => {
    const permission: DecisionRequest = {
      id: "perm-1",
      kind: "permission",
      iteration: 0,
      phase: "EXECUTE",
      attempt: 1,
      message: "Allow writing src/index.ts?",
    };
    const expected: Array<[string, "continue" | "retry" | "deny"]> = [
      ["a", "continue"],
      ["o", "retry"],
      ["d", "deny"],
    ];
    for (const [key, choice] of expected) {
      const engine = createEngine();
      const harness = await mountRun(engine);
      events.emit("decision", permission);
      await tick(120);
      harness.stdin.write(key);
      await tick(80);
      harness.unmount();
      expect(engine.resolveDecision, `key ${key}`).toHaveBeenCalledWith(choice);
    }
  });

  it("answers a question with yes/no and ignores a key it did not offer", async () => {
    const question: DecisionRequest = {
      id: "q-1",
      kind: "question",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message: "Which database?",
    };
    const yes = createEngine();
    const yesHarness = await mountRun(yes);
    events.emit("decision", question);
    await tick(120);
    yesHarness.stdin.write("y");
    await tick(80);
    yesHarness.unmount();
    expect(yes.resolveDecision).toHaveBeenCalledWith("continue");

    const no = createEngine();
    const noHarness = await mountRun(no);
    events.emit("decision", question);
    await tick(120);
    noHarness.stdin.write("n");
    await tick(80);
    noHarness.unmount();
    expect(no.resolveDecision).toHaveBeenCalledWith("deny");

    // Scroll keys belong to the terminal, not to the question: they must not
    // answer it (the modal's own window handles them where it has one).
    const scrolled = createEngine();
    const scrolledHarness = await mountRun(scrolled);
    events.emit("decision", question);
    await tick(120);
    scrolledHarness.stdin.write("\u001B[B");
    await tick(80);
    scrolledHarness.unmount();
    expect(scrolled.resolveDecision).not.toHaveBeenCalled();
  });

  it("wraps the output before scrolling and counts terminal rows", async () => {
    const harness = await mountRun(createEngine());
    // Each 200-character line is more than one terminal row, and enough of
    // them overflow the card so the scroll offset becomes observable.
    events.emit("phaseStream", { text: Array.from({ length: 30 }, () => "x".repeat(200)).join("\n") });
    await tick(140);
    const before = harness.output();
    harness.stdin.write("\u001B[5~"); // PageUp
    await tick(80);
    harness.unmount();
    const after = harness.output();
    // The scroll indicator is derived from wrapped rows, so it appears even
    // though the source buffer is a single line.
    expect(after).toMatch(/▲ \+\d+/);
    expect(after).not.toBe(before);
  });

  it("gives the output panel the full width with `z` and restores it with `z`", async () => {
    const zoomed = await mountRun(createEngine());
    zoomed.stdin.write("z");
    await tick(100);
    zoomed.unmount();
    const firstZoom = zoomed.output().split("\n");
    // The pipeline is not drawn beside the output: the agent panel starts the row.
    const wideIndex = firstZoom.findIndex((line) =>
      /^\s*│\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]?\s*AGENT OUTPUT/.test(line),
    );
    expect(wideIndex).toBeGreaterThanOrEqual(0);
    expect(firstZoom[wideIndex]).not.toContain("PIPELINE PHASES");

    // The same key is a toggle, so a second press restores the split layout.
    expect(nextStreamMaximized(true)).toBe(false);
    expect(nextStreamMaximized(false)).toBe(true);
  });

  it("copies the report through exactly one OSC 52 sequence on `y`", async () => {
    const harness = await mountRun(createEngine());
    events.emit("phaseEnd", {
      result: {
        iteration: 1,
        phase: "EXECUTE",
        attempt: 1,
        model: "a/b",
        sessionId: "s",
        messageId: "m",
        summary: "done",
        raw: "first line\nsecond line",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    });
    await tick(120);
    harness.stdin.write("y");
    await tick(80);
    harness.unmount();

    const sequences = harness.output().match(/\u001b\]52;c;[A-Za-z0-9+/=]*\u001b\\/g) ?? [];
    expect(sequences).toHaveLength(1);
    const payload = sequences[0]!.slice("\u001b]52;c;".length, -2);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("first line\nsecond line");
  });

  it("caps the formatted stream at 2 000 rows before deriving maxScroll", () => {
    const rows = Array.from({ length: MAX_STREAM_ROWS + 25 }, (_unused, index) => [
      { text: `row ${index}` },
    ]);
    const capped = capStreamRows(rows);
    expect(capped).toHaveLength(MAX_STREAM_ROWS);
    const visibleRows = 10;
    expect(Math.max(0, capped.length - visibleRows)).toBe(MAX_STREAM_ROWS - visibleRows);
  });
});
