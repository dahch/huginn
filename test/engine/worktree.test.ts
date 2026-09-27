import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, headCommit } from "../../src/engine/diff.js";
import {
  WorktreeManager,
  sandboxBranch,
  sandboxPath,
} from "../../src/engine/worktree.js";

/**
 * REQ-17 — Git Worktree Sandbox Isolation.
 * These tests exercise the real `git` binary against throwaway repositories so
 * branch/worktree semantics (fast-forward, cherry-pick, conflict, cleanup) are
 * validated end to end.
 */

const repos: string[] = [];

function freshRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "huginn-worktree-")));
  repos.push(dir);
  expect(git(dir, ["init", "-b", "main"]).code).toBe(0);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  // Sandboxes live under .huginn/worktrees; keep them out of the primary index
  // so `git add -A` in tests (and in real projects) never tracks them.
  fs.writeFileSync(path.join(dir, ".gitignore"), ".huginn/\n");
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  commitAll(dir, "init");
  return dir;
}

function commitAll(repo: string, message: string): void {
  expect(git(repo, ["add", "-A"]).code).toBe(0);
  const res = git(repo, ["commit", "-m", message]);
  expect(res.code).toBe(0);
}

function branchExists(repo: string, branch: string): boolean {
  return (
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0
  );
}

function statusClean(repo: string): boolean {
  return git(repo, ["status", "--porcelain"]).stdout === "";
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

describe("WorktreeManager — sandbox creation (AC-17.2, AC-17.3)", () => {
  it("derives branch/path, creates the worktree and symlinks shared deps", () => {
    const root = freshRepo();
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");
    const mgr = new WorktreeManager(root);

    const sandbox = mgr.createSandbox(root, 1);

    expect(sandbox.iteration).toBe(1);
    expect(sandbox.branch).toBe("huginn/task-iter-1");
    expect(sandbox.branch).toBe(sandboxBranch(1));
    expect(sandbox.path).toBe(sandboxPath(root, 1));
    expect(sandbox.projectRoot).toBe(root);
    expect(sandbox.baseCommit).toBe(headCommit(root));

    expect(fs.existsSync(path.join(sandbox.path, "file.txt"))).toBe(true);
    expect(branchExists(root, sandbox.branch)).toBe(true);

    const nodeModules = path.join(sandbox.path, "node_modules");
    expect(fs.lstatSync(nodeModules).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(nodeModules)).toBe(path.join(root, "node_modules"));

    const env = path.join(sandbox.path, ".env");
    expect(fs.lstatSync(env).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(env)).toBe(path.join(root, ".env"));
  });

  it("does not symlink deps absent from the root", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 2);

    expect(fs.existsSync(path.join(sandbox.path, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.path, ".env"))).toBe(false);
  });

  it("fails closed when the branch or path already exists (AC-17.2)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 3);

    expect(() => mgr.createSandbox(root, 3)).toThrow(/already exists/);
    // No mutation beyond the original sandbox.
    expect(branchExists(root, sandbox.branch)).toBe(true);
    expect(fs.existsSync(sandbox.path)).toBe(true);
    expect(mgr.listSandboxes()).toHaveLength(1);
  });
});

describe("WorktreeManager — promotion (AC-17.4)", () => {
  it("fast-forwards the primary branch and removes worktree + branch", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 4);

    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    fs.writeFileSync(path.join(sandbox.path, "new.txt"), "new\n");
    commitAll(sandbox.path, "sandbox work");

    const res = mgr.promoteSandbox(sandbox);

    expect(res.method).toBe("ff");
    expect(res.promoted).toBe(true);
    expect(res.commits).toHaveLength(1);
    expect(headCommit(root)).toBe(res.commits[0]);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("sandbox\n");
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(true);

    expect(fs.existsSync(sandbox.path)).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(false);
    expect(statusClean(root)).toBe(true);
  });

  it("cherry-picks when the primary branch has diverged (non-conflicting)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 5);

    fs.writeFileSync(path.join(sandbox.path, "sandbox.txt"), "from sandbox\n");
    commitAll(sandbox.path, "sandbox change");

    // Diverge the primary branch after the sandbox was created.
    fs.writeFileSync(path.join(root, "primary.txt"), "from primary\n");
    commitAll(root, "primary change");

    const res = mgr.promoteSandbox(sandbox);

    expect(res.method).toBe("cherry-pick");
    expect(res.promoted).toBe(true);
    expect(res.commits).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "sandbox.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "primary.txt"))).toBe(true);
    expect(statusClean(root)).toBe(true);
    expect(fs.existsSync(sandbox.path)).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(false);
  });

  it("reports a conflict, restores the primary branch and preserves the branch (AC-17.4)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 6);

    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    commitAll(sandbox.path, "sandbox edit");
    const sandboxCommit = headCommit(sandbox.path);

    fs.writeFileSync(path.join(root, "file.txt"), "primary\n");
    commitAll(root, "primary edit");
    const primaryHead = headCommit(root);

    const res = mgr.promoteSandbox(sandbox);

    expect(res.method).toBe("cherry-pick");
    expect(res.promoted).toBe(false);
    // Primary tree is untouched and clean (cherry-pick aborted).
    expect(headCommit(root)).toBe(primaryHead);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("primary\n");
    expect(statusClean(root)).toBe(true);
    // The worktree is removed, but the branch is preserved so the conflicting
    // commits can be recovered manually.
    expect(fs.existsSync(sandbox.path)).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(true);
    expect(headCommit(sandbox.projectRoot)).toBe(primaryHead);
    expect(git(root, ["rev-parse", sandbox.branch]).stdout).toBe(sandboxCommit);
  });

  it("is a no-op with method 'none' when the sandbox has no commits", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 7);
    const before = headCommit(root);

    const res = mgr.promoteSandbox(sandbox);

    expect(res.method).toBe("none");
    expect(res.promoted).toBe(false);
    expect(res.commits).toEqual([]);
    expect(headCommit(root)).toBe(before);
    expect(fs.existsSync(sandbox.path)).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(false);
  });
});

describe("WorktreeManager — discard & cleanup (AC-17.5)", () => {
  it("discards a sandbox without touching the primary working tree, idempotently", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 8);

    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    commitAll(sandbox.path, "sandbox edit");
    const before = headCommit(root);

    mgr.discardSandbox(sandbox);

    expect(headCommit(root)).toBe(before);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("base\n");
    expect(statusClean(root)).toBe(true);
    expect(fs.existsSync(sandbox.path)).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(false);

    // Idempotent: a second discard must not throw.
    expect(() => mgr.discardSandbox(sandbox)).not.toThrow();
  });

  it("lists only sandboxes under .huginn/worktrees and cleans them all up", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const a = mgr.createSandbox(root, 9);
    const b = mgr.createSandbox(root, 10);

    const listed = mgr.listSandboxes();
    expect(listed.map((s) => s.iteration).sort((x, y) => x - y)).toEqual([9, 10]);
    for (const s of listed) {
      expect(s.path.startsWith(path.join(root, ".huginn", "worktrees"))).toBe(true);
      expect(s.projectRoot).toBe(root);
    }

    mgr.cleanupAll();

    expect(mgr.listSandboxes()).toEqual([]);
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(b.path)).toBe(false);
    expect(branchExists(root, a.branch)).toBe(false);
    expect(branchExists(root, b.branch)).toBe(false);
  });

  it("cleanupAll reclaims a conflict-preserved branch so the iteration can be sandboxed again (AC-17.4)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 11);

    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    commitAll(sandbox.path, "sandbox edit");

    fs.writeFileSync(path.join(root, "file.txt"), "primary\n");
    commitAll(root, "primary edit");

    const res = mgr.promoteSandbox(sandbox);
    expect(res.promoted).toBe(false);
    // Worktree removed, branch preserved for recovery.
    expect(fs.existsSync(sandbox.path)).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(true);

    // Re-creating the same iteration fails closed while the branch lingers...
    expect(() => mgr.createSandbox(root, 11)).toThrow(/already exists/);

    // ...until cleanupAll sweeps the orphaned branch.
    const reclaimed = mgr.cleanupAll();
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    expect(branchExists(root, sandbox.branch)).toBe(false);

    // Now the iteration can be sandboxed again.
    const again = mgr.createSandbox(root, 11);
    expect(again.branch).toBe(sandbox.branch);
    expect(fs.existsSync(again.path)).toBe(true);
  });

  it("does not match a sibling directory whose name shares the worktrees prefix", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    // A worktree at `.../.huginn/worktrees-old/x` must not be treated as a
    // sandbox under `.../.huginn/worktrees`.
    const sibling = path.join(root, ".huginn", "worktrees-old", "task-iter-99");
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    expect(git(root, ["worktree", "add", "-b", "huginn/task-iter-99", sibling, "HEAD"]).code).toBe(0);

    expect(mgr.listSandboxes()).toEqual([]);

    mgr.cleanupAll();
    // The sibling worktree is untouched; it was never treated as a sandbox.
    expect(fs.existsSync(sibling)).toBe(true);
  });
});
