import { dirname, join, sep } from "node:path";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { git, headCommit } from "./diff.js";
import { sanitizeTerminalText } from "../util/text.js";
import { assertDocPath, lstatOrUndefined } from "../util/docPath.js";

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
  /**
   * Backup directory holding the untracked files that had to be moved aside so
   * the integration could proceed (ADR-48 / AC-49.1). Present only when at least
   * one file was parked.
   */
  backups?: string[];
  /** Why an integration failed, sanitized, when `promoted` is false. */
  detail?: string;
  /**
   * Which kind of failure this is: an integration **conflict** (the two branch
   * histories disagree) or a **failed** promotion (huginn could not even attempt
   * the integration — e.g. a colliding file it must not touch). Both preserve the
   * sandbox branch; the engine records the distinction.
   */
  failure?: "conflict" | "failed";
}

/**
 * `<root>/.huginn/promotion-backup/<stamp>` — where {@link WorktreeManager} parks
 * untracked files that an integration would otherwise overwrite (ADR-48).
 *
 * The directory is screened with the shared containment helper before use and
 * carries a self-ignoring `.gitignore`, so parked content cannot be committed
 * even on a project whose `.gitignore` does not already list `.huginn/`.
 */
export function promotionBackupDir(projectRoot: string, stamp = timestamp()): string {
  return join(projectRoot, ".huginn", "promotion-backup", stamp);
}

/** A filesystem-safe timestamp (`:` and `.` are not portable in path names). */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** A caught value's message, for a report line. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A parked untracked file, and whether it was a symlink (restore it as one). */
interface ParkedEntry {
  rel: string;
  link: boolean;
}

/**
 * Untracked files that were parked so an integration could proceed, plus the way
 * to put them back when it does not (ADR-48).
 */
interface ParkedCollisions {
  /** The backup directory, present only when at least one file was parked. */
  backups?: string[];
  /**
   * Restore every parked file to its original path. Returns the backup
   * directories that still hold content afterwards, or `undefined` when the
   * rollback was complete and the backup was dropped — so a caller never names a
   * path that no longer exists (NFR-17).
   */
  restore: () => string[] | undefined;
  /**
   * Why parking failed, when it did. A failure here must never integrate, and must
   * never discard the sandbox — the caller reports it instead.
   */
  error?: string;
}

/**
 * Move one untracked file aside, preserving it exactly: a **symlink is backed up
 * as a link** (never followed, so its target is never read or clobbered), a
 * regular file is copied with its mode (minus setuid/setgid bits). Anything else
 * (a directory, a FIFO) is refused — huginn does not know how to restore it.
 */
function parkEntry(root: string, dir: string, rel: string): ParkedEntry {
  const source = join(root, rel);
  const target = join(dir, rel);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    rmSync(source, { force: true });
    return { rel, link: true };
  }
  if (!stat.isFile()) {
    throw new Error(`not a regular file`);
  }
  copyFileSync(source, target);
  chmodSync(target, stat.mode & 0o777);
  rmSync(source, { force: true });
  return { rel, link: false };
}

/**
 * Put one parked file back where it was, preserving its exact form. **Throws**
 * when the backup copy is missing, so the caller counts the restore as failed and
 * keeps the backup directory instead of silently dropping it.
 */
function restoreEntry(root: string, dir: string, entry: ParkedEntry): void {
  const source = join(dir, entry.rel);
  const stat = lstatOrUndefined(source);
  if (!stat) throw new Error(`backup copy for ${entry.rel} is missing`);
  const target = join(root, entry.rel);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  if (entry.link) {
    symlinkSync(readlinkSync(source), target);
  } else {
    copyFileSync(source, target);
    // `copyFileSync` creates with the ambient umask, so restore the mode too.
    chmodSync(target, stat.mode & 0o777);
  }
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

    // Never create (or check out into) a path a cloned repository can redirect: a
    // tracked `.huginn` symlink would otherwise put the whole worktree — and the
    // project's `.env`/`node_modules` links — outside the project (SEC-104), the
    // same failure class the promotion backup is screened for (ADR-48).
    try {
      assertDocPath(path, {
        projectPath: root,
        label: "the sandbox worktree",
        action: "create",
      });
    } catch (err) {
      throw new WorktreeError(`Cannot create sandbox: ${message(err)}`);
    }

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

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
   * Uses `git merge --ff-only` when possible, otherwise `git cherry-pick`. Before
   * integrating, every **untracked** file the branch would overwrite is parked
   * under `.huginn/promotion-backup/` — git refuses such a merge, which used to
   * strand a completed iteration silently (ADR-48). A failed cherry-pick is
   * aborted so the primary tree is left uncorrupted, every parked file is put
   * back, the worktree is removed but the branch is preserved for manual recovery
   * (AC-17.4, AC-49.2), and `{ promoted: false }` is returned with a warning
   * naming it.
   */
  promoteSandbox(sandbox: Sandbox): PromoteResult {
    const root = sandbox.projectRoot;

    // Record the active branch before promotion (used for diagnostics).
    const activeBranch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;

    const { ok, commits } = this.sandboxCommits(root, sandbox);
    if (!ok) {
      // A git failure is not "no commits": never delete the branch on a read we
      // could not complete (REV-005).
      return {
        promoted: false,
        method: "none",
        commits: [],
        failure: "failed",
        detail: "could not read the sandbox branch's commits",
      };
    }

    if (commits.length === 0) {
      this.removeWorktreeAndBranch(root, sandbox);
      return { promoted: false, method: "none", commits };
    }

    // Resolve untracked collisions *before* integrating: `git merge --ff-only`
    // refuses to overwrite a file the user has not committed, which is what
    // stranded the iteration this ADR exists for.
    const parked = this.parkUntrackedCollisions(root, sandbox);
    if (parked.error) {
      // huginn could not safely move the colliding file(s): do not integrate, but
      // never discard the iteration either — the branch keeps the finished work
      // and the run reports a *failed* promotion (AC-49.2, AC-49.3, NFR-15).
      // `parkUntrackedCollisions` has already rolled back; its `backups` is the
      // authoritative pointer to anything it could not put back (REV-002).
      this.removeWorktree(root, sandbox);
      return {
        promoted: false,
        method: "cherry-pick",
        commits,
        failure: "failed",
        detail: parked.error,
        backups: parked.backups,
      };
    }

    const merge = git(root, ["merge", "--ff-only", sandbox.branch]);
    if (merge.code === 0) {
      this.removeWorktreeAndBranch(root, sandbox);
      return { promoted: true, method: "ff", commits, backups: parked.backups };
    }

    const cherry = git(root, [
      "cherry-pick",
      `${sandbox.baseCommit}..${sandbox.branch}`,
    ]);
    if (cherry.code === 0) {
      this.removeWorktreeAndBranch(root, sandbox);
      return { promoted: true, method: "cherry-pick", commits, backups: parked.backups };
    }

    // Conflict: restore the primary tree to its pre-promotion state (including
    // any parked file), remove the worktree, but KEEP the branch so the commits
    // are recoverable by hand.
    const detail = sanitizeTerminalText(
      (cherry.stderr || merge.stderr || "integration conflicted").trim(),
    );
    git(root, ["cherry-pick", "--abort"]);
    const leftovers = parked.restore();
    this.removeWorktree(root, sandbox);
    console.warn(
      `[huginn] worktree: promotion of ${sandbox.branch} conflicted on ${activeBranch}; ` +
        `primary tree restored, branch ${sandbox.branch} preserved for manual recovery`,
    );
    return {
      promoted: false,
      method: "cherry-pick",
      commits,
      detail,
      failure: "conflict",
      // Only a directory that still holds content is reported (NFR-17).
      backups: leftovers,
    };
  }

  /**
   * Untracked, non-ignored files in the primary tree that the sandbox branch would
   * add or modify — exactly the paths `git merge` refuses to overwrite
   * (AC-49.1). Paths that escape the project, and huginn's own `.huginn`/`.harness`
   * artifacts, are dropped; `-z` is used so git never C-quotes a name.
   */
  private untrackedCollisions(root: string, sandbox: Sandbox): string[] {
    const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
    if (untracked.code !== 0) return [];
    const branchFiles = new Set(
      git(root, ["diff", "--name-only", "-z", `${sandbox.baseCommit}..${sandbox.branch}`])
        .stdout.split("\0")
        .filter((rel) => rel.length > 0),
    );
    if (branchFiles.size === 0) return [];
    return untracked.stdout
      .split("\0")
      .filter(
        (rel) =>
          rel.length > 0 &&
          branchFiles.has(rel) &&
          !rel.startsWith("/") &&
          !rel.startsWith("..") &&
          !rel.startsWith(".huginn/") &&
          !rel.startsWith(".harness/"),
      );
  }

  /**
   * Move every colliding untracked file into `.huginn/promotion-backup/<stamp>/`,
   * preserving it exactly, so the integration can proceed. Returns the backup
   * directory (when anything moved) and a restore closure.
   *
   * Never throws: a failure is returned as {@link ParkedCollisions.error} after
   * putting back whatever already moved, so the caller can preserve the sandbox
   * instead of discarding a completed iteration (ADR-48, NFR-15).
   */
  private parkUntrackedCollisions(root: string, sandbox: Sandbox): ParkedCollisions {
    const collisions = this.untrackedCollisions(root, sandbox);
    if (collisions.length === 0) return { restore: () => undefined };

    // Never write (or `rm -rf`) through a link a cloned repository can ship: the
    // destination is screened exactly like the harness state, the receipts and
    // the server log (SEC-102/SEC-101). The stamp is made unique, so a re-entrant
    // promotion can never clobber a previous backup (REV-007).
    const stamp = timestamp();
    let dir: string | undefined;
    for (let attempt = 0; attempt < 64 && dir === undefined; attempt++) {
      const candidate = promotionBackupDir(root, attempt === 0 ? stamp : `${stamp}-${attempt}`);
      let screened: string;
      try {
        screened = assertDocPath(candidate, {
          projectPath: root,
          label: "the promotion backup",
          action: "write",
        });
      } catch (err) {
        return {
          restore: () => undefined,
          error: sanitizeTerminalText(`backup destination refused: ${message(err)}`),
        };
      }
      if (!lstatOrUndefined(screened)) dir = screened;
    }
    if (dir === undefined) {
      return { restore: () => undefined, error: "could not allocate a promotion backup directory" };
    }

    const parked: ParkedEntry[] = [];

    let dirKept = false;
    const putBack = (): string[] | undefined => {
      let allRestored = true;
      for (const entry of parked) {
        try {
          restoreEntry(root, dir, entry);
        } catch {
          allRestored = false;
        }
      }
      // The backup is the source of truth: it is only dropped once every file is
      // verifiably back, so a failed restore can never lose data silently.
      if (allRestored) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Leaving the backup behind is always the safe outcome.
          dirKept = true;
        }
      } else {
        dirKept = true;
      }
      return dirKept ? [dir] : undefined;
    };

    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Self-ignoring: parked content is never committed even on a project whose
      // `.gitignore` does not list `.huginn/`.
      writeFileSync(join(dir, ".gitignore"), "*\n", { mode: 0o600, flag: "w" });
      for (const rel of collisions) {
        parked.push(parkEntry(root, dir, rel));
      }
    } catch (err) {
      // Name the backup whenever anything is still parked there, so a partial
      // rollback can never leave a user file stranded unannounced (NFR-15).
      const leftovers = putBack();
      return {
        restore: () => undefined,
        backups: leftovers,
        error: sanitizeTerminalText(
          `could not park untracked file(s) for ${sandbox.branch}: ${message(err)}`,
        ),
      };
    }

    return { backups: [dir], restore: putBack };
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

  /**
   * Rename a preserved sandbox branch out of the reclaim namespace
   * (`huginn/task-iter-<N>` → `huginn/preserved/task-iter-<N>-<stamp>`) so the
   * next run can neither delete the only copy of a completed iteration's commits
   * nor be blocked from re-sandboxing that iteration (REV-001, AC-17.7).
   *
   * Returns the new branch name, or `null` when there was nothing to preserve.
   */
  preserveOrphanBranch(branch: string): string | null {
    if (!/^huginn\/task-iter-\d+$/.test(branch)) return null;
    if (!this.branchExists(this.projectRoot, branch)) return null;
    const target = `huginn/preserved/${branch.replace(/^huginn\//, "")}-${timestamp()}`;
    const res = git(this.projectRoot, ["branch", "-m", branch, target]);
    return res.code === 0 ? target : null;
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

  /**
   * Commit SHAs reachable from the sandbox branch but not from its base.
   * `ok: false` distinguishes a failed `git log` from a branch with no commits —
   * the two must never be conflated, or a read error would delete the branch
   * (REV-005).
   */
  private sandboxCommits(
    projectRoot: string,
    sandbox: Sandbox,
  ): { ok: boolean; commits: string[] } {
    const res = git(projectRoot, [
      "log",
      "--format=%H",
      `${sandbox.baseCommit}..${sandbox.branch}`,
    ]);
    if (res.code !== 0) return { ok: false, commits: [] };
    return {
      ok: true,
      commits: res.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    };
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
