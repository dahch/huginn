import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, headCommit } from "../../src/engine/diff.js";
import { WorktreeManager } from "../../src/engine/worktree.js";
import { CycleEngine } from "../../src/engine/cycle.js";
import { freshState } from "../../src/state/store.js";
import { promotionRepairEligibility } from "../../src/engine/promotionRepair.js";
import type { RunConfig } from "../../src/config.js";
import type { Iteration } from "../../src/plan/types.js";
import type {
  RuntimePort,
  RuntimePromptRequest,
  RuntimeSessionOptions,
} from "../../src/engine/agent/port.js";
import type { PromptResult } from "../../src/engine/agent/types.js";

/**
 * ADR-62 — recovering a failed sandbox promotion.
 *
 * These tests use the real `git` binary against throwaway repositories because
 * the whole point of the recovery is integration semantics: a merge base, an
 * in-progress merge, a fast-forward and a preserved branch.
 */

const repos: string[] = [];

function freshRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "huginn-promote-")));
  repos.push(dir);
  expect(git(dir, ["init", "-b", "main"]).code).toBe(0);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".huginn/\n");
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  commitAll(dir, "init");
  return dir;
}

function commitAll(repo: string, message: string): void {
  expect(git(repo, ["add", "-A"]).code).toBe(0);
  expect(git(repo, ["commit", "-m", message]).code).toBe(0);
}

function branchExists(repo: string, branch: string): boolean {
  return git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;
}

afterEach(() => {
  while (repos.length > 0) {
    const dir = repos.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

interface Preserved {
  root: string;
  branch: string;
  base: string;
  primaryHead: string;
}

/** A branch that fast-forwards the primary, as if a promotion had failed for any reason. */
function promotableAfterDocs(verification: string[]): RepairFixture {
  const root = freshRepo();
  const { cfg, plan } = makeCfg(root, verification);
  const mgr = new WorktreeManager(root);
  const sandbox = mgr.createSandbox(root, 1);
  fs.writeFileSync(path.join(sandbox.path, "sandbox.txt"), "iteration\n");
  commitAll(sandbox.path, "iteration edit");
  // Drop the worktree but keep the branch: exactly the state a failed promotion
  // leaves behind.
  mgr.detachSandbox(sandbox);
  expect(branchExists(root, sandbox.branch)).toBe(true);
  return {
    preserved: {
      root,
      branch: sandbox.branch,
      base: sandbox.baseCommit,
      primaryHead: headCommit(root)!,
    },
    cfg,
    plan,
  };
}

function makeCfg(root: string, verification: string[]): { cfg: RunConfig; plan: { content: string; iterations: Iteration[] } } {
  const iteration: Iteration = {
    index: 1,
    title: "Landing",
    prompt: "build the landing",
    modules: [],
    verification,
  } as unknown as Iteration;
  const plan = { content: "", iterations: [iteration] };
  for (const name of ["plan.md", "spec.md", "adr.md"]) {
    fs.writeFileSync(path.join(root, name), `# ${name}\n`);
  }
  commitAll(root, "docs");
  const cfg: RunConfig = {
    projectPath: root,
    planPath: path.join(root, "plan.md"),
    specPath: path.join(root, "spec.md"),
    adrPath: path.join(root, "adr.md"),
    thinker: "test/thinker",
    executor: "test/executor",
    mode: "auto",
    permissions: "auto",
    maxRetries: 0,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 0,
    ignorePlanChanges: true,
    sandbox: true,
    verify: true,
  };
  return { cfg, plan };
}

function makeEngine(
  cfg: RunConfig,
  plan: { content: string; iterations: Iteration[] },
  root: string,
  preserved: Preserved,
  onPrompt: (request: RuntimePromptRequest) => Promise<PromptResult>,
): {
  engine: CycleEngine;
  prompts: RuntimePromptRequest[];
  creates: RuntimeSessionOptions[];
} {
  const prompts: RuntimePromptRequest[] = [];
  const creates: RuntimeSessionOptions[] = [];
  const runtime = {
    id: "generic",
    name: "fake",
    capabilities: {
      inProcess: false,
      structuredEvents: false,
      streaming: false,
      permissions: "none",
      sessionHistory: false,
      sessionResume: false,
      modelCatalog: "none",
      structuredOutput: false,
      usageCost: false,
      mcpListing: false,
      interrupt: false,
    },
    isAvailable: async () => ({ ok: true }),
    listModels: async () => ({ models: [] }),
    resolveModel: (reference: string) => ({ ok: true as const, model: reference }),
    createSession: async (options: RuntimeSessionOptions) => {
      creates.push(options);
      return {
        id: `ses-${creates.length}`,
        resumable: false,
        async prompt(request: RuntimePromptRequest) {
          prompts.push(request);
          return onPrompt(request);
        },
        async interrupt() {},
        async close() {},
      };
    },
  } as unknown as RuntimePort;

  const state = freshState({
    planHash: "test-hash",
    planPath: cfg.planPath,
    specPath: cfg.specPath,
    adrPath: cfg.adrPath,
    thinker: cfg.thinker,
    executor: cfg.executor,
    mode: "auto",
  });
  state.currentIteration = 1;
  state.iterationBaseCommit = preserved.base;
  state.promotion = { status: "conflict", branch: preserved.branch, detail: "content conflict" };

  const engine = new CycleEngine({ cfg, plan, state, runtime });
  return { engine, prompts, creates };
}

describe("promotionRepairEligibility (ADR-62)", () => {
  it("offers the model only for a real content conflict", () => {
    expect(promotionRepairEligibility({ status: "conflict", branch: "b" }).ok).toBe(true);
    expect(promotionRepairEligibility({ status: "promoted", branch: "b" }).ok).toBe(false);
    expect(promotionRepairEligibility({ status: "none", branch: "b" }).ok).toBe(false);
    expect(promotionRepairEligibility(undefined).ok).toBe(false);
  });

  it("refuses a failure about the user's index and points at the deterministic retry", () => {
    const verdict = promotionRepairEligibility({
      status: "failed",
      branch: "huginn/task-iter-1",
      detail: "cannot park a.ts (partially staged): commit, unstage or stash",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("huginn promote --retry");
      expect(verdict.reason).toContain("huginn/task-iter-1");
    }
  });
});

describe("retryPromotion — deterministic (ADR-62)", () => {
  it("integrates a preserved branch and advances the run", async () => {
    const { preserved, cfg, plan } = promotableAfterDocs(["test -f sandbox.txt"]);
    const { engine } = makeEngine(cfg, plan, preserved.root, preserved, async () => ({
      messageId: "unused",
      text: "unused",
    }));

    const result = await engine.retryPromotion();

    expect(result.promoted).toBe(true);
    expect(result.method).toBe("ff");
    expect(fs.readFileSync(path.join(preserved.root, "sandbox.txt"), "utf8")).toBe("iteration\n");
    expect(branchExists(preserved.root, preserved.branch)).toBe(false);
    expect(engine.getState().currentIteration).toBe(2);
    expect(engine.getState().promotion?.status).toBe("promoted");
  }, 30000);

  it("keeps the branch and the primary tree when the integration conflicts again", async () => {
    const { preserved, cfg, plan } = conflictingAfterDocs(["test -f file.txt"]);
    const { engine, prompts } = makeEngine(cfg, plan, preserved.root, preserved, async () => ({
      messageId: "unused",
      text: "unused",
    }));

    const result = await engine.retryPromotion();

    expect(result.promoted).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(headCommit(preserved.root)).toBe(preserved.primaryHead);
    expect(fs.readFileSync(path.join(preserved.root, "file.txt"), "utf8")).toBe("primary\n");
    expect(branchExists(preserved.root, preserved.branch)).toBe(true);
    expect(engine.getState().currentIteration).toBe(1);
    expect(engine.getState().promotion?.status).toBe("conflict");
  }, 30000);
});

interface RepairFixture {
  preserved: Preserved;
  cfg: RunConfig;
  plan: { content: string; iterations: Iteration[] };
}

/** Documents first (they are part of every sandbox), then a real conflicting promotion. */
function conflictingAfterDocs(verification: string[]): RepairFixture {
  const root = freshRepo();
  const { cfg, plan } = makeCfg(root, verification);
  const mgr = new WorktreeManager(root);
  const sandbox = mgr.createSandbox(root, 1);
  fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
  commitAll(sandbox.path, "iteration edit");

  fs.writeFileSync(path.join(root, "file.txt"), "primary\n");
  commitAll(root, "primary edit");

  const result = mgr.promoteSandbox(sandbox);
  expect(result.promoted).toBe(false);
  expect(result.failure).toBe("conflict");
  expect(branchExists(root, sandbox.branch)).toBe(true);

  return {
    preserved: {
      root,
      branch: sandbox.branch,
      base: sandbox.baseCommit,
      primaryHead: headCommit(root)!,
    },
    cfg,
    plan,
  };
}

describe("repairPromotion — thinker diagnoses, executor resolves, VERIFY decides (ADR-62)", () => {
  it("resolves the conflict, verifies and promotes with the right models", async () => {
    const { preserved, cfg, plan } = conflictingAfterDocs([
      "test -f file.txt",
      "grep -q resolved file.txt",
    ]);
    const { engine, prompts, creates } = makeEngine(
      cfg,
      plan,
      preserved.root,
      preserved,
      async (request) => {
        if (request.text.includes("Lead Architect / Diagnostician")) {
          return {
            messageId: "diag",
            text: "### Root Cause\nThe two histories edited file.txt.\n\n### Step-by-Step Edits for Executor\nWrite the merged content.",
          };
        }
        if (request.text.includes("resolving a git integration conflict")) {
          fs.writeFileSync(path.join(request.directory!, "file.txt"), "resolved\n");
          return { messageId: "fix", text: "Resolved file.txt by keeping both changes." };
        }
        return { messageId: "other", text: "ok" };
      },
    );

    const result = await engine.repairPromotion();

    expect(result.promoted).toBe(true);
    expect(fs.readFileSync(path.join(preserved.root, "file.txt"), "utf8")).toBe("resolved\n");
    expect(branchExists(preserved.root, preserved.branch)).toBe(false);
    expect(engine.getState().currentIteration).toBe(2);
    expect(engine.getState().promotion?.status).toBe("promoted");

    const diagnosis = prompts.find((p) => p.text.includes("Lead Architect / Diagnostician"));
    const application = prompts.find((p) => p.text.includes("resolving a git integration conflict"));
    expect(diagnosis?.model).toBe("test/thinker");
    expect(diagnosis?.agent).toBeUndefined();
    expect(application?.model).toBe("test/executor");
    expect(application?.agent).toBe("build");
    // Every turn ran inside the recovery worktree, never the primary tree.
    const worktree = path.join(preserved.root, ".huginn", "worktrees", "task-iter-1");
    expect(creates.length).toBeGreaterThan(0);
    expect(creates.every((c) => c.directory === worktree)).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
  }, 60000);

  it("re-merges when the primary advances while the repair is being verified", async () => {
    const { preserved, cfg, plan } = conflictingAfterDocs([
      "test -f file.txt",
      "grep -q resolved file.txt",
    ]);
    let advanced = false;
    const { engine, prompts } = makeEngine(
      cfg,
      plan,
      preserved.root,
      preserved,
      async (request) => {
        if (request.text.includes("Lead Architect / Diagnostician")) {
          return { messageId: "diag", text: "### Root Cause\nconflict" };
        }
        if (request.text.includes("resolving a git integration conflict")) {
          fs.writeFileSync(path.join(request.directory!, "file.txt"), "resolved\n");
          // A commit lands on the primary while the repair is in flight, after
          // the merge that repairPromotion verified.
          if (!advanced) {
            advanced = true;
            fs.writeFileSync(path.join(preserved.root, "advanced.txt"), "landed\n");
            commitAll(preserved.root, "primary advances during repair");
          }
          return { messageId: "fix", text: "Resolved." };
        }
        return { messageId: "other", text: "ok" };
      },
    );

    const result = await engine.repairPromotion();

    expect(result.promoted).toBe(true);
    // The branch already contains the advanced primary HEAD after the re-merge,
    // so the integration is a fast-forward and no empty cherry-pick loop starts.
    expect(result.method).toBe("ff");
    expect(fs.readFileSync(path.join(preserved.root, "file.txt"), "utf8")).toBe("resolved\n");
    expect(fs.readFileSync(path.join(preserved.root, "advanced.txt"), "utf8")).toBe("landed\n");
    expect(branchExists(preserved.root, preserved.branch)).toBe(false);
    // The advanced commit only added a file, so the second merge was clean: the
    // resolver ran exactly once.
    expect(
      prompts.filter((p) => p.text.includes("resolving a git integration conflict")),
    ).toHaveLength(1);
  }, 60000);

  it("rolls back the merge and keeps the branch when the merged tree does not verify", async () => {
    const { preserved, cfg, plan } = conflictingAfterDocs(["test -f file.txt", "false"]);
    const { engine } = makeEngine(cfg, plan, preserved.root, preserved, async (request) => {
      if (request.text.includes("Lead Architect / Diagnostician")) {
        return { messageId: "diag", text: "### Root Cause\nconflict" };
      }
      if (request.text.includes("resolving a git integration conflict")) {
        fs.writeFileSync(path.join(request.directory!, "file.txt"), "resolved\n");
        return { messageId: "fix", text: "Resolved." };
      }
      return { messageId: "other", text: "ok" };
    });
    const branchTip = git(preserved.root, ["rev-parse", preserved.branch]).stdout.trim();

    const result = await engine.repairPromotion();

    expect(result.promoted).toBe(false);
    expect(result.error ?? "").toContain("does not verify");
    expect(headCommit(preserved.root)).toBe(preserved.primaryHead);
    expect(fs.readFileSync(path.join(preserved.root, "file.txt"), "utf8")).toBe("primary\n");
    // Branch preserved, and restored to the tip the iteration produced (the
    // unverified merge commit is not left behind as evidence).
    expect(branchExists(preserved.root, preserved.branch)).toBe(true);
    expect(git(preserved.root, ["rev-parse", preserved.branch]).stdout.trim()).toBe(branchTip);
    expect(engine.getState().currentIteration).toBe(1);
    expect(fs.existsSync(path.join(preserved.root, ".huginn", "worktrees", "task-iter-1"))).toBe(false);
  }, 60000);

  it("refuses to spend a model turn on a failure about the user's index", async () => {
    const { preserved, cfg, plan } = promotableAfterDocs(["test -f sandbox.txt"]);
    const { engine, prompts } = makeEngine(cfg, plan, preserved.root, preserved, async () => ({
      messageId: "unused",
      text: "unused",
    }));
    engine.getState().promotion = {
      status: "failed",
      branch: preserved.branch,
      detail: "cannot park a.ts (partially staged)",
    };

    const result = await engine.repairPromotion();

    expect(result.promoted).toBe(false);
    expect(result.error ?? "").toContain("promote --retry");
    expect(prompts).toHaveLength(0);
    expect(branchExists(preserved.root, preserved.branch)).toBe(true);
  }, 30000);
});
