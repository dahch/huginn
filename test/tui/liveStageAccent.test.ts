/**
 * REQ-73 / ADR-69 — the conversation card is tinted with the *active stage's*
 * token while a turn is in flight, so the loudest surface names the work that is
 * actually running instead of the generic accent.
 *
 * Ink freezes chalk's colour level on first import, so the palette and the app
 * are imported dynamically after `vi.resetModules()` — a static `import "ink"`
 * would make every assertion here depend on the terminal that ran the suite.
 */
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Type one key at a time: Ink reads raw-mode chunks, not a whole typed word. */
async function type(stdin: PassThrough, text: string): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  stdin.write("\r");
  await tick(80);
}

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "opencode/gpt-5.1-codex",
  cwd: "/mock/project",
} as unknown as Record<string, unknown>;

/** The dark palette's escapes: accent = cyan, executor = green. */
const ANSI_CYAN = "\u001b[36m";
const ANSI_GREEN = "\u001b[32m";

describe("busy conversation accent (REQ-73)", () => {
  afterEach(() => {
    delete process.env.FORCE_COLOR;
    delete process.env.HUGINN_THEME;
    delete process.env.NO_COLOR;
    vi.resetModules();
  });

  async function mountBusy(): Promise<{
    stdin: PassThrough;
    output: () => string;
    events: { emit: (event: "liveStage", payload: { stage: "execute" }) => void };
    unmount: () => void;
  }> {
    vi.resetModules();
    process.env.FORCE_COLOR = "1";
    process.env.HUGINN_THEME = "dark";
    delete process.env.NO_COLOR;

    const React = (await import("react")).default;
    const { render } = await import("./inkRender");
    const { LiveApp } = await import("../../src/tui/LiveDashboard");
    const { events } = await import("../../src/engine/engineEvents");

    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 100;
    stdout.rows = 36;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const live = {
      cfg: mockCfg,
      runtime: {
        name: "opencode",
        id: "opencode",
        capabilities: { streaming: true, systemPrompts: true, tools: true },
        getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
      },
      models: { thinker: mockCfg.thinker as string, executor: mockCfg.executor as string },
      currentStage: "refine",
      ideaText: "",
      getTranscript: () => [],
      getResumePoint: () => undefined,
      clearTranscript: () => {},
      start: async () => {},
      // Never resolves: the turn stays in flight for the whole assertion.
      chat: vi.fn(() => new Promise<void>(() => {})),
      draft: async () => "aborted",
      approvePlan: async () => {},
      requestAbort: () => {},
      resolveDecision: () => {},
      updateModels: () => {},
      switchRuntime: vi.fn(),
      getDiagnostics: async () => ({
        gitBranch: "main",
        gitClean: true,
        worktreeSandbox: false,
        runtimeName: "opencode",
        thinkerModel: mockCfg.thinker as string,
        executorModel: mockCfg.executor as string,
        memoryStats: { entitiesCount: 0, observationsCount: 0 },
      }),
    };

    const stdin = createMockStdin();
    const instance = render(
      React.createElement(LiveApp, { live: live as never, cfg: mockCfg as never }),
      { stdout, stdin, patchConsole: false },
    );
    await tick();
    return {
      stdin,
      output: () => output,
      events,
      unmount: () => instance.unmount(),
    };
  }

  it("tints the primary card with the active stage's token while busy", async () => {
    const harness = await mountBusy();
    await type(harness.stdin, "hello");
    // A stage change while the turn is still in flight must repaint the card.
    harness.events.emit("liveStage", { stage: "execute" });
    await tick(120);
    harness.unmount();

    const conversationLines = harness
      .output()
      .split("\n")
      .filter((line) => line.includes("Conversation"));
    expect(conversationLines.length).toBeGreaterThan(0);
    // `executor` in the dark palette is green; the idle accent is cyan (covered
    // by the next test), so this can only come from the stage token the busy
    // card was handed.
    expect(conversationLines.some((line) => line.includes(ANSI_GREEN))).toBe(true);
  });

  it("keeps the idle card on the generic accent, not a stage token", async () => {
    const harness = await mountBusy();
    harness.unmount();

    const conversationLines = harness
      .output()
      .split("\n")
      .filter((line) => line.includes("Conversation"));
    expect(conversationLines.some((line) => line.includes(ANSI_CYAN))).toBe(true);
    expect(conversationLines.some((line) => line.includes(ANSI_GREEN))).toBe(false);
  });
});
