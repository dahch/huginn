import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, headCommit } from "../../src/engine/diff.js";
import {
  WorktreeManager,
  promotionBackupDir,
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

  /**
   * SEC-104 — a cloned repository can commit `.huginn` as a symlink. Creating the
   * worktree through it would put the whole checkout (and the `.env`/`node_modules`
   * links) outside the project, so `createSandbox` refuses it.
   */
  it("refuses to create a sandbox through a repository-shipped .huginn symlink (SEC-104)", () => {
    const root = freshRepo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "huginn-outside-")));
    repos.push(outside);
    fs.symlinkSync(outside, path.join(root, ".huginn"), "dir");

    const mgr = new WorktreeManager(root);
    expect(() => mgr.createSandbox(root, 18)).toThrow(/Cannot create sandbox/);
    // Nothing was created outside the project.
    expect(fs.readdirSync(outside)).toEqual([]);
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

  /**
   * ADR-48 / REQ-49 — a completed iteration must never be stranded by a `git
   * merge` that refuses to overwrite an *untracked* file. This is the exact
   * scenario that reported `🛑 ABORTED` with an empty project directory.
   */
  it("parks an untracked collision, integrates, and reports the backup (AC-49.1)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    // The primary tree holds an untracked rules file (huginn's own `setup` writes
    // `AGENTS.md` after the bootstrap commit)...
    fs.writeFileSync(path.join(root, "AGENTS.md"), "the user's own agents\n");
    const sandbox = mgr.createSandbox(root, 12);
    // ...and the iteration's doc-writer creates the same path in the sandbox.
    fs.writeFileSync(path.join(sandbox.path, "AGENTS.md"), "sandbox agents\n");
    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    commitAll(sandbox.path, "docs + edit");

    const res = mgr.promoteSandbox(sandbox);

    // The integration now succeeds instead of aborting.
    expect(res.promoted).toBe(true);
    expect(res.method).toBe("ff");
    expect(headCommit(root)).toBe(res.commits[0]);
    // The branch's version is on the primary branch...
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("sandbox agents\n");
    // ...and the user's file is preserved in the reported backup directory.
    expect(res.backups).toBeDefined();
    expect(res.backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(res.backups![0], "AGENTS.md"), "utf8")).toBe(
      "the user's own agents\n",
    );
    expect(statusClean(root)).toBe(true);
    expect(fs.existsSync(sandbox.path)).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(false);
  });

  it("restores parked files and preserves the branch when integration still conflicts (AC-49.2)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "the user's own agents\n");
    const sandbox = mgr.createSandbox(root, 13);

    fs.writeFileSync(path.join(sandbox.path, "AGENTS.md"), "sandbox agents\n");
    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    commitAll(sandbox.path, "docs + edit");

    // Diverge the primary on the same *tracked* file (without staging the
    // untracked rules file) so the integration conflicts.
    fs.writeFileSync(path.join(root, "file.txt"), "primary\n");
    expect(git(root, ["add", "file.txt"]).code).toBe(0);
    expect(git(root, ["commit", "-m", "primary edit"]).code).toBe(0);
    const primaryHead = headCommit(root);

    const res = mgr.promoteSandbox(sandbox);

    expect(res.promoted).toBe(false);
    expect(res.method).toBe("cherry-pick");
    expect(res.detail).toBeTruthy();
    // The user's untracked file is back, byte for byte...
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("the user's own agents\n");
    // ...nothing is left parked in a backup directory, and no phantom path is
    // reported for a directory the rollback has just removed (NFR-17)...
    const backupRoot = path.join(root, ".huginn", "promotion-backup");
    expect(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).length : 0).toBe(0);
    expect(res.backups).toBeUndefined();
    // ...the primary tracked file is untouched and the branch is preserved.
    expect(headCommit(root)).toBe(primaryHead);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("primary\n");
    expect(branchExists(root, sandbox.branch)).toBe(true);
    expect(fs.existsSync(sandbox.path)).toBe(false);
  });

  it("restores a parked file with its original mode (AC-49.1)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const secret = path.join(root, "AGENTS.md");
    fs.writeFileSync(secret, "private\n");
    fs.chmodSync(secret, 0o600);
    const sandbox = mgr.createSandbox(root, 19);
    fs.writeFileSync(path.join(sandbox.path, "AGENTS.md"), "sandbox agents\n");
    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    commitAll(sandbox.path, "docs + edit");

    // Diverge on the tracked file so the integration conflicts and rolls back.
    fs.writeFileSync(path.join(root, "file.txt"), "primary\n");
    expect(git(root, ["add", "file.txt"]).code).toBe(0);
    expect(git(root, ["commit", "-m", "primary edit"]).code).toBe(0);

    const res = mgr.promoteSandbox(sandbox);

    expect(res.promoted).toBe(false);
    expect(res.backups).toBeUndefined();
    // The restored file kept its private mode, not the ambient umask's.
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(secret, "utf8")).toBe("private\n");
  });

  it("derives the backup directory under .huginn/promotion-backup (AC-49.1)", () => {
    const root = path.join(path.sep, "tmp", "proj");
    expect(promotionBackupDir(root, "stamp")).toBe(
      path.join(root, ".huginn", "promotion-backup", "stamp"),
    );
    const prefix = path.join(root, ".huginn", "promotion-backup") + path.sep;
    const auto = promotionBackupDir(root);
    expect(auto.startsWith(prefix)).toBe(true);
    // The default stamp must be filesystem-safe (`:`/`.` are not).
    expect(auto.slice(prefix.length)).not.toMatch(/[:.]/);
  });

  /**
   * REV-001 — the next run's pre-run sweep must not delete the only copy of a
   * preserved iteration's commits, nor be blocked from re-sandboxing it.
   */
  it("renames a preserved branch out of the reclaim namespace (REV-001)", () => {
    const root = freshRepo();
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 20);
    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox\n");
    commitAll(sandbox.path, "sandbox edit");
    fs.writeFileSync(path.join(root, "file.txt"), "primary\n");
    commitAll(root, "primary edit");

    const res = mgr.promoteSandbox(sandbox);
    expect(res.promoted).toBe(false);
    expect(branchExists(root, sandbox.branch)).toBe(true);

    const kept = mgr.preserveOrphanBranch(sandbox.branch);

    expect(kept).toMatch(/^huginn\/preserved\//);
    expect(branchExists(root, sandbox.branch)).toBe(false);
    expect(git(root, ["rev-parse", kept!]).code).toBe(0);
    // The sweep can no longer see it, so the iteration can be sandboxed again
    // while the preserved commits stay reachable.
    mgr.cleanupAll();
    expect(git(root, ["rev-parse", kept!]).code).toBe(0);
    expect(mgr.createSandbox(root, 20).branch).toBe("huginn/task-iter-20");
  });

  it("parks every colliding untracked file, not just the first (AC-49.1)", () => {
    const root = freshRepo();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "user agents\n");
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "user claude\n");
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 16);
    fs.writeFileSync(path.join(sandbox.path, "AGENTS.md"), "sandbox agents\n");
    fs.writeFileSync(path.join(sandbox.path, "CLAUDE.md"), "sandbox claude\n");
    commitAll(sandbox.path, "docs");

    const res = mgr.promoteSandbox(sandbox);

    expect(res.promoted).toBe(true);
    expect(res.backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(res.backups![0], "AGENTS.md"), "utf8")).toBe("user agents\n");
    expect(fs.readFileSync(path.join(res.backups![0], "CLAUDE.md"), "utf8")).toBe("user claude\n");
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("sandbox agents\n");
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("sandbox claude\n");
  });

  it("backs up an untracked symlink as a link, never following it (SEC-002)", () => {
    const root = freshRepo();
    const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "huginn-target-")));
    repos.push(target);
    const secret = path.join(target, "credentials");
    fs.writeFileSync(secret, "AWS_SECRET=shhh\n");

    const mgr = new WorktreeManager(root);
    fs.symlinkSync(secret, path.join(root, "AGENTS.md"));
    const sandbox = mgr.createSandbox(root, 15);
    fs.writeFileSync(path.join(sandbox.path, "AGENTS.md"), "sandbox agents\n");
    commitAll(sandbox.path, "docs");

    const res = mgr.promoteSandbox(sandbox);

    expect(res.promoted).toBe(true);
    const backup = path.join(res.backups![0], "AGENTS.md");
    // The link itself is preserved — its target was never read or copied.
    expect(fs.lstatSync(backup).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(backup)).toBe(secret);
  });

  /**
   * SEC-001 — a cloned repository can ship `.huginn/promotion-backup` as a
   * symlink. The destination is screened like every other `.huginn` writer, so
   * huginn must refuse it (and must not lose the iteration's work either).
   */
  it("refuses a repository-shipped symlink as the backup destination (SEC-001)", () => {
    const root = freshRepo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "huginn-outside-")));
    repos.push(outside);
    fs.mkdirSync(path.join(root, ".huginn"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, ".huginn", "promotion-backup"), "dir");

    const mgr = new WorktreeManager(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "the user's own agents\n");
    const sandbox = mgr.createSandbox(root, 14);
    fs.writeFileSync(path.join(sandbox.path, "AGENTS.md"), "sandbox agents\n");
    commitAll(sandbox.path, "docs");

    const res = mgr.promoteSandbox(sandbox);

    expect(res.promoted).toBe(false);
    expect(res.failure).toBe("failed");
    expect(res.detail).toMatch(/refused/i);
    // No phantom backup path is reported when nothing is parked there.
    expect(res.backups).toBeUndefined();
    // Nothing was written through the link, and the user's file is untouched.
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("the user's own agents\n");
    // The finished work is preserved on its branch, never discarded.
    expect(branchExists(root, sandbox.branch)).toBe(true);
    expect(fs.existsSync(sandbox.path)).toBe(false);
  });

  /**
   * SEC-003 / NFR-15 — a parking failure used to throw, which made the engine's
   * `finally` discard the sandbox and delete the branch. It must now be a reported
   * failure that preserves the finished iteration.
   */
  it("reports a failed promotion — never discards — when a collision cannot be parked (SEC-003)", () => {
    const root = freshRepo();
    // A repository-shipped *file* where the backup directory belongs.
    fs.mkdirSync(path.join(root, ".huginn"), { recursive: true });
    fs.writeFileSync(path.join(root, ".huginn", "promotion-backup"), "not a directory\n");

    const mgr = new WorktreeManager(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "the user's own agents\n");
    const sandbox = mgr.createSandbox(root, 17);
    fs.writeFileSync(path.join(sandbox.path, "AGENTS.md"), "sandbox agents\n");
    commitAll(sandbox.path, "docs");

    const res = mgr.promoteSandbox(sandbox);

    expect(res.promoted).toBe(false);
    expect(res.failure).toBe("failed");
    expect(res.detail).toBeTruthy();
    // Nothing was parked, so no backup path is reported.
    expect(res.backups).toBeUndefined();
    // The user's file is untouched and the finished work survives on its branch.
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("the user's own agents\n");
    expect(branchExists(root, sandbox.branch)).toBe(true);
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
