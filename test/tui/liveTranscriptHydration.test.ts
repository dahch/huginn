/**
 * Phase 4D — the live conversation survives the cycle (REQ-2.3).
 *
 * Returning from a cycle swaps the cycle `Dashboard` back for `RefineView`, which
 * *unmounts* the latter: its React state (`messages`) is gone, and only the
 * engine's transcript outlives the remount. These tests mount the real `LiveApp`
 * on an engine stub whose transcript is the source of truth, and follow a whole
 * `/draft` → cycle → hand-back round trip, plus the `/clear` path that has to empty
 * the engine too (or the turns come straight back on the next remount).
 */
import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { LiveApp, isHydratedReplay } from "../../src/tui/LiveDashboard";
import { EMPTY_CHAT_HINTS } from "../../src/tui/feedback.js";
import { events } from "../../src/engine/engineEvents";
import type { LiveEngine, TranscriptTurn } from "../../src/engine/liveMode";
import type { CycleEngine } from "../../src/engine/cycle";
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

const tick = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Types a string and presses Enter, one key at a time (as a terminal would). */
async function submit(stdin: MockStdin, text: string): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick(12);
  }
  stdin.write("\r");
  await tick(80);
}

/** A cycle stub: enough for the `Dashboard` that takes over while it runs. */
function cycleStub(run: () => Promise<void>): CycleEngine {
  return {
    runtime: { name: "MockRuntime", id: "opencode" },
    getState: () => ({ currentIteration: 1, currentPhase: "EXECUTE" }),
    pause: vi.fn(),
    resume: vi.fn(),
    requestAbort: vi.fn(),
    resolveDecision: vi.fn(),
    run,
  } as unknown as CycleEngine;
}

interface Fake {
  live: LiveEngine;
  /** The engine's conversation: exactly what `getTranscript()` hands out. */
  transcript: TranscriptTurn[];
}

/**
 * An engine stub whose conversation is `transcript`. `getTranscript()` copies it,
 * like the real engine does, so the view cannot be hydrated by an aliased array;
 * `clearTranscript()` empties it in place, like the real one does.
 */
function createFakeLive(
  options: { transcript?: TranscriptTurn[]; run?: () => Promise<void> } = {},
): Fake {
  const transcript: TranscriptTurn[] = options.transcript ?? [];
  const live = {
    cfg: mockCfg,
    runtime: {
      name: "MockRuntime",
      id: "opencode",
      capabilities: { streaming: true, systemPrompts: true, tools: true },
    },
    models: { thinker: mockCfg.thinker, executor: mockCfg.executor },
    currentStage: "refine",
    ideaText: "",
    getTranscript: () => transcript.map((turn) => ({ ...turn })),
    clearTranscript: vi.fn(() => {
      transcript.length = 0;
    }),
    start: vi.fn().mockResolvedValue(undefined),
    chat: vi.fn().mockResolvedValue(undefined),
    draft: vi.fn().mockResolvedValue("approved"),
    execute: vi.fn().mockResolvedValue(cycleStub(options.run ?? (async () => {}))),
    // The post-cycle prompt: "return to live mode" is the branch under test.
    ask: vi.fn().mockResolvedValue("retry"),
    requestAbort: vi.fn(),
    resolveDecision: vi.fn(),
    updateModels: vi.fn(),
    switchRuntime: vi.fn(),
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
  return { live, transcript };
}

interface Harness {
  stdin: MockStdin;
  /**
   * What Ink wrote. This non-TTY harness flushes the frame on `unmount()`, so the
   * buffer is only meaningful once the instance is gone.
   */
  output: () => string;
  systemMessages: string[];
  unmount: () => void;
}

/** Mounts the live view at a pinned 120×40 and captures what Ink writes. */
async function mountLive(live: LiveEngine): Promise<Harness> {
  const restore = stubTerminalSize(40, 120);
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 120;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  const systemMessages: string[] = [];
  const off = events.on("liveChat", (e) => {
    if (e.role === "system") systemMessages.push(e.text);
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
    systemMessages,
    unmount: () => {
      instance.unmount();
      off();
      restore();
    },
  };
}

describe("Live conversation rehydration (Phase 4D / REQ-2.3)", () => {
  beforeEach(() => {
    events.clear();
  });

  afterEach(() => {
    events.clear();
  });

  it("opens on the conversation the engine already holds, not on an empty card", async () => {
    const { live } = createFakeLive({
      transcript: [
        { role: "user", text: "add a notifications module" },
        { role: "assistant", text: "Which channel should it use?" },
      ],
    });

    const harness = await mountLive(live);
    harness.unmount();

    const output = harness.output();
    expect(output).toContain("you »");
    expect(output).toContain("add a notifications module");
    expect(output).toContain("thinker »");
    expect(output).toContain("Which channel should it use?");
    // An empty conversation shows the first-run hints instead.
    expect(output).not.toContain(EMPTY_CHAT_HINTS[0]!);
  });

  it("keeps the conversation when the cycle hands the console back (REQ-2.3)", async () => {
    const { live, transcript } = createFakeLive({
      // The engine keeps recording the refined conversation while the cycle runs.
      run: async () => {
        transcript.push({ role: "user", text: "harden the parser" });
        transcript.push({ role: "assistant", text: "Scope captured: harden the parser." });
      },
    });

    const harness = await mountLive(live);

    await submit(harness.stdin, "/draft");
    await tick(150);

    // the cycle ran and asked the post-cycle question, i.e. the console came back
    expect(live.execute).toHaveBeenCalledTimes(1);
    expect(live.ask).toHaveBeenCalledTimes(1);

    harness.unmount();
    const output = harness.output();

    // The remounted view shows the turns the engine recorded during the cycle. They
    // cannot have arrived as events — the transcript was empty when this view first
    // mounted and no `liveChat` ever carried them — and without the hydration the
    // frame flushed here would be the first-run hints of an empty card.
    expect(output).toContain("you »");
    expect(output).toContain("harden the parser");
    expect(output).toContain("Scope captured: harden the parser.");
    expect(output).not.toContain(EMPTY_CHAT_HINTS[0]!);
  });

  it("still renders turns announced while mounted, so hydration never swallows one", async () => {
    const { live, transcript } = createFakeLive({
      transcript: [{ role: "user", text: "first question" }],
    });

    const harness = await mountLive(live);

    // A turn the engine records and *then* announces (the real order), plus an
    // engine notice that is never recorded as a turn at all.
    transcript.push({ role: "user", text: "second question" });
    events.emit("liveChat", { role: "user", text: "second question" });
    events.emit("liveChat", { role: "system", text: "⚠ a notice that is not a turn" });
    await tick();

    harness.unmount();
    const output = harness.output();
    expect(output).toContain("first question");
    expect(output).toContain("second question");
    expect(output).toContain("a notice that is not a turn");
  });

  it("sanitizes the hydrated turns before they reach the terminal (SEC-001)", async () => {
    const { live } = createFakeLive({
      // A CSI colour, a bell and a zero-width character, as a hand-made session (or
      // an agent turn) could carry: none of them may reach the terminal.
      transcript: [{ role: "user", text: "\u001b[31malert\u0007\u200bnow" }],
    });

    const harness = await mountLive(live);
    harness.unmount();

    const output = harness.output();
    // The words stay together — which they only do if both controls in between were
    // stripped before the turn was painted.
    expect(output).toContain("alertnow");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u200b");
  });

  it("empties the engine transcript on /clear, so a remount cannot restore it", async () => {
    const { live, transcript } = createFakeLive({
      transcript: [
        { role: "user", text: "remember this secret" },
        { role: "assistant", text: "noted" },
      ],
    });

    // The conversation a user starts from: the engine's transcript, on screen.
    const hydrated = await mountLive(live);
    hydrated.unmount();
    expect(hydrated.output()).toContain("remember this secret");

    // `/clear` empties the view *and* the engine's copy of the conversation.
    const cleared = await mountLive(live);
    await submit(cleared.stdin, "/clear");
    expect(live.clearTranscript).toHaveBeenCalledTimes(1);
    expect(transcript).toEqual([]);
    expect(
      cleared.systemMessages.some((m) => m.includes("Conversation and stream viewport cleared.")),
    ).toBe(true);
    cleared.unmount();
    expect(cleared.output()).not.toContain("remember this secret");

    // The remount a cycle return performs: what was cleared does not come back.
    const remounted = await mountLive(live);
    remounted.unmount();
    expect(remounted.output()).not.toContain("remember this secret");
    expect(remounted.output()).toContain(EMPTY_CHAT_HINTS[0]!);
  });
});

/**
 * The de-duplication rule itself is pure, so it is pinned down directly: the
 * harness concatenates Ink's incremental frames, which makes "the turn was not
 * rendered twice" unobservable on the frame stream.
 */
describe("replayed-event recognition on a remount (Phase 4D)", () => {
  const hydrated: TranscriptTurn[] = [
    { role: "user", text: "first" },
    { role: "assistant", text: "first reply" },
  ];

  it("recognises the event of a turn that was hydrated as a replay of it", () => {
    expect(isHydratedReplay(hydrated, hydrated, { role: "assistant", text: "first reply" })).toBe(true);
  });

  it("treats every event as news when nothing was hydrated", () => {
    expect(isHydratedReplay([], [], { role: "user", text: "hello" })).toBe(false);
  });

  it("treats a turn recorded since the hydration as news, even a repeated text", () => {
    // A repeat is a *later* position, so it is never merged into the hydrated turn.
    const grown: TranscriptTurn[] = [...hydrated, { role: "assistant", text: "first reply" }];
    expect(isHydratedReplay(grown, hydrated, { role: "assistant", text: "first reply" })).toBe(false);
  });

  it("stops recognising replays as soon as the transcript moves on", () => {
    // A dropped turn (the transcript is capped at 100 turns)…
    const shifted: TranscriptTurn[] = [{ role: "assistant", text: "first reply" }];
    expect(isHydratedReplay(shifted, hydrated, { role: "assistant", text: "first reply" })).toBe(false);
    // …a cleared one…
    expect(isHydratedReplay([], hydrated, { role: "assistant", text: "first reply" })).toBe(false);
    // …and a rewritten one are all different conversations.
    const rewritten: TranscriptTurn[] = [
      { role: "user", text: "first" },
      { role: "assistant", text: "a different reply" },
    ];
    expect(isHydratedReplay(rewritten, hydrated, { role: "assistant", text: "a different reply" })).toBe(false);
  });

  it("only ever matches the newest hydrated turn, and only with the same role", () => {
    expect(isHydratedReplay(hydrated, hydrated, { role: "user", text: "first" })).toBe(false);
    expect(isHydratedReplay(hydrated, hydrated, { role: "user", text: "first reply" })).toBe(false);
    expect(isHydratedReplay(hydrated, hydrated, { role: "assistant", text: "something else" })).toBe(false);
  });

  it("compares the sanitized text, so an escape-laden turn is the same turn", () => {
    const raw: TranscriptTurn[] = [{ role: "assistant", text: "\u001b[31mhello\u001b[0m" }];
    expect(isHydratedReplay(raw, raw, { role: "assistant", text: "hello" })).toBe(true);
  });
});
