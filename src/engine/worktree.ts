import { dirname, join, sep } from "node:path";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { git, headCommit } from "./diff.js";

/**
 * A git worktree sandbox created for a single iteration.
 *
 * The primary checkout is left untouched; all build/test work happens inside
 * `path` on the ephemeral `branch`.
 */
export interface Sandbox {
  iteration: number;
  path: string;
  branch: string;
  projectRoot: string;
  baseCommit: string;
}

/** Result of integrating a sandbox back into the primary working branch. */
export interface PromoteResult {
  /** Whether the sandbox commits were integrated into the primary branch. */
  promoted: boolean;
  /** Integration strategy used: fast-forward, cherry-pick, or no-op. */
  method: "ff" | "cherry-pick" | "none";
  /** Commit SHAs that were (or were meant to be) integrated. */
  commits: string[];
}

/** Domain error raised for fail-closed worktree operations. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** Shared dependency entries symlinked from the project root into a sandbox. */
const SHARED_DEPS = ["node_modules", ".env"] as const;

/** Branch name for a given iteration: `huginn/task-iter-<N>`. */
export function sandboxBranch(iteration: number): string {
  return `huginn/task-iter-${iteration}`;
}

/** Absolute worktree path for a given iteration: `<root>/.huginn/worktrees/task-iter-<N>`. */
export function sandboxPath(projectRoot: string, iteration: number): string {
  return join(projectRoot, ".huginn", "worktrees", `task-iter-${iteration}`);
}

/**
 * Resolve symlinks in a path (e.g. macOS `/var` → `/private/var`) so paths
 * reported by `git worktree list` can be compared with the caller's root.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Manages ephemeral git worktree sandboxes so each orchestration iteration can
 * build in isolation and then be promoted (or discarded) into the primary tree.
 *
 * All git access goes through the hardened `git()` helper from `diff.ts`
 * (dual-runtime Bun/Node, `core.fsmonitor=false`, `core.hooksPath=/dev/null`).
 */
export class WorktreeManager {
  constructor(private readonly projectRoot: string) {}

  /**
   * Create a sandbox worktree for `iteration`.
   *
   * Fails closed (throws, without mutating state) when the target branch or
   * directory already exists. On success, shared dependencies are symlinked in
   * (best effort) and the new {@link Sandbox} is returned.
   */
  createSandbox(projectRoot: string, iteration: number): Sandbox {
    const root = projectRoot || this.projectRoot;
    const branch = sandboxBranch(iteration);
    const path = sandboxPath(root, iteration);

    const baseCommit = headCommit(root);
    if (!baseCommit) {
      throw new WorktreeError(`Cannot create sandbox: ${root} has no HEAD commit`);
    }

    if (this.branchExists(root, branch)) {
      throw new WorktreeError(`Sandbox branch already exists: ${branch}`);
    }
    if (existsSync(path)) {
      throw new WorktreeError(`Sandbox path already exists: ${path}`);
    }

    mkdirSync(dirname(path), { recursive: true });

    const res = git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
    if (res.code !== 0) {
      throw new WorktreeError(
        `git worktree add failed for ${branch}: ${res.stderr || res.stdout}`,
      );
    }

    this.linkSharedDeps(root, path);

    return { iteration, path, branch, projectRoot: root, baseCommit };
  }

  /**
   * Symlink `node_modules` and/or `.env` from the project root into the sandbox
   * when present at the root and absent in the sandbox. Never overwrites; any
   * failure is a non-fatal warning (Windows symlink privileges, etc.).
   */
  linkSharedDeps(projectRoot: string, sandboxDir: string): void {
    for (const entry of SHARED_DEPS) {
      const source = join(projectRoot, entry);
      const target = join(sandboxDir, entry);

      if (!existsSync(source)) continue;
      if (existsSync(target)) continue; // never overwrite a real file/dir

      try {
        const isDir = statSync(source).isDirectory();
        symlinkSync(source, target, isDir ? "dir" : "file");
      } catch (err) {
        console.warn(
          `[huginn] worktree: could not symlink ${entry} into sandbox: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Integrate the sandbox commits into the primary working branch, then remove
   * the worktree and delete the ephemeral branch.
   *
   * Uses `git merge --ff-only` when possible, otherwise `git cherry-pick`. A
   * failed cherry-pick is aborted so the primary tree is left uncorrupted; the
   * worktree is removed but the branch is preserved for manual recovery
   * (AC-17.4), and `{ promoted: false }` is returned with a warning naming it.
   */
  promoteSandbox(sandbox: Sandbox): PromoteResult {
    const root = sandbox.projectRoot;

    // Record the active branch before promotion (used for diagnostics).
    const activeBranch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;

    const commits = this.sandboxCommits(root, sandbox);

    if (commits.length === 0) {
      this.removeWorktreeAndBranch(root, sandbox);
      return { promoted: false, method: "none", commits };
    }

    const merge = git(root, ["merge", "--ff-only", sandbox.branch]);
    if (merge.code === 0) {
      this.removeWorktreeAndBranch(root, sandbox);
      return { promoted: true, method: "ff", commits };
    }

    const cherry = git(root, [
      "cherry-pick",
      `${sandbox.baseCommit}..${sandbox.branch}`,
    ]);
    if (cherry.code === 0) {
      this.removeWorktreeAndBranch(root, sandbox);
      return { promoted: true, method: "cherry-pick", commits };
    }

    // Conflict: restore the primary tree to its pre-promotion state, remove the
    // worktree, but KEEP the branch so the commits are recoverable by hand.
    git(root, ["cherry-pick", "--abort"]);
    this.removeWorktree(root, sandbox);
    console.warn(
      `[huginn] worktree: promotion of ${sandbox.branch} conflicted on ${activeBranch}; ` +
        `primary tree restored, branch ${sandbox.branch} preserved for manual recovery`,
    );
    return { promoted: false, method: "cherry-pick", commits };
  }

  /**
   * Remove a sandbox worktree and its ephemeral branch without touching the
   * primary working tree. Idempotent and tolerant of already-removed resources.
   */
  discardSandbox(sandbox: Sandbox): void {
    this.removeWorktreeAndBranch(sandbox.projectRoot, sandbox);
  }

  /**
   * List every sandbox worktree under `<projectRoot>/.huginn/worktrees/`.
   */
  listSandboxes(): Sandbox[] {
    const root = this.projectRoot;
    const base = join(canonicalize(root), ".huginn", "worktrees");
    const res = git(root, ["worktree", "list", "--porcelain"]);
    if (res.code !== 0) return [];

    const sandboxes: Sandbox[] = [];
    let current: { path?: string; head?: string; branch?: string } | null = null;

    const flush = (): void => {
      if (!current || !current.path || !current.branch) {
        current = null;
        return;
      }
      const worktreePath = current.path;
      // Require a path-separator boundary so a sibling directory such as
      // `.../worktrees-old` can never be mistaken for a sandbox under
      // `.../worktrees`.
      if (!worktreePath.startsWith(base + sep)) {
        current = null;
        return;
      }
      const branch = current.branch.replace(/^refs\/heads\//, "");
      const match = /^huginn\/task-iter-(\d+)$/.exec(branch);
      if (!match) {
        current = null;
        return;
      }
      sandboxes.push({
        iteration: Number(match[1]),
        path: worktreePath,
        branch,
        projectRoot: root,
        baseCommit: current.head ?? "",
      });
      current = null;
    };

    for (const rawLine of res.stdout.split("\n")) {
      const line = rawLine.trimEnd();
      if (!line) {
        flush();
        continue;
      }
      if (line.startsWith("worktree ")) {
        if (current) flush();
        current = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ") && current) {
        current.head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.slice("branch ".length);
      }
    }
    flush();

    return sandboxes;
  }

  /**
   * Safety net: discard every known sandbox, then reclaim any orphaned
   * `huginn/task-iter-*` branches with no worktree (e.g. a branch preserved by
   * a conflicted promotion). Returns how many resources were reclaimed so the
   * caller can log an accurate count.
   */
  cleanupAll(): number {
    const sandboxes = this.listSandboxes();
    for (const sandbox of sandboxes) {
      this.discardSandbox(sandbox);
    }
    const orphanedBranches = this.orphanedSandboxBranches();
    for (const branch of orphanedBranches) {
      // Best-effort: a branch still checked out in a worktree makes git refuse,
      // which is exactly the correct outcome (it is not orphaned).
      git(this.projectRoot, ["branch", "-D", branch]);
    }
    return sandboxes.length + orphanedBranches.length;
  }

  /**
   * Every `huginn/task-iter-*` branch with no associated worktree. Branches
   * still checked out by a listed sandbox are excluded (they are reclaimed by
   * {@link discardSandbox} instead).
   */
  private orphanedSandboxBranches(): string[] {
    const active = new Set(this.listSandboxes().map((s) => s.branch));
    const res = git(this.projectRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/huginn/task-iter-*",
    ]);
    if (res.code !== 0) return [];
    return res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((branch) => branch.length > 0 && !active.has(branch));
  }

  /** True when `refs/heads/<branch>` resolves (git show-ref exit 0). */
  private branchExists(projectRoot: string, branch: string): boolean {
    return (
      git(projectRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]).code === 0
    );
  }

  /** Commit SHAs reachable from the sandbox branch but not from its base. */
  private sandboxCommits(projectRoot: string, sandbox: Sandbox): string[] {
    const res = git(projectRoot, [
      "log",
      "--format=%H",
      `${sandbox.baseCommit}..${sandbox.branch}`,
    ]);
    if (res.code !== 0) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /** Remove the worktree and delete the branch; both are best-effort. */
  private removeWorktreeAndBranch(projectRoot: string, sandbox: Sandbox): void {
    this.removeWorktree(projectRoot, sandbox);
    git(projectRoot, ["branch", "-D", sandbox.branch]);
  }

  /**
   * Remove the worktree but keep its branch (conflict recovery, AC-17.4); both
   * git calls are best-effort and prune stale administrative entries.
   */
  private removeWorktree(projectRoot: string, sandbox: Sandbox): void {
    // Tolerant: a missing/already-removed worktree makes git exit non-zero.
    git(projectRoot, ["worktree", "remove", "--force", sandbox.path]);
    // Prune stale administrative entries left by a partially removed worktree.
    git(projectRoot, ["worktree", "prune"]);
  }
}
