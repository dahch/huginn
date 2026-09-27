import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { CycleEngine } from "./cycle";
import { events } from "./engineEvents";
import { git } from "./diff";
import { WorktreeManager, sandboxPath, type Sandbox, type PromoteResult } from "./worktree";
import { freshState } from "../state/store";
import { MemoryService } from "../muninn/service/memory-service";
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
    sandbox: false,
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
        return {
          info: { id: "msg", error: undefined },
          parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
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

    const validateArgs: string[] = [];
    const client = makeClient(async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: '{"status":"pass","summary":"ok","actionItems":[]}' }],
    }));
    (client.session.command as unknown) = async (params: {
      body?: { command?: string; arguments?: string };
    }) => {
      if (params.body?.command === "validate-step") {
        validateArgs.push(params.body.arguments ?? "");
      }
      return {
        info: { id: "msg", error: undefined },
        parts: [{ type: "text", text: "### Overall gate: 🟢" }],
      };
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

    // The phase context operated on the sandbox: validate-step received the
    // sandbox-rooted spec path rather than the primary project's.
    expect(validateArgs).toHaveLength(1);
    expect(validateArgs[0]).toContain(join(sandbox.path, "spec.md"));
    expect(validateArgs[0]).not.toContain(join(dir, "spec.md"));

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
    (client.session.command as unknown) = async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: "### Overall gate: 🟢" }],
    });

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

    // Every phased slash command is scoped to the sandbox.
    const commandDirs = calls.command.map((c) => (c.query as { directory?: string }).directory);
    expect(commandDirs.length).toBeGreaterThan(0);
    expect(commandDirs.every((d) => d === sandbox.path)).toBe(true);
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
    (client.session.command as unknown) = async () => ({
      info: { id: "msg", error: undefined },
      parts: [{ type: "text", text: "### Overall gate: 🟢" }],
    });

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
          body?: { agent?: string };
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
          return {
            info: { id: "msg", error: undefined },
            parts: [
              {
                type: "text",
                text: '{"status":"pass","summary":"ok","actionItems":[]}',
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
