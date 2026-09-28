import React from "react";
import { PassThrough } from "node:stream";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";
import { LiveApp } from "../../src/tui/LiveDashboard";
import { patchConsole, unpatchConsole } from "../../src/tui/render";
import {
  EMPTY_CHAT_HINTS,
  FEEDBACK_BUSY,
  FEEDBACK_OK,
  FEEDBACK_PREFIXES,
  FEEDBACK_WARN,
  NEXT_STEP,
  busyFeedback,
  causeText,
  configSaveStep,
  emptyChatHints,
  failureFeedback,
  failureHeadline,
  hasFeedbackPrefix,
  okFeedback,
  warnFeedback,
} from "../../src/tui/feedback.js";

const ESC = "\u001b";

describe("feedback copy (REQ-31 / AC-31.1, AC-31.2)", () => {
  it("prefixes every acknowledgement with one of the three feedback marks", () => {
    expect(okFeedback("Saved.")).toBe("✓ Saved.");
    expect(warnFeedback("Careful.")).toBe("⚠ Careful.");
    expect(busyFeedback("Working…")).toBe("… Working…");
    expect(FEEDBACK_PREFIXES).toEqual([FEEDBACK_OK, FEEDBACK_WARN, FEEDBACK_BUSY]);
    for (const text of [okFeedback("a"), warnFeedback("b"), busyFeedback("c")]) {
      expect(hasFeedbackPrefix(text)).toBe(true);
    }
    expect(hasFeedbackPrefix("plain old message")).toBe(false);
  });

  it("strips terminal control sequences from every message it composes", () => {
    expect(okFeedback(`done ${ESC}[31mred${ESC}[0m`)).toBe("✓ done red");
    expect(warnFeedback(`bad ${ESC}[2J${ESC}[H`)).toBe("⚠ bad ");
    expect(causeText(new Error(`${ESC}[31mboom${ESC}[0m`))).toBe("boom");
    expect(causeText(undefined)).toBe("");
    expect(causeText("plain failure")).toBe("plain failure");
  });

  it("leads a failure with the component and the next step, and keeps the cause as detail", () => {
    const message = failureFeedback("Runtime switch failed", NEXT_STEP.runtimeSwitch, new Error("binary not found"));
    const [headline, cause] = message.split("\n");
    expect(headline).toBe("⚠ Runtime switch failed — run `/agent` to list the runtimes, then `/agent <id>` to switch");
    expect(cause).toBe("  cause: binary not found");
    // The hint is on the first line, the cause never is.
    expect(headline).not.toContain("binary not found");
    // Without a cause the message stays a single actionable line.
    expect(failureFeedback("Diagnostics failed", NEXT_STEP.diagnostics)).toBe(
      "⚠ Diagnostics failed — run `/mcp` to inspect the runtime and its servers, then retry `/status`",
    );
  });

  it("names where it tried to write when a config write fails", () => {
    const hint = configSaveStep("/proj/.huginn/config.json");
    expect(hint).toContain("/proj/.huginn/config.json");
    expect(hint).toContain("retry /model");
    expect(failureHeadline("Model settings were not saved", hint)).toBe(
      "Model settings were not saved — could not write /proj/.huginn/config.json: " +
        'check permissions, then retry /model (choose "Session Only" to keep the change in memory)',
    );
    // `failureHeadline` carries no glyph: surfaces with their own ⚠ add it.
    expect(failureHeadline("x", "y")).not.toMatch(/^[✓⚠…]/);
  });

  it("mentions the model, runtime and MCP commands in the relevant hints (AC-31.2)", () => {
    expect(NEXT_STEP.modelSelection).toContain("/model <id>");
    expect(NEXT_STEP.runtimeSwitch).toContain("/agent");
    expect(NEXT_STEP.mcp).toContain("/mcp");
    expect(NEXT_STEP.diagnostics).toContain("/mcp");
    expect(NEXT_STEP.session).toContain("/model <id>");
    expect(NEXT_STEP.session).toContain("/agent <id>");
  });

  it("keeps the first-run hints short enough to fit the card at 80 columns", () => {
    expect(EMPTY_CHAT_HINTS.length).toBeGreaterThan(0);
    expect(EMPTY_CHAT_HINTS.length).toBeLessThanOrEqual(6);
    const joined = EMPTY_CHAT_HINTS.join("\n");
    // AC-31.3: the palette, the draft flow, the MCP inspector and diagnostics.
    expect(joined).toContain("command palette");
    expect(joined).toContain("/draft");
    expect(joined).toContain("/mcp");
    expect(joined).toContain("/status");
    // Raven identity (REQ-29).
    expect(EMPTY_CHAT_HINTS[0]).toContain("Huginn");
    expect(joined).toContain("Muninn");
    for (const line of EMPTY_CHAT_HINTS) {
      // The chat card has 74 usable columns at 80; leave room for the border.
      expect(line.length, line).toBeLessThanOrEqual(72);
      expect(line).not.toContain("\n");
    }
  });

  it("bounds the hints to the rows a card actually has", () => {
    expect(emptyChatHints(0)).toEqual([]);
    expect(emptyChatHints(-3)).toEqual([]);
    expect(emptyChatHints(2)).toEqual(EMPTY_CHAT_HINTS.slice(0, 2));
    expect(emptyChatHints(99)).toHaveLength(EMPTY_CHAT_HINTS.length);
  });
});

// ── AC-31.4: nothing may bypass the alternate-screen log buffer ───────────────

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

function createMockLive(): LiveEngine {
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
      thinkerModel: mockCfg.thinker,
      executorModel: mockCfg.executor,
      memoryStats: { entitiesCount: 0, observationsCount: 0 },
    }),
  } as unknown as LiveEngine;
}

/** Mount the live console on a PassThrough harness (no TTY, no alt screen). */
async function mountTui(): Promise<{ output: () => string; unmount: () => void }> {
  const stdout = new PassThrough() as unknown as PassThrough & { columns: number; rows: number };
  stdout.columns = 120;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const instance = render(React.createElement(LiveApp, { live: createMockLive(), cfg: mockCfg }), {
    stdout,
    stdin: createMockStdin(),
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, 80));
  return { output: () => output, unmount: () => instance.unmount() };
}

describe("TUI stdout hygiene (AC-31.4)", () => {
  afterEach(() => {
    events.clear();
    unpatchConsole();
  });

  it("keeps every TUI module free of direct console/stdout writes", () => {
    const root = new URL("../../src/tui", import.meta.url).pathname;
    // `render.tsx` *is* the interception layer (AC-21.3): it patches console and
    // writes the alternate-screen controls, which must not go through console.
    const interceptor = "render.tsx";
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name === interceptor) continue;
        const source = readFileSync(full, "utf8");
        if (/(^|[^.\w$])console\s*\.\s*(log|warn|error|info|debug)\s*\(/.test(source)) {
          offenders.push(`${full} (console call)`);
        }
        if (/process\s*\.\s*(stdout|stderr)\s*\.\s*write\s*\(/.test(source)) {
          offenders.push(`${full} (raw stdout/stderr write)`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);

    // The one module allowed to touch console must install the full patch.
    const source = readFileSync(join(root, interceptor), "utf8");
    expect(source).toMatch(/console\s*\.\s*log\s*=\s*createInterceptor/);
    expect(source).toMatch(/console\s*\.\s*warn\s*=\s*createInterceptor/);
    expect(source).toMatch(/console\s*\.\s*error\s*=\s*createInterceptor/);
  });

  it("routes console output into the in-frame log buffer instead of stdout while mounted", async () => {
    const rawWrites: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      rawWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    patchConsole();
    const tui = await mountTui();
    try {
      console.log("leak-probe-42");
      console.warn("warn-probe-42");
      await new Promise((r) => setTimeout(r, 60));

      // Nothing reached the real stdout while the TUI is mounted (AC-31.4)…
      expect(rawWrites.join("")).not.toContain("leak-probe-42");
      expect(rawWrites.join("")).not.toContain("warn-probe-42");
      // …the alternate-screen log buffer received it…
      expect(events.getRecentLogs().some((entry) => entry.message.includes("leak-probe-42"))).toBe(true);
    } finally {
      // Ink flushes its last frame on unmount in this non-TTY harness.
      tui.unmount();
      unpatchConsole();
      process.stdout.write = originalWrite;
    }

    // …and the log buffer is where it becomes visible, inside the frame: the
    // SYSTEM LOGS card shows the tail (this harness terminal is 24 rows, so only
    // the most recent entry is on screen).
    expect(tui.output()).toContain("SYSTEM LOGS");
    expect(tui.output()).toContain("warn-probe-42");
  });
});
