import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./inkRender";
import { events } from "../../src/engine/engineEvents";
import type { DiagnosticsInfo, LiveEngine, TranscriptTurn } from "../../src/engine/liveMode";
import type { RunConfig } from "../../src/config";
import { LiveApp } from "../../src/tui/LiveDashboard";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

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

/** What the last frame actually paints, ANSI stripped. */
function visibleText(output: string): string {
  return output.replace(ANSI, "");
}

/** Every OSC 52 clipboard sequence written to the harness's output stream. */
function osc52Sequences(output: string): string[] {
  return output.match(/\u001b\]52;c;[A-Za-z0-9+/=]*\u001b\\/g) ?? [];
}

const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const diagnostics: DiagnosticsInfo = {
  gitBranch: "feature/transcript-nav",
  gitClean: true,
  worktreeSandbox: false,
  runtimeName: "opencode",
  thinkerModel: "anthropic/claude-3-7-sonnet",
  executorModel: "opencode/gpt-5.1-codex",
  memoryStats: { entitiesCount: 0, observationsCount: 0 },
};

const mockCfg = {
  projectPath: "/mock/project",
  port: 4096,
  thinker: "anthropic/claude-3-7-sonnet",
  executor: "opencode/gpt-5.1-codex",
  cwd: "/mock/project",
} as unknown as RunConfig;

function createMockLive(transcript: TranscriptTurn[] = []): LiveEngine {
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
    getTranscript: vi.fn().mockReturnValue(transcript),
    getResumePoint: vi.fn().mockReturnValue(undefined),
    clearTranscript: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn().mockResolvedValue(undefined),
    draft: vi.fn().mockResolvedValue("aborted"),
    approvePlan: vi.fn().mockResolvedValue(undefined),
    requestAbort: vi.fn(),
    resolveDecision: vi.fn(),
    updateModels: vi.fn(),
    switchRuntime: vi.fn(),
    getDiagnostics: vi.fn().mockResolvedValue(diagnostics),
  } as unknown as LiveEngine;
}

interface Harness {
  stdin: PassThrough;
  output: () => string;
  unmount: () => void;
}

async function mountLive(live: LiveEngine, columns = 100, rows = 30): Promise<Harness> {
  const restore = stubTerminalSize(rows, columns);
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
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

/** Presses one key (or writes one paste) and lets Ink flush it. */
async function press(harness: Harness, key: string, ms = 60): Promise<void> {
  harness.stdin.write(key);
  await tick(ms);
}

/** Types printable text one character at a time, like a human. */
async function type(harness: Harness, text: string): Promise<void> {
  for (const char of text) {
    harness.stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  await tick();
}

/** A conversation long enough that its first and last message cannot share a frame. */
function longTranscript(): TranscriptTurn[] {
  return Array.from({ length: 40 }, (_, index) => [
    { role: "user" as const, text: `question-${String(index).padStart(2, "0")}` },
    { role: "assistant" as const, text: `answer-${String(index).padStart(2, "0")}` },
  ]).flat();
}

describe("transcript navigation keys (REQ-72 / AC-72.1)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.restoreAllMocks();
  });

  it("g / G jump to the start / end of the focused conversation", async () => {
    const top = await mountLive(createMockLive(longTranscript()));
    await press(top, "\t"); // composer → conversation
    await press(top, "g");
    top.unmount();
    expect(visibleText(top.output())).toContain("question-00");
    expect(visibleText(top.output())).toMatch(/▲ \+\d+ up/);

    const bottom = await mountLive(createMockLive(longTranscript()));
    await press(bottom, "\t");
    await press(bottom, "g");
    await press(bottom, "G");
    bottom.unmount();
    expect(visibleText(bottom.output())).toContain("answer-39");
    expect(visibleText(bottom.output())).not.toMatch(/▲ \+\d+ up/);
  });

  it("g / G jump the focused agent stream too", async () => {
    const lines = Array.from(
      { length: 80 },
      (_, index) => `stream-line-${String(index).padStart(2, "0")}`,
    ).join("\n");

    const top = await mountLive(createMockLive());
    events.emit("phaseStream", { text: lines });
    await tick(140);
    await press(top, "\t"); // conversation
    await press(top, "\t"); // stream
    await press(top, "g");
    top.unmount();
    expect(visibleText(top.output())).toContain("stream-line-00");

    const bottom = await mountLive(createMockLive());
    events.emit("phaseStream", { text: lines });
    await tick(140);
    await press(bottom, "\t");
    await press(bottom, "\t");
    await press(bottom, "G");
    bottom.unmount();
    expect(visibleText(bottom.output())).toContain("stream-line-79");
  });

  it("keeps g and G as ordinary draft letters in the composer", async () => {
    const h = await mountLive(createMockLive(longTranscript()));
    await press(h, "g");
    await press(h, "G");
    h.unmount();
    expect(visibleText(h.output())).toContain("❯ gG");
  });
});

describe("transcript search (Ctrl+F, REQ-72 / AC-72.2)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.restoreAllMocks();
  });

  const searchable: TranscriptTurn[] = [
    { role: "user", text: "alpha needle one" },
    { role: "assistant", text: "first answer" },
    { role: "assistant", text: "second NEEDLE answer" },
  ];

  /** Opens search and types `query`; returns the mounted harness (still open). */
  async function openSearch(query: string, columns = 100): Promise<Harness> {
    const h = await mountLive(createMockLive(searchable), columns);
    await press(h, "\u0006"); // Ctrl+F
    await type(h, query);
    return h;
  }

  it("shows find mode with the match count while typing", async () => {
    const h = await openSearch("needle");
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("find ❯ needle");
    expect(output).toContain("match 1/2");
  });

  it("opens from any focus and restores the draft with Esc", async () => {
    const h = await mountLive(createMockLive(searchable));
    await type(h, "hello draft");
    await press(h, "\t"); // conversation focus must not block Ctrl+F
    await press(h, "\u0006");
    await type(h, "needle");
    await press(h, "\u001B"); // Esc
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("❯ hello draft");
    expect(output).toContain("Conversation ● [Focused]");
    expect(output).not.toContain("find ❯");
    expect(output).not.toContain("match 1/2");
  });

  it("moves between matches with ↑ / ↓", async () => {
    const h = await openSearch("needle");
    await press(h, "\u001B[B"); // ↓
    h.unmount();
    expect(visibleText(h.output())).toContain("match 2/2");
  });

  it("Enter jumps to the selected message and closes the search", async () => {
    const turns: TranscriptTurn[] = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: index === 10 ? "deep needle target" : `filler-${String(index).padStart(2, "0")}`,
    }));
    const h = await mountLive(createMockLive(turns));
    await press(h, "\u0006");
    await type(h, "needle");
    await press(h, "\r");
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("deep needle target");
    expect(output).toMatch(/▲ \+\d+ up/);
    expect(output).not.toContain("find ❯");
  });

  it("keeps a plain slash draft from opening the palette while searching", async () => {
    const h = await mountLive(createMockLive(searchable));
    await type(h, "/");
    await press(h, "\u0006");
    await type(h, "second");
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("find ❯ second");
    expect(output).toContain("match 1/1");
    // The palette's own footer hint must not be the row the frame shows.
    expect(output).not.toContain("[Tab] Accept");
  });
});

describe("copy the last assistant message (y, REQ-72 / AC-72.5)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.restoreAllMocks();
  });

  it("copies through OSC 52 and emits exactly one honest system notice", async () => {
    const h = await mountLive(
      createMockLive([{ role: "assistant", text: "Hello there, raven." }]),
      160,
    );
    await press(h, "\t"); // composer → conversation
    await press(h, "y");
    h.unmount();

    const output = visibleText(h.output());
    expect(output).toContain("✓ Copied 19 chars (OSC 52 — some terminals ignore it)");
    expect(output.match(/OSC 52/g)).toHaveLength(1);

    const sequences = osc52Sequences(h.output());
    expect(sequences).toHaveLength(1);
    const payload = sequences[0]!.slice("\u001b]52;c;".length, -2);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("Hello there, raven.");
  });

  it("keeps y as ordinary draft text in the composer", async () => {
    const h = await mountLive(createMockLive([{ role: "assistant", text: "Hello" }]), 160);
    await press(h, "y");
    h.unmount();

    expect(visibleText(h.output())).toContain("❯ y");
    expect(osc52Sequences(h.output())).toHaveLength(0);
  });

  it("warns instead of crashing when there is nothing to copy", async () => {
    const h = await mountLive(createMockLive([{ role: "user", text: "a question" }]), 160);
    await press(h, "\t");
    await press(h, "y");
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("! Nothing to copy yet");
    expect(output).toContain("no assistant message in the conversation.");
  });
});

// Ink flushes the last frame when the instance unmounts, so every assertion
// below reads `h.output()` *after* `h.unmount()` — the same contract the
// existing cases in this file rely on.
describe("transcript search — closing, empty results and modifiers (REQ-72 / AC-72.2 / AC-72.3)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.restoreAllMocks();
  });

  const searchable: TranscriptTurn[] = [
    { role: "user", text: "alpha needle one" },
    { role: "assistant", text: "first answer" },
    { role: "assistant", text: "second NEEDLE answer" },
  ];

  /** Opens search and types `query`, then returns the still-open output. */
  async function searchOutput(query: string, keys: string[] = []): Promise<string> {
    const h = await mountLive(createMockLive(searchable));
    await press(h, "\u0006"); // Ctrl+F
    await type(h, query);
    for (const key of keys) await press(h, key);
    h.unmount();
    return visibleText(h.output());
  }

  it("closes with Ctrl+F again, restoring the draft like Esc does", async () => {
    const h = await mountLive(createMockLive(searchable));
    await type(h, "keep me");
    await press(h, "\u0006"); // Ctrl+F
    await type(h, "needle");
    await press(h, "\u0006"); // Ctrl+F again
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("❯ keep me");
    expect(output).not.toContain("find ❯");
    expect(output).not.toContain("match 1/2");
  });

  it("opens while a turn is busy, because a long transcript is searched mid-turn", async () => {
    let resolveChat: (() => void) | undefined;
    const chatPromise = new Promise<void>((resolve) => {
      resolveChat = resolve;
    });
    const live = createMockLive(searchable);
    (live.chat as unknown as { mockImplementation: (fn: () => Promise<void>) => void }).mockImplementation(
      () => chatPromise,
    );
    const h = await mountLive(live);
    await type(h, "hello");
    await press(h, "\r"); // submit → busy, the composer is disabled
    await press(h, "\u0006");
    await type(h, "needle");
    h.unmount();
    resolveChat?.();

    const output = visibleText(h.output());
    expect(output).toContain("find ❯ needle");
    expect(output).toContain("match 1/2");
    expect(output).toContain("2 matches");
  });

  it("edits the query with backspace and rewinds the selection to the first hit", async () => {
    // ↓ selects the second hit; Backspace must both shorten the query and reset
    // the position, so the label cannot keep pointing at 2/2.
    expect(await searchOutput("needle", ["\u001B[B", "\u007F"])).toContain("match 1/2");
    const output = await searchOutput("needle", ["\u001B[B", "\u007F"]);
    expect(output).toContain("find ❯ needl");
  });

  it("wraps from the first match to the last with ↑ and back again", async () => {
    // With two matches, a clamped ↑ at index 0 would stay on 1/2; the wrap shows 2/2.
    expect(await searchOutput("needle", ["\u001B[A"])).toContain("match 2/2");
    expect(await searchOutput("needle", ["\u001B[A", "\u001B[A"])).toContain("match 1/2");
  });

  it("reports zero matches and prints no position label", async () => {
    const output = await searchOutput("zzzz");
    expect(output).toContain("0 matches");
    expect(output).not.toMatch(/match \d+\/\d+/);
  });

  it("closes on Enter without jumping when nothing matches", async () => {
    const turns: TranscriptTurn[] = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `filler-${String(index).padStart(2, "0")}`,
    }));
    const h = await mountLive(createMockLive(turns));
    await press(h, "\u0006");
    await type(h, "zzzz");
    await press(h, "\r");
    h.unmount();
    const output = visibleText(h.output());
    expect(output).not.toContain("find ❯");
    expect(output).not.toMatch(/▲ \+\d+ up/);
    expect(output).toContain("filler-59");
  });

  it("prints the position in the conversation card's own title (AC-72.3)", async () => {
    const h = await mountLive(createMockLive(searchable));
    await press(h, "\u0006");
    await type(h, "needle");
    await press(h, "\u001B[B"); // ↓ → 2/2
    h.unmount();
    const titleRow = visibleText(h.output())
      .split("\n")
      .findLast((line) => line.includes("Conversation"));
    expect(titleRow).toBeDefined();
    // The label belongs to the card's title row, not to the footer copy of it.
    expect(titleRow).toContain("match 2/2");
  });

  it("leaves the query open and unchanged when ↓ has no match to move to", async () => {
    const h = await mountLive(createMockLive(searchable));
    await press(h, "\u0006");
    await type(h, "zzzz");
    await press(h, "\u001B[B"); // ↓ with zero hits must not close or clear anything
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("find ❯ zzzz");
    expect(output).toContain("0 matches");
  });

  it("drops invisible characters instead of typing them into the query (SEC-001)", async () => {
    const h = await mountLive(createMockLive(searchable));
    await press(h, "\u0006");
    await type(h, "need");
    await press(h, "\u200B"); // zero-width space: no width, no content
    await press(h, "\u202E"); // right-to-left override: could reorder the row
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("find ❯ need");
    expect(output).not.toContain("\u200B");
    expect(output).not.toContain("\u202E");
  });

  it("keeps Ctrl chords out of the query", async () => {
    const h = await mountLive(createMockLive(searchable));
    await press(h, "\u0006");
    await type(h, "needle");
    await press(h, "\u0001"); // Ctrl+A must not become "a" in the query
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("find ❯ needle");
    expect(output).not.toContain("find ❯ needlea");
    expect(output).toContain("match 1/2");
  });

  it("finds and jumps to a system message too", async () => {
    const turns: TranscriptTurn[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `filler-${String(index).padStart(2, "0")}`,
    }));
    turns.splice(5, 0, { role: "system", text: "system needle target" });
    const h = await mountLive(createMockLive(turns));
    await press(h, "\u0006");
    await type(h, "needle");
    await press(h, "\r");
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("system needle target");
    expect(output).not.toContain("find ❯");
  });
});

describe("clipboard copy — channels and limits (REQ-72 / AC-72.5)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.restoreAllMocks();
  });

  it("copies the newest assistant message, not an earlier one", async () => {
    const h = await mountLive(
      createMockLive([
        { role: "assistant", text: "the old answer" },
        { role: "user", text: "and now?" },
        { role: "assistant", text: "the new answer" },
      ]),
      160,
    );
    await press(h, "\t"); // conversation focus
    await press(h, "y");
    h.unmount();

    const sequence = osc52Sequences(h.output())[0];
    expect(sequence).toBeDefined();
    const payload = sequence!.slice("\u001b]52;c;".length, -2);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("the new answer");
  });

  it("warns instead of writing an oversized payload", async () => {
    const h = await mountLive(
      createMockLive([{ role: "assistant", text: "a".repeat(100_001) }]),
      160,
    );
    await press(h, "\t");
    await press(h, "y");
    h.unmount();

    expect(osc52Sequences(h.output())).toHaveLength(0);
    const output = visibleText(h.output());
    expect(output).toContain("Clipboard payload too large — 100 KB max");
    expect(output).not.toContain("Copied");
  });

  it("strips terminal escapes before they reach the clipboard", async () => {
    const h = await mountLive(
      createMockLive([{ role: "assistant", text: "safe\u001b[31mred\u001b[0m tail" }]),
      160,
    );
    await press(h, "\t");
    await press(h, "y");
    h.unmount();

    const sequence = osc52Sequences(h.output())[0];
    expect(sequence).toBeDefined();
    const payload = sequence!.slice("\u001b]52;c;".length, -2);
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    expect(decoded).toBe("safered tail");
    expect(decoded).not.toContain("\u001b");
  });

  it("copies nothing from the agent stream and never types y into the draft", async () => {
    const h = await mountLive(createMockLive([{ role: "assistant", text: "Hello there" }]), 160);
    events.emit("phaseStream", { text: "stream line one\nstream line two" });
    await tick(140);
    await press(h, "\t"); // conversation
    await press(h, "\t"); // stream
    await press(h, "y");
    h.unmount();

    expect(osc52Sequences(h.output())).toHaveLength(0);
    const output = visibleText(h.output());
    expect(output).not.toContain("Copied");
    expect(output).not.toContain("❯ y");
  });
});

describe("modified navigation keys are chords, not jumps (REQ-72 / AC-72.1)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.restoreAllMocks();
  });

  it("does not jump when g / G arrive with Ctrl held", async () => {
    const h = await mountLive(createMockLive(longTranscript()));
    await press(h, "\t"); // conversation, parked at the bottom
    await press(h, "\u0007"); // Ctrl+G: a chord, never "jump to start"
    h.unmount();
    const output = visibleText(h.output());
    expect(output).toContain("answer-39");
    expect(output).not.toMatch(/▲ \+\d+ up/);
  });
});

// The abort prompt is the one place where a single key can end a paid-for
// session, so the two-step contract needs a test of its own: the first Esc only
// arms, any other key cancels the arming *and still acts as input*, and only a
// second Esc aborts. `confirmEsc` lives next to the transcript keys in the same
// `useInput`, which is why it is covered here rather than in the modal suites.
describe("two-step Esc abort (REQ-6)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
    vi.restoreAllMocks();
  });

  it("warns on the first Esc and never aborts on it", async () => {
    const live = createMockLive(longTranscript());
    const h = await mountLive(live);
    await press(h, "\u001B");
    h.unmount();
    expect(live.requestAbort).not.toHaveBeenCalled();
    expect(visibleText(h.output())).toContain("Press Esc again to abort");
  });

  it("cancels the arming on any other key, which still reaches the draft", async () => {
    const live = createMockLive(longTranscript());
    const h = await mountLive(live);
    await press(h, "\u001B"); // arm
    await press(h, "x"); // cancel — and `x` is ordinary input, not swallowed
    await press(h, "\u001B"); // must warn again instead of aborting
    h.unmount();
    const output = visibleText(h.output());
    expect(live.requestAbort).not.toHaveBeenCalled();
    expect(output).toContain("❯ x");
    expect(output.match(/Press Esc again to abort/g)).toHaveLength(2);
  });

  it("does not carry an armed Esc through search mode (Esc → Ctrl+F → Esc → Esc)", async () => {
    const live = createMockLive(longTranscript());
    const h = await mountLive(live);
    await press(h, "\u001B"); // arm
    await press(h, "\u0006"); // Ctrl+F opens search and cancels the arming
    await press(h, "\u001B"); // closes search; it is another consumed key
    await press(h, "\u001B"); // must warn again, never abort
    h.unmount();
    const output = visibleText(h.output());
    expect(live.requestAbort).not.toHaveBeenCalled();
    expect(output.match(/Press Esc again to abort/g)).toHaveLength(2);
  });

  it("aborts on the second consecutive Esc", async () => {
    const live = createMockLive(longTranscript());
    const h = await mountLive(live);
    await press(h, "\u001B");
    await press(h, "\u001B");
    h.unmount();
    expect(live.requestAbort).toHaveBeenCalledTimes(1);
  });
});
