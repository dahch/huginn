import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { CycleEngine, readOnlyTreeViolation, resolveStructuralVerdict } from "./cycle";
import { events } from "./engineEvents";
import { git } from "./diff";
import { treeHash } from "./receipts";
import { WorktreeManager, sandboxPath, type Sandbox, type PromoteResult } from "./worktree";
import { freshState } from "../state/store";
import { MemoryService } from "../muninn/service/memory-service";
import type { RunConfig } from "../config";
import type { Iteration } from "../plan/types";
import type { IAgentRuntime, IAgentSession } from "./agent/types";

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
    sandbox: false,
    ...overrides,
  };
}

/**
 * A passing report for the huginn-orchestrated `VALIDATE_STEP` gate (REQ-7). The
 * gate is now a plain prompt (three audits + synthesis), so the mock routes on
 * the synthesis prompt's text instead of on a slash-command name.
 */
const GATE_PASS_REPORT =
  "## Validation Gate Report\n\n### Overall gate: 🟢 PASS\n\n✅ AUTO-APPROVED — no action required, continuing to next step.";

/**
 * The deterministic `VALIDATE_STEP` sub-reports (REV-003 / M-4): the qa/security
 * steps carry an `### Audit status:` line and the spec step an
 * `### Overall fidelity:` line, so huginn's fail-closed merge sees green.
 */
const QA_PASS_REPORT = "QA-AUDIT-RESPONSE\n\n### Audit status: 🟢 PASS";
const SPEC_PASS_REPORT = "SPEC-AUDITOR-RESPONSE\n\n### Overall fidelity: 🟢 ALIGNED";
const SECURITY_PASS_REPORT = "SECURITY-RESPONSE\n\n### Audit status: 🟢 PASS";

function isValidateStepSynthesis(text: string): boolean {
  return text.includes("Validation Gate Report");
}

/**
 * The deterministic sub-report reply for a VALIDATE_STEP sub-prompt, or `null`
 * when the prompt is not one of them. Matched on strings unique to each task so
 * the ordinary TEST_MODULE / SECURE_CHECK roles (which mention the same words)
 * are not misrouted.
 */
function validateStepSubReply(text: string): string | null {
  if (text.includes("AUDIT-ONLY MODE — do NOT write")) return QA_PASS_REPORT;
  if (text.includes("scope restriction")) return SECURITY_PASS_REPORT;
  if (text.includes("Audit semantic alignment between")) return SPEC_PASS_REPORT;
  return null;
}

function makeClient(promptImpl: () => Promise<unknown>): OpencodeClient {
  return {
    session: {
      create: async () => ({ id: "ses_test" }),
      get: async () => ({}),
      abort: async () => {},
      // Never issued by the pipeline anymore (REQ-7); kept so the stub matches
      // the OpencodeClient session shape.
      command: async () => ({ info: { id: "msg", error: undefined }, parts: [{ type: "text", text: GATE_PASS_REPORT }] }),
      prompt: async (params: { body?: { parts?: Array<{ text?: string }> } }) => {
        const text = params?.body?.parts?.[0]?.text ?? "";
        if (isValidateStepSynthesis(text)) {
          return { info: { id: "msg_gate", error: undefined }, parts: [{ type: "text", text: GATE_PASS_REPORT }] };
        }
        const sub = validateStepSubReply(text);
        if (sub) {
          return { info: { id: "msg_sub", error: undefined }, parts: [{ type: "text", text: sub }] };
        }
        return promptImpl();
      },
    },
  } as unknown as OpencodeClient;
}

/**
 * Client stub that records the raw SDK params for `session.create`,
 * `session.prompt` and `session.command` so tests can assert the sandbox
 * `directory` query parameter (REQ-17).
 */
function makeCapturingClient(): {
  client: OpencodeClient;
  calls: {
    create: Array<Record<string, unknown>>;
    prompt: Array<Record<string, unknown>>;
    command: Array<Record<string, unknown>>;
  };
} {
  const calls = {
    create: [] as Array<Record<string, unknown>>,
    prompt: [] as Array<Record<string, unknown>>,
    command: [] as Array<Record<string, unknown>>,
  };
  const client = {
    session: {
      create: async (params: Record<string, unknown>) => {
        calls.create.push(params);
        return { id: "ses_test" };
      },
      get: async () => ({}),
      abort: async () => {},
      command: async (params: Record<string, unknown>) => {
        calls.command.push(params);
        return {
          info: { id: "msg", error: undefined },
          parts: [{ type: "text", text: "### Overall gate: 🟢" }],
        };
      },
      prompt: async (params: Record<string, unknown>) => {
        calls.prompt.push(params);
        const body = params.body as { parts?: Array<{ text?: string }> } | undefined;
        const text = body?.parts?.[0]?.text ?? "";
        const reply = isValidateStepSynthesis(text)
          ? GATE_PASS_REPORT
          : validateStepSubReply(text) ?? '{"status":"pass","summary":"ok","actionItems":[]}';
        return {
          info: { id: "msg", error: undefined },
          parts: [{ type: "text", text: reply }],
        };
      },
    },
  } as unknown as OpencodeClient;
  return { client, calls };
}

function makePlan(): { content: string; iterations: Iteration[] } {
  return {
    content: "# Plan\n\n## Iteration 1 — Scaffold\n\nwork\n",
    iterations: [{ index: 1, title: "Scaffold", prompt: "work", startLine: 3 }],
  };
}

interface MockRuntime {
  runtime: IAgentRuntime;
  prompts: string[];
}

/**
 * A minimal {@link IAgentRuntime} whose single session routes prompt replies by
 * content. Exercises the full cycle through `ctx.session` — with no OpenCode
 * client at all — so the run never depends on the SDK path (REQ-7).
 *
 * Routing is deliberately specific so the qa (AUDIT-ONLY) and security
 * sub-prompts are distinguished from the ordinary TEST_MODULE / SECURE_CHECK
 * phases (whose roles also mention those words).
 */
function makeMockRuntime(onPrompt?: (text: string) => void): MockRuntime {
  const prompts: string[] = [];
  const session: IAgentSession = {
    id: "ses_mock",
    async prompt(text: string) {
      prompts.push(text);
      onPrompt?.(text);
      if (text.includes("Validation Gate Report")) {
        return { messageId: "gate", text: GATE_PASS_REPORT };
      }
      if (text.includes("AUDIT-ONLY MODE — do NOT write")) {
        return { messageId: "qa", text: `QA-AUDIT-RESPONSE\n\n### Audit status: 🟢 PASS` };
      }
      if (text.includes("scope restriction")) {
        return { messageId: "security", text: `SECURITY-RESPONSE\n\n### Audit status: 🟢 PASS` };
      }
      if (text.includes("Audit semantic alignment between")) {
        return { messageId: "spec", text: "SPEC-AUDITOR-RESPONSE\n\n### Overall fidelity: 🟢 ALIGNED" };
      }
      return { messageId: "default", text: '{"status":"pass","summary":"ok","actionItems":[]}' };
    },
    async abort() {},
  };
  const runtime: IAgentRuntime = {
    id: "opencode",
    name: "mock runtime",
    async isAvailable() {
      return true;
    },
    async getAvailableModels() {
      return [];
    },
    async getMcpStatus() {
      return { servers: [], totalTools: 0, healthy: true };
    },
    async createSession() {
      return session;
    },
  };
  return { runtime, prompts };
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

  it("clears a stale aborted flag when a resumed run completes (REV-004)", async () => {
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));
    const cfg = makeCfg();
    const state = freshState({
      planHash: "resume-aborted",
      planPath: cfg.planPath,
      specPath: cfg.specPath,
      adrPath: cfg.adrPath,
      thinker: cfg.thinker,
      executor: cfg.executor,
      mode: cfg.mode,
    });
    // The prior run was aborted; this resume finishes the plan.
    state.aborted = true;

    const engine = new CycleEngine({ cfg, client, plan: makePlan(), state });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    // ASSERTED ABORTED ONLY FOR A GENUINE ABORT (AC-49.3).
    expect(engine.getState().aborted).not.toBe(true);
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

  it("runs a profile that does not start with SPEC_AUDIT instead of silently doing nothing (REV-001)", async () => {
    // The resume cursor used to be keyed off `currentPhase`, which starts at
    // SPEC_AUDIT every iteration — so a profile beginning elsewhere matched no
    // step and ran zero phases while reporting success. `sandbox: false` is the
    // path where that happened.
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));

    const engine = new CycleEngine({ cfg: makeCfg({ profile: "odd" }), client, plan: makePlan() });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    const phases = engine.getState().history.map((h) => h.phase);
    // ODD is EXECUTE → TEST_MODULE → COMMIT_ALL: every step must have run.
    expect(phases).toContain("EXECUTE");
    expect(phases).toContain("TEST_MODULE");
    expect(phases).toContain("COMMIT_ALL");
    expect(phases).not.toContain("SPEC_AUDIT");
  });

  it("runs strict-tdd's tests before AND after EXECUTE (REV-002)", async () => {
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));

    const engine = new CycleEngine({
      cfg: makeCfg({ profile: "strict-tdd" }),
      client,
      plan: makePlan(),
    });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    const history = engine.getState().history;
    const testRuns = history.filter((h) => h.phase === "TEST_MODULE");
    // Tests first, then the gate re-runs them: the failing-first run must not
    // have been "fixed" before EXECUTE, so both occurrences are recorded.
    expect(testRuns.length).toBeGreaterThanOrEqual(2);
    expect(history.map((h) => h.phase)).toContain("EXECUTE");
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

  it("runs a full cycle through an IAgentRuntime (ctx.session) and issues all four VALIDATE_STEP prompts", async () => {
    const { runtime, prompts } = makeMockRuntime();

    const engine = new CycleEngine({ cfg: makeCfg(), runtime, plan: makePlan() });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    expect(engine.getState().history.some((h) => h.phase === "VALIDATE_STEP" && h.verdict === "pass")).toBe(true);

    // qa (AUDIT-ONLY) → spec-auditor → security → synthesis, all through the session.
    const qa = prompts.find((p) => p.includes("AUDIT-ONLY MODE — do NOT write"));
    const spec = prompts.find((p) => p.includes("Audit semantic alignment between"));
    const security = prompts.find((p) => p.includes("scope restriction"));
    const synthesis = prompts.find((p) => p.includes("Validation Gate Report"));

    expect(qa).toBeDefined();
    expect(qa).toContain("### Audit status:");
    expect(spec).toBeDefined();
    expect(spec).toContain("### Overall fidelity:");
    expect(security).toBeDefined();
    expect(security).toContain("### Audit status:");
    expect(synthesis).toBeDefined();
    expect(synthesis).toContain("### Overall gate:");
  });

  it("blocks a read-only phase that modifies the working tree (REV-001)", async () => {
    // Simulate a misbehaving auditor: the VALIDATE_STEP synthesis prompt writes
    // a repository file. Read-only enforcement must catch it and fail closed.
    const { runtime } = makeMockRuntime((text) => {
      if (text.includes("Validation Gate Report")) {
        writeFileSync(join(dir, "sneaky.ts"), "export const x: number = 1;\n");
      }
    });

    const engine = new CycleEngine({ cfg: makeCfg({ maxRetries: 0 }), runtime, plan: makePlan() });
    const off = events.on("decision", () => engine.resolveDecision("abort"));
    try {
      await engine.run();
    } finally {
      off();
    }

    const validate = engine.getState().history.find((h) => h.phase === "VALIDATE_STEP");
    expect(validate?.verdict).toBe("blocked");
    expect(validate?.summary).toContain("read-only phase modified the working tree");
  });

  it("blocks when the tree signature disappears mid-phase (fail closed)", async () => {
    // The "after" hash is unreadable: `treeHash` returns `undefined` and the
    // guard must treat that as a violation ("cannot prove nothing changed"),
    // never as "unchanged".
    const { runtime } = makeMockRuntime((text) => {
      if (text.includes("Validation Gate Report")) {
        rmSync(join(dir, ".git"), { recursive: true, force: true });
      }
    });

    const engine = new CycleEngine({ cfg: makeCfg({ maxRetries: 0 }), runtime, plan: makePlan() });
    const off = events.on("decision", () => engine.resolveDecision("abort"));
    try {
      await engine.run();
    } finally {
      off();
    }

    const validate = engine.getState().history.find((h) => h.phase === "VALIDATE_STEP");
    expect(validate?.verdict).toBe("blocked");
  });

  it("does not block a read-only phase that only reads and writes ignored artifacts (REV-104)", async () => {
    // A real audit runs the test suite, which writes coverage output, caches and
    // its own report — none of that is a repository mutation and must never
    // fail the guard. The phase also reads the repository normally.
    writeFileSync(join(dir, "plan.md"), "# Plan\n\n## Iteration 1 — Scaffold\n\nwork\n");
    const { runtime } = makeMockRuntime((text) => {
      if (!text.includes("Validation Gate Report")) return;
      expect(readFileSync(join(dir, "plan.md"), "utf8")).toContain("Iteration 1");
      writeFileSync(join(dir, ".harness", "reports-qa.md"), "report\n");
      mkdirSync(join(dir, "coverage"), { recursive: true });
      writeFileSync(join(dir, "coverage", "lcov.info"), "TN:\n");
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "dep", "index.js"), "1;\n");
    });

    const engine = new CycleEngine({ cfg: makeCfg(), runtime, plan: makePlan() });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    const validate = engine.getState().history.find((h) => h.phase === "VALIDATE_STEP");
    expect(validate?.verdict).toBe("pass");
    expect(validate?.summary).not.toContain("read-only");
  });

  it("does not block a read-only phase for build/test artifact writes (REV-103/REV-104)", async () => {
    // `tsc --incremental`, `pytest`, `eslint --cache`, a JUnit reporter and a Rust
    // build all write into the repository during an audit. None of that is a
    // repository mutation, so the read-only guard must tolerate it.
    writeFileSync(join(dir, "plan.md"), "# Plan\n\n## Iteration 1 — Scaffold\n\nwork\n");
    writeFileSync(join(dir, "tsconfig.tsbuildinfo"), "{}\n"); // pre-existing: rewrite it
    writeFileSync(join(dir, ".eslintcache"), "[]\n");
    const { runtime } = makeMockRuntime((text) => {
      if (!text.includes("Validation Gate Report")) return;
      writeFileSync(join(dir, "tsconfig.tsbuildinfo"), '{"version":1}\n');
      writeFileSync(join(dir, ".eslintcache"), '[{"filePath":"x"}]\n');
      writeFileSync(join(dir, "junit.xml"), "<testsuite/>\n");
      mkdirSync(join(dir, ".pytest_cache"), { recursive: true });
      writeFileSync(join(dir, ".pytest_cache", "CACHEDIR.TAG"), "x\n");
      mkdirSync(join(dir, "__pycache__"), { recursive: true });
      writeFileSync(join(dir, "__pycache__", "module.cpython-311.pyc"), "x\n");
      mkdirSync(join(dir, "target", "debug"), { recursive: true });
      writeFileSync(join(dir, "target", "debug", "app"), "x\n");
    });

    const engine = new CycleEngine({ cfg: makeCfg(), runtime, plan: makePlan() });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    const validate = engine.getState().history.find((h) => h.phase === "VALIDATE_STEP");
    expect(validate?.verdict).toBe("pass");
    expect(validate?.summary).not.toContain("read-only");
  });

  it("does not block a read-only phase for a real repository write it still has to catch (REV-001)", async () => {
    // The artifacts above must not have widened the filter into uselessness.
    const { runtime } = makeMockRuntime((text) => {
      if (!text.includes("Validation Gate Report")) return;
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "hidden.ts"), "export const x: number = 1;\n");
    });

    const engine = new CycleEngine({ cfg: makeCfg({ maxRetries: 0 }), runtime, plan: makePlan() });
    const off = events.on("decision", () => engine.resolveDecision("abort"));
    try {
      await engine.run();
    } finally {
      off();
    }

    const validate = engine.getState().history.find((h) => h.phase === "VALIDATE_STEP");
    expect(validate?.verdict).toBe("blocked");
    expect(validate?.summary).toContain("read-only phase modified the working tree");
  });

  it("warns (instead of failing silently) when an iteration receipt cannot be written", async () => {
    // A regular file where the receipt directory belongs: `mkdirSync` fails, so
    // `writeIterationReceipt` returns undefined. The iteration has no frozen
    // evidence then, and that must be visible in the log stream.
    writeFileSync(join(dir, ".huginn"), "not a directory\n");

    const logs: string[] = [];
    const off = events.on("log", (e) => logs.push(e.message));
    let outcome: { reason: string } = { reason: "not-run" };
    try {
      const client = makeClient(async () => ({
        info: { id: "msg", error: undefined },
        parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
      }));
      // `rdd` is a receipt-carrying profile; the default one writes no receipt.
      const engine = new CycleEngine({ cfg: makeCfg({ profile: "rdd" }), client, plan: makePlan() });
      outcome = await engine.run();
    } finally {
      off();
    }

    expect(outcome.reason).toBe("completed");
    expect(logs.some((m) => m.includes("[huginn] receipt could not be written (iteration 1)"))).toBe(
      true,
    );
    expect(existsSync(join(dir, ".huginn", "receipts"))).toBe(false);
  });

  it("sanitizes the history summary and the persisted report text (SEC-004)", async () => {
    // A phase report that echoes an agent's terminal output: neither the summary
    // persisted in `.harness/state.json` nor the report file may carry escapes.
    const hostile = "EXECUTE output \u001b[2J\u001b]0;pwned\u0007 body";
    const session: IAgentSession = {
      id: "ses_hostile",
      async prompt(text: string) {
        if (text.includes("Validation Gate Report")) {
          return { messageId: "gate", text: GATE_PASS_REPORT };
        }
        if (text.includes("AUDIT-ONLY MODE — do NOT write")) {
          return { messageId: "qa", text: QA_PASS_REPORT };
        }
        if (text.includes("scope restriction")) {
          return { messageId: "security", text: SECURITY_PASS_REPORT };
        }
        if (text.includes("Audit semantic alignment between")) {
          return { messageId: "spec", text: SPEC_PASS_REPORT };
        }
        if (text.includes("Execute the following iteration")) {
          return { messageId: "exe", text: hostile };
        }
        return { messageId: "other", text: '{"status":"pass","summary":"ok","actionItems":[]}' };
      },
      async abort() {},
    };
    const runtime: IAgentRuntime = {
      id: "opencode",
      name: "hostile runtime",
      async isAvailable() {
        return true;
      },
      async getAvailableModels() {
        return [];
      },
      async getMcpStatus() {
        return { servers: [], totalTools: 0, healthy: true };
      },
      async createSession() {
        return session;
      },
    };

    const engine = new CycleEngine({ cfg: makeCfg(), runtime, plan: makePlan() });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    const exe = engine.getState().history.find((h) => h.phase === "EXECUTE");
    expect(exe).toBeDefined();
    expect(exe?.summary).not.toContain("\u001b");
    expect(exe?.summary).not.toContain("\u0007");
    expect(exe?.summary).toContain("body");
    const report = readFileSync(exe!.reportPath!, "utf8");
    expect(report).not.toContain("\u001b");
    expect(report).not.toContain("\u0007");
    expect(report).toContain("body");
  });

  it("sanitizes the plan-derived iteration title before it reaches the log/UI (SEC-004)", async () => {
    const hostile = "Scaffold \u001b[2J\u001b]0;pwned\u0007 iteration";
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));
    const seen: string[] = [];
    const offStart = events.on("iterationStart", (e) => seen.push(e.title));
    const offLog = events.on("log", (e) => seen.push(e.message));
    try {
      const engine = new CycleEngine({
        cfg: makeCfg(),
        client,
        plan: {
          content: "# Plan\n",
          iterations: [{ index: 1, title: hostile, prompt: "work", startLine: 3 }],
        },
      });
      await engine.run();
    } finally {
      offStart();
      offLog();
    }

    const titled = seen.filter((s) => s.includes("Scaffold"));
    expect(titled.length).toBeGreaterThan(0);
    for (const entry of titled) {
      expect(entry).not.toContain("\u001b");
      expect(entry).not.toContain("\u0007");
    }
  });
});

describe("read-only guard semantics (REV-103)", () => {
  it("fails closed when either signature is unavailable", () => {
    expect(readOnlyTreeViolation(undefined, undefined)).toBe(true);
    expect(readOnlyTreeViolation(undefined, "abc")).toBe(true);
    expect(readOnlyTreeViolation("abc", undefined)).toBe(true);
    // The regression this guards: `undefined !== before` is false when BOTH are
    // undefined, which used to read as "the tree did not change".
    expect(readOnlyTreeViolation(undefined, "abc")).not.toBe(false);
  });

  it("passes only when both signatures are present and equal", () => {
    expect(readOnlyTreeViolation("abc", "abc")).toBe(false);
    expect(readOnlyTreeViolation("abc", "abd")).toBe(true);
  });

  it("treats a non-repo directory (no signature at all) as a violation", () => {
    const outside = mkdtempSync(join(tmpdir(), "huginn-not-a-repo-"));
    try {
      expect(treeHash(outside)).toBeUndefined();
      expect(readOnlyTreeViolation(treeHash(outside), treeHash(outside))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("structural gate verdicts (REV-101)", () => {
  it("prefers huginn's structural verdict over re-parsing the report text", () => {
    // `validateStep` returns `authoritativeVerdict`; the engine gates on it and
    // never has to read the report's prose again.
    expect(resolveStructuralVerdict({ authoritativeVerdict: "pass" })).toBe("pass");
    expect(resolveStructuralVerdict({ authoritativeVerdict: "warning" })).toBe("warning");
    expect(resolveStructuralVerdict({ authoritativeVerdict: "blocked" })).toBe("blocked");
    // No structural verdict → the caller falls back to parsing (spec-audit).
    expect(resolveStructuralVerdict({})).toBeUndefined();
  });

  it("lets a read-only violation outrank the phase's own verdict", () => {
    expect(
      resolveStructuralVerdict({ forcedVerdict: "blocked", authoritativeVerdict: "pass" }),
    ).toBe("blocked");
  });
});

describe("CycleEngine sandbox integration (AC-17.6)", () => {
  /** An empty commit keeps the repo greenfield but gives `createSandbox` a HEAD. */
  function commitEmpty(repo: string): void {
    git(repo, ["config", "user.email", "t@t"]);
    git(repo, ["config", "user.name", "t"]);
    expect(git(repo, ["commit", "--allow-empty", "-m", "init", "--no-gpg-sign"]).code).toBe(0);
  }

  interface SpiedWorktrees {
    manager: WorktreeManager;
    created: Sandbox[];
    promoted: Sandbox[];
    discarded: Sandbox[];
    cleaned: { count: number };
  }

  /** Real WorktreeManager with its public methods spied for assertions. */
  function spyWorktrees(root: string): SpiedWorktrees {
    const real = new WorktreeManager(root);
    const created: Sandbox[] = [];
    const promoted: Sandbox[] = [];
    const discarded: Sandbox[] = [];
    const cleaned = { count: 0 };
    const manager = {
      createSandbox: (r: string, iteration: number): Sandbox => {
        const s = real.createSandbox(r, iteration);
        created.push(s);
        return s;
      },
      promoteSandbox: (s: Sandbox) => {
        promoted.push(s);
        return real.promoteSandbox(s);
      },
      discardSandbox: (s: Sandbox) => {
        discarded.push(s);
        real.discardSandbox(s);
      },
      cleanupAll: () => {
        cleaned.count++;
        return real.cleanupAll();
      },
    } as unknown as WorktreeManager;
    return { manager, created, promoted, discarded, cleaned };
  }

  it("creates a sandbox, runs phases against its path and promotes on success", async () => {
    commitEmpty(dir);
    const spy = spyWorktrees(dir);

    const validatePrompts: string[] = [];
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));
    const routedPrompt = client.session.prompt as unknown as (params: {
      body?: { parts?: Array<{ text?: string }> };
    }) => Promise<unknown>;
    (client.session.prompt as unknown) = async (params: {
      body?: { parts?: Array<{ text?: string }> };
    }) => {
      const text = params.body?.parts?.[0]?.text ?? "";
      if (isValidateStepSynthesis(text)) validatePrompts.push(text);
      return routedPrompt(params);
    };

    const engine = new CycleEngine({
      cfg: makeCfg({ sandbox: true }),
      client,
      plan: makePlan(),
      worktrees: spy.manager,
    });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    // Pre-run cleanup reclaimed stale sandboxes.
    expect(spy.cleaned.count).toBeGreaterThanOrEqual(1);
    // Exactly one sandbox was created for iteration 1, at the derived path.
    expect(spy.created).toHaveLength(1);
    const sandbox = spy.created[0];
    expect(sandbox.path).toBe(sandboxPath(dir, 1));

    // The phase context operated on the sandbox: the validate-step synthesis
    // prompt received the sandbox-rooted spec path rather than the primary
    // project's.
    expect(validatePrompts).toHaveLength(1);
    expect(validatePrompts[0]).toContain(join(sandbox.path, "spec.md"));
    expect(validatePrompts[0]).not.toContain(join(dir, "spec.md"));

    // Success promoted the sandbox and never discarded it.
    expect(spy.promoted).toEqual([sandbox]);
    expect(spy.discarded).toHaveLength(0);
    // Promotion removed the worktree from disk.
    expect(existsSync(sandbox.path)).toBe(false);
  });

  it("discards the sandbox and never promotes when the iteration aborts", async () => {
    commitEmpty(dir);
    const spy = spyWorktrees(dir);

    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((res) => (markPromptStarted = res));
    let rejectPrompt!: (e: Error) => void;
    const controlled = new Promise<unknown>((_, rej) => (rejectPrompt = rej));

    // SPEC_AUDIT is skipped on the greenfield sandbox, so the first prompt is
    // the iteration's EXECUTE; hold it pending to abort mid-iteration.
    const client = makeClient(async () => {
      markPromptStarted();
      return controlled;
    });
    (client.session.abort as unknown as () => Promise<void>) = async () => {};

    const engine = new CycleEngine({
      cfg: makeCfg({ sandbox: true }),
      client,
      plan: makePlan(),
      worktrees: spy.manager,
    });
    const runPromise = engine.run();

    await promptStarted;
    engine.requestAbort();
    rejectPrompt(new Error("aborted by test"));

    const outcome = await runPromise;

    expect(outcome.reason).toBe("aborted");
    expect(spy.created).toHaveLength(1);
    // The sandbox was discarded (not promoted) and the primary tree is intact.
    expect(spy.promoted).toHaveLength(0);
    expect(spy.discarded).toEqual([spy.created[0]]);
    expect(existsSync(spy.created[0].path)).toBe(false);
    expect(engine.getState().currentIteration).toBe(1);
  });

  it("ignores a mid-iteration resume phase when sandboxing and re-runs from the start", async () => {
    commitEmpty(dir);
    const spy = spyWorktrees(dir);

    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));

    // A prior run aborted after EXECUTE had completed: the persisted state sits
    // at iteration 1 / VALIDATE_STEP. Its ephemeral worktree (and EXECUTE's
    // changes) were reclaimed at startup, so resuming would validate an empty
    // sandbox. Sandboxing must therefore re-run the whole iteration.
    const cfg = makeCfg({ sandbox: true });
    const state = freshState({
      planHash: "resume-test",
      planPath: cfg.planPath,
      specPath: cfg.specPath,
      adrPath: cfg.adrPath,
      thinker: cfg.thinker,
      executor: cfg.executor,
      mode: cfg.mode,
    });
    state.currentIteration = 1;
    state.currentPhase = "VALIDATE_STEP";

    const engine = new CycleEngine({ cfg, client, plan: makePlan(), worktrees: spy.manager, state });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    // Resume point was ignored: EXECUTE ran in this run despite the saved phase.
    expect(engine.getState().history.some((h) => h.iteration === 1 && h.phase === "EXECUTE")).toBe(true);
    // A full successful iteration promoted its sandbox.
    expect(spy.created).toHaveLength(1);
    expect(spy.promoted).toHaveLength(1);
    expect(spy.discarded).toHaveLength(0);
    expect(engine.getState().currentIteration).toBe(2);
  });

  it("scopes the agent session, prompts and commands to the sandbox directory (REQ-17)", async () => {
    commitEmpty(dir);
    const spy = spyWorktrees(dir);
    const { client, calls } = makeCapturingClient();

    const engine = new CycleEngine({
      cfg: makeCfg({ sandbox: true }),
      client,
      plan: makePlan(),
      worktrees: spy.manager,
    });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    const sandbox = spy.created[0];
    expect(sandbox).toBeDefined();

    // The session was created bound to the sandbox directory.
    expect(calls.create).toHaveLength(1);
    expect((calls.create[0].query as { directory?: string }).directory).toBe(sandbox.path);

    // Phase prompts (EXECUTE etc.) carry the sandbox directory; judge prompts
    // (issued outside PhaseContext) may omit it but must never name another dir.
    const promptDirs = calls.prompt.map(
      (c) => (c.query as { directory?: string } | undefined)?.directory,
    );
    expect(promptDirs[0]).toBe(sandbox.path);
    expect(promptDirs.every((d) => d === undefined || d === sandbox.path)).toBe(true);

    // No slash commands are issued anymore (REQ-7): every step — including the
    // validate gate — is an injected prompt, so `session.command` is never used.
    expect(calls.command).toHaveLength(0);
  });

  it("finishes as an error (not completed) when promotion conflicts and preserves the branch", async () => {
    commitEmpty(dir);
    let promotedCount = 0;
    const real = new WorktreeManager(dir);
    const manager = {
      createSandbox: (root: string, iteration: number): Sandbox => real.createSandbox(root, iteration),
      promoteSandbox: (): PromoteResult => {
        promotedCount++;
        return { promoted: false, method: "cherry-pick", commits: ["deadbeef"] };
      },
      discardSandbox: () => {},
      cleanupAll: () => 0,
    } as unknown as WorktreeManager;

    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));

    const engine = new CycleEngine({
      cfg: makeCfg({ sandbox: true }),
      client,
      plan: makePlan(),
      worktrees: manager,
    });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("error");
    expect(outcome.error).toMatch(/conflict/i);
    expect(promotedCount).toBe(1);
    // The run is an error, so the iteration is not marked complete.
    expect(engine.getState().currentIteration).toBe(1);
    // ADR-48 / AC-49.3: a promotion failure is recorded as itself — the preserved
    // branch is named and the run is NOT reported as an abort.
    expect(engine.getState().aborted).not.toBe(true);
    expect(engine.getState().promotion).toEqual({
      status: "conflict",
      branch: "huginn/task-iter-1",
    });
  });

  it("records a *failed* promotion and never discards the sandbox (AC-49.2/AC-49.3, NFR-15)", async () => {
    commitEmpty(dir);
    let discarded = 0;
    const real = new WorktreeManager(dir);
    const manager = {
      createSandbox: (root: string, iteration: number): Sandbox => real.createSandbox(root, iteration),
      // huginn could not park a colliding file: it must report a failure, keep
      // the branch, and never discard the iteration's commits.
      promoteSandbox: (): PromoteResult => ({
        promoted: false,
        method: "cherry-pick",
        commits: ["deadbeef"],
        failure: "failed",
        detail: "could not park untracked file(s)",
      }),
      discardSandbox: () => {
        discarded++;
      },
      cleanupAll: () => 0,
    } as unknown as WorktreeManager;

    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));

    const engine = new CycleEngine({
      cfg: makeCfg({ sandbox: true }),
      client,
      plan: makePlan(),
      worktrees: manager,
    });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("error");
    expect(engine.getState().aborted).not.toBe(true);
    expect(engine.getState().promotion).toEqual({
      status: "failed",
      branch: "huginn/task-iter-1",
      detail: "could not park untracked file(s)",
    });
    // The preserved branch is never deleted by the engine's cleanup.
    expect(discarded).toBe(0);
  });

  it("runs in-place (no sandbox) when the repo has no HEAD and sandbox is requested", async () => {
    // No commit: `headCommit` is null, so `createSandbox` would throw. The run
    // must fall back to in-place execution for this run.
    const spy = spyWorktrees(dir);
    const { client, calls } = makeCapturingClient();

    const engine = new CycleEngine({
      cfg: makeCfg({ sandbox: true }),
      client,
      plan: makePlan(),
      worktrees: spy.manager,
    });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    expect(spy.created).toHaveLength(0);
    expect(spy.promoted).toHaveLength(0);
    expect(spy.discarded).toHaveLength(0);
    // Pre-run cleanup is skipped for an in-place run.
    expect(spy.cleaned.count).toBe(0);
    // The session is scoped to the primary project root, not a sandbox.
    expect(calls.create).toHaveLength(1);
    expect((calls.create[0].query as { directory?: string }).directory).toBe(dir);
  });

  it("persists indexed symbols to the PRIMARY database across sandbox promotion (memory durability)", async () => {
    commitEmpty(dir);
    const spy = spyWorktrees(dir);
    const sandboxDir = sandboxPath(dir, 1);

    // The build agent's EXECUTE turn writes a source file inside the sandbox
    // and commits it there, exactly as a real build would before promotion.
    const client = {
      session: {
        create: async () => ({ id: "ses_test" }),
        get: async () => ({}),
        abort: async () => {},
        command: async () => ({
          info: { id: "msg", error: undefined },
          parts: [{ type: "text", text: "### Overall gate: 🟢" }],
        }),
        prompt: async (params: {
          body?: { agent?: string; parts?: Array<{ text?: string }> };
          query?: { directory?: string };
        }) => {
          if (params?.body?.agent === "build" && params?.query?.directory === sandboxDir) {
            writeFileSync(
              join(sandboxDir, "feature.ts"),
              "export class DurableFeatureService {\n  public run(): void {}\n}\n",
            );
            git(sandboxDir, ["config", "user.email", "t@t"]);
            git(sandboxDir, ["config", "user.name", "t"]);
            git(sandboxDir, ["add", "-A"]);
            git(sandboxDir, ["commit", "-m", "feature", "--no-gpg-sign"]);
          }
          const text = params?.body?.parts?.[0]?.text ?? "";
          return {
            info: { id: "msg", error: undefined },
            parts: [
              {
                type: "text",
                text: isValidateStepSynthesis(text)
                  ? GATE_PASS_REPORT
                  : validateStepSubReply(text) ?? '{"status":"pass","summary":"ok","actionItems":[]}',
              },
            ],
          };
        },
      },
    } as unknown as OpencodeClient;

    const engine = new CycleEngine({
      cfg: makeCfg({ sandbox: true }),
      client,
      plan: makePlan(),
      worktrees: spy.manager,
    });
    const outcome = await engine.run();

    expect(outcome.reason).toBe("completed");
    // The sandbox was promoted (worktree removed) — its local state is gone...
    expect(spy.promoted).toHaveLength(1);
    expect(existsSync(sandboxDir)).toBe(false);
    // ...so the indexed symbols must have been written to the PRIMARY database,
    // not the ephemeral worktree's.
    const primaryDbPath = join(dir, ".huginn", "muninn.db");
    expect(existsSync(primaryDbPath)).toBe(true);

    const mem = new MemoryService({ projectRoot: dir, dbPath: primaryDbPath });
    try {
      const rows = mem.db
        .prepare("SELECT identifier, project_id FROM entities WHERE identifier LIKE ?")
        .all("%DurableFeatureService%") as Array<{ identifier: string; project_id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].identifier).toContain("feature.ts");
      // Attributed to the PRIMARY project record (not a throwaway worktree root).
      expect(rows[0].project_id).toBe(mem.currentProject.id);
      expect(mem.currentProject.root_path).toBe(dir);
    } finally {
      mem.close?.();
    }
  });
});
