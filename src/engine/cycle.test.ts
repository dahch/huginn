import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { CycleEngine } from "./cycle";
import { events } from "./engineEvents";
import { git } from "./diff";
import type { RunConfig } from "../config";
import type { Iteration } from "../plan/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-cycle-"));
  git(dir, ["init", "-q"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCfg(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    projectPath: dir,
    planPath: join(dir, "plan.md"),
    specPath: join(dir, "spec.md"),
    adrPath: join(dir, "adr.md"),
    thinker: "opencode-go/deepseek-v4-pro",
    executor: "opencode-go/deepseek-v4-flash",
    mode: "auto",
    permissions: "auto",
    maxRetries: 3,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 0,
    ignorePlanChanges: false,
    ...overrides,
  };
}

function makeClient(
  promptImpl: () => Promise<unknown>,
  commandImpl?: () => Promise<unknown>,
): OpencodeClient {
  return {
    session: {
      create: async () => ({ id: "ses_test" }),
      get: async () => ({}),
      abort: async () => {},
      command:
        commandImpl ??
        (async () => ({ info: { id: "msg", error: undefined }, parts: [{ type: "text", text: "### Overall gate: 🟢" }] })),
      prompt: promptImpl,
    },
  } as unknown as OpencodeClient;
}

function makePlan(): { content: string; iterations: Iteration[] } {
  return {
    content: "# Plan\n\n## Iteration 1 — Scaffold\n\nwork\n",
    iterations: [{ index: 1, title: "Scaffold", prompt: "work", startLine: 3 }],
  };
}

describe("CycleEngine run loop", () => {
  it("marks an aborted mid-iteration run as aborted without advancing currentIteration", async () => {
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((res) => (markPromptStarted = res));
    let rejectPrompt!: (e: Error) => void;
    const controlled = new Promise<unknown>((_, rej) => (rejectPrompt = rej));
    let abortCalls = 0;

    // EXECUTE is the only gated-by-nothing prompt; SPEC_AUDIT is skipped on
    // this empty repo, so the first prompt call is the iteration's EXECUTE.
    const client = makeClient(async () => {
      markPromptStarted();
      return controlled;
    });
    (client.session.abort as unknown as () => Promise<void>) = async () => {
      abortCalls++;
    };

    const engine = new CycleEngine({ cfg: makeCfg(), client, plan: makePlan() });
    const runPromise = engine.run();

    await promptStarted; // EXECUTE's agent request is now pending
    engine.requestAbort();
    rejectPrompt(new Error("aborted by test"));

    const outcome = await runPromise;
    const state = engine.getState();

    expect(outcome.reason).toBe("aborted");
    expect(state.aborted).toBe(true);
    // Regression: an aborted iteration must NOT be marked complete, otherwise
    // a resume skips it entirely (the bug fixed in runLoop).
    expect(state.currentIteration).toBe(1);
    // requestAbort must interrupt the in-flight server request, otherwise a
    // stuck agent prompt keeps the run alive until the phase timeout.
    expect(abortCalls).toBe(1);
    // SPEC_AUDIT still recorded its greenfield skip before the abort.
    expect(state.history.some((h) => h.phase === "SPEC_AUDIT" && h.verdict === "skipped")).toBe(true);
  });

  it("advances currentIteration after a normally completed iteration", async () => {
    // prompt feeds EXECUTE (gate none) and the judge passes (TEST_MODULE /
    // SECURE_CHECK / REVIEW); command feeds VALIDATE_STEP, which needs the
    // parseable "Overall gate" marker to pass instead of failing closed.
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));

    const engine = new CycleEngine({ cfg: makeCfg(), client, plan: makePlan() });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    expect(engine.getState().currentIteration).toBe(2);
  });

  it("fails closed instead of passing when EXECUTE returns an empty report", async () => {
    // `session.prompt` can resolve on a step boundary (reasoning-only turn)
    // with no text parts; that must never record a pass.
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [],
    }));

    const engine = new CycleEngine({ cfg: makeCfg({ maxRetries: 0 }), client, plan: makePlan() });
    const off = events.on("decision", () => engine.resolveDecision("abort"));
    try {
      const outcome = await engine.run();
      expect(outcome.reason).toBe("aborted");
    } finally {
      off();
    }

    const exe = engine.getState().history.find((h) => h.phase === "EXECUTE");
    expect(exe?.verdict).toBe("blocked");
    expect(exe?.summary).not.toBe("");
  });
});
