import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsInfo, LiveEngine } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";

/**
 * REQ-72 / AC-72.4 — the search mode is advertised by the composer's border, not
 * only by its text: `Ctrl+F` repaints the box with `THEME.warn` so the user can
 * see at a glance that typing goes to a query and not into their draft. A
 * `borderColor` that is computed but never reaches `<Box>` would still pass a
 * text-only test, so this suite asserts the escape Ink actually emits.
 *
 * `FORCE_COLOR` must be visible to chalk *before* Ink is first imported, which
 * is why every module is imported dynamically after `vi.resetModules()` (the
 * same constraint `cardColors.test.ts` documents). The dark palette is pinned
 * with `HUGINN_THEME=dark`, where `warn` is `yellow` (SGR 33) and `borderFocus`
 * is `cyanBright` (SGR 96) — two names that can never be confused.
 */

const TICK = 80;

const tick = (ms = TICK): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createMockStdin(): PassThrough {
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

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "opencode/gpt-5.1-codex",
  cwd: "/mock/project",
} as unknown as RunConfig;

const diagnostics: DiagnosticsInfo = {
  gitBranch: "feature/transcript-search",
  gitClean: true,
  worktreeSandbox: false,
  runtimeName: "opencode",
  thinkerModel: "anthropic/claude-3-7-sonnet",
  executorModel: "opencode/gpt-5.1-codex",
  memoryStats: { entitiesCount: 0, observationsCount: 0 },
};

function mockLive(): LiveEngine {
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
    getTranscript: () => [
      { role: "user", text: "alpha needle one" },
      { role: "assistant", text: "second NEEDLE answer" },
    ],
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

interface ColoredHarness {
  stdin: PassThrough;
  output: () => string;
  unmount: () => void;
}

/** Mount the live console with colour forced on and the dark palette pinned. */
async function mountColored(): Promise<ColoredHarness> {
  vi.resetModules();
  process.env.FORCE_COLOR = "1";
  process.env.HUGINN_THEME = "dark";
  delete process.env.NO_COLOR;

  const React = (await import("react")).default;
  const { render } = await import("./inkRender");
  const { LiveApp } = await import("../../src/tui/LiveDashboard");

  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 100;
  stdout.rows = 30;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  const instance = render(React.createElement(LiveApp, { live: mockLive(), cfg: mockCfg }), {
    stdout,
    stdin,
    patchConsole: false,
  });
  await tick();
  return {
    stdin,
    output: () => output,
    unmount: () => instance.unmount(),
  };
}

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** What a frame row actually paints, escapes stripped. */
const visible = (text: string): string => text.replace(ANSI, "");

/** The colour escapes the composer row is painted with on the last frame. */
function composerRowColors(output: string, marker: string): { above: string; row: string } {
  const lines = output.split("\n");
  // The prompt and the draft are separate `<Text>` nodes, so every one of them
  // carries its own escape: the marker is matched on the *painted* row.
  const index = lines.findLastIndex((line) => visible(line).includes(marker));
  expect(index).toBeGreaterThan(0);
  return { above: lines[index - 1] ?? "", row: lines[index] ?? "" };
}

describe("transcript search paints the composer with THEME.warn (REQ-72 / AC-72.4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.FORCE_COLOR;
    delete process.env.HUGINN_THEME;
    delete process.env.NO_COLOR;
    vi.resetModules();
  });

  it("pins the two palette tokens this suite asserts", async () => {
    vi.resetModules();
    process.env.FORCE_COLOR = "1";
    process.env.HUGINN_THEME = "dark";
    const { THEME } = await import("../../src/tui/theme");
    expect(THEME.warn).toBe("yellow");
    expect(THEME.borderFocus).toBe("cyanBright");
  });

  it("draws the search composer's border with the warning colour", async () => {
    const h = await mountColored();
    h.stdin.write("\u0006"); // Ctrl+F
    await tick();
    for (const char of "needle") {
      h.stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    await tick();
    h.unmount();

    // The marker is the prompt *plus the query*: the footer also prints
    // `find ❯ `, and the assertion must land on the composer itself.
    const { above, row } = composerRowColors(h.output(), "find ❯ needle");
    // The border row above the prompt inherits the warn token, not the focus token.
    expect(above).toContain("\u001b[33m");
    expect(above).not.toContain("\u001b[96m");
  });

  it("keeps the ordinary focused composer on borderFocus, so the repaint is caused by search", async () => {
    const h = await mountColored();
    h.unmount();

    const { above, row } = composerRowColors(h.output(), "❯ Message");
    expect(row).not.toContain("find ❯ ");
    expect(above).toContain("\u001b[96m");
    expect(above).not.toContain("\u001b[33m");
  });
});
