import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, headCommit } from "../../src/engine/diff.js";
import { WorktreeManager } from "../../src/engine/worktree.js";

/**
 * ADR-48 follow-up — the sandbox's injected links are plumbing, never work.
 *
 * `linkSharedDeps` symlinks `.pi`/`.agents`/`node_modules`/`.env` from the
 * primary project into the sandbox so the agent keeps its MCP servers and skills.
 * `git add -A` used to commit them: the live failure was
 * `.pi -> <project>/.pi`, after which the next promotion aborted with
 * "updating the following directories would lose untracked files in them: .pi"
 * and neither the retry nor the thinker+executor repair could recover — it is a
 * workspace collision, not a content conflict, so no model had anything to
 * resolve. These tests pin both halves of the fix: never stage a link, and scrub
 * one an older huginn already committed.
 */

const repos: string[] = [];

function freshRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "huginn-artifacts-")));
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

describe("sandbox links are never part of an increment", () => {
  it("does not commit the shared-dep links it injected into the sandbox", () => {
    const root = freshRepo();
    fs.mkdirSync(path.join(root, ".pi"));
    fs.writeFileSync(path.join(root, ".pi", "mcp.json"), '{"mcpServers":{}}');
    fs.mkdirSync(path.join(root, "node_modules"));
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 1);

    fs.writeFileSync(path.join(sandbox.path, "work.txt"), "iteration work\n");
    const { commit } = mgr.commitPendingChanges(sandbox, "feat(iter-1): work");
    expect(commit).toBeTruthy();

    const tree = git(root, ["ls-tree", "-r", "--name-only", sandbox.branch]).stdout;
    expect(tree).toContain("work.txt");
    expect(tree).not.toContain(".pi");
    expect(tree).not.toContain("node_modules");
    // The link itself is still there: it exists for the agent, not for git.
    expect(fs.lstatSync(path.join(sandbox.path, ".pi")).isSymbolicLink()).toBe(true);
  });

  it("reports nothing pending when only an injected link is dirty", () => {
    const root = freshRepo();
    fs.mkdirSync(path.join(root, ".pi"));
    fs.writeFileSync(path.join(root, ".pi", "mcp.json"), "{}");
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 1);

    expect(mgr.commitPendingChanges(sandbox, "chore: nothing").pending).toBe(false);
    expect(headCommit(sandbox.path)).toBe(headCommit(root));
  });

  it("still commits and promotes a project file named like a link", () => {
    const root = freshRepo();
    fs.writeFileSync(path.join(root, ".env"), "TRACKED=1\n");
    commitAll(root, "chore: track .env");
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 1);

    // The sandbox got a link to the primary .env; replace it with a real edit.
    fs.rmSync(path.join(sandbox.path, ".env"));
    fs.writeFileSync(path.join(sandbox.path, ".env"), "TRACKED=2\n");
    expect(git(sandbox.path, ["status", "--porcelain"]).stdout).toContain(".env");
    const { pending } = mgr.commitPendingChanges(sandbox, "feat(iter-1): .env");
    expect(pending).toBe(true);

    expect(mgr.promoteSandbox(sandbox).promoted).toBe(true);
    expect(fs.readFileSync(path.join(root, ".env"), "utf8")).toBe("TRACKED=2\n");
  });
});

describe("file-vs-directory collisions", () => {
  it("parks the untracked directory a branch replaces with a file", () => {
    const root = freshRepo();
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "notes.txt"), "keep me\n");
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 1);

    fs.writeFileSync(path.join(sandbox.path, "data"), "branch file\n");
    commitAll(sandbox.path, "feat(iter-1): data is a file now");

    const result = mgr.promoteSandbox(sandbox);

    expect(result.promoted).toBe(true);
    expect(fs.readFileSync(path.join(root, "data"), "utf8")).toBe("branch file\n");
    const backup = result.backups?.[0];
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(path.join(backup!, "data", "notes.txt"), "utf8")).toBe("keep me\n");
  });

  it("puts the parked directory back when the integration still conflicts", () => {
    const root = freshRepo();
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "notes.txt"), "keep me\n");
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 1);

    fs.writeFileSync(path.join(sandbox.path, "data"), "branch file\n");
    commitAll(sandbox.path, "feat(iter-1): data is a file now");

    // A conflicting change makes the integration fail after the park.
    fs.writeFileSync(path.join(root, "file.txt"), "primary edit\n");
    commitAll(root, "primary edit");
    fs.writeFileSync(path.join(sandbox.path, "file.txt"), "sandbox edit\n");
    commitAll(sandbox.path, "iteration edits file.txt");

    const result = mgr.promoteSandbox(sandbox);

    expect(result.promoted).toBe(false);
    expect(fs.readFileSync(path.join(root, "data", "notes.txt"), "utf8")).toBe("keep me\n");
    expect(fs.readdirSync(path.join(root, "data"))).toEqual(["notes.txt"]);
    expect(branchExists(root, sandbox.branch)).toBe(true);
  });

  it("drops a link an older huginn committed when a preserved branch is reopened", () => {
    const root = freshRepo();
    fs.mkdirSync(path.join(root, ".pi"));
    fs.writeFileSync(path.join(root, ".pi", "mcp.json"), '{"mcpServers":{}}');
    const mgr = new WorktreeManager(root);
    const sandbox = mgr.createSandbox(root, 1);

    // Reproduce the poisoned branch: .pi committed as a self-referential link.
    fs.rmSync(path.join(sandbox.path, ".pi"), { recursive: true, force: true });
    fs.symlinkSync(path.join(root, ".pi"), path.join(sandbox.path, ".pi"));
    commitAll(sandbox.path, "feat(iter-1): poisoned increment");

    // A failed promotion keeps the branch and removes the worktree.
    expect(git(root, ["worktree", "remove", "--force", sandbox.path]).code).toBe(0);
    git(root, ["worktree", "prune"]);

    const reopened = mgr.openSandboxFromBranch(root, sandbox.branch, 1, headCommit(root)!);
    const tree = git(root, ["ls-tree", "-r", "--name-only", sandbox.branch]).stdout;
    expect(tree).not.toContain(".pi");
    // The user's real directory was never touched.
    expect(fs.readFileSync(path.join(root, ".pi", "mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
    // The dropped link is archived, and the increment still promotes.
    const archived = fs
      .readdirSync(path.join(root, ".huginn", "promotion-backup"))
      .filter((name) => name.startsWith("scrub-"));
    expect(archived.length).toBe(1);

    const result = mgr.promoteSandbox(reopened);
    expect(result.promoted).toBe(true);
    expect(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout).not.toContain(".pi");
  });
});
