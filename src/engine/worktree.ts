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
   * Backup directory holding the local changes (untracked files or tracked
   * files with local modifications) that had to be moved aside so the
   * integration could proceed (ADR-48 / AC-49.1). Present only when at least one
   * path was parked; `manifest.json` inside records what it holds.
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
 * local files (untracked or tracked-modified) that an integration would
 * otherwise overwrite (ADR-48).
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

/** NUL-separated `--name-only -z` output as a set (git never C-quotes it). */
function pathSet(result: { stdout: string }): Set<string> {
  return new Set(result.stdout.split("\0").filter((rel) => rel.length > 0));
}

/**
 * A path huginn may park: relative, inside the project, and never one of its own
 * state directories (whose contents are not part of an iteration's work).
 */
function isParkablePath(rel: string): boolean {
  return (
    rel.length > 0 &&
    !rel.startsWith("/") &&
    !rel.startsWith("..") &&
    !rel.startsWith(".huginn/") &&
    !rel.startsWith(".harness/")
  );
}

/**
 * One parked collision.
 *
 * `tracked` entries were reset to `HEAD` (index and worktree) so the integration
 * could proceed; `staged` records whether the user's version was staged, so the
 * rollback can reproduce the index state. `deleted` means the user's change was
 * a deletion and there is no content copy (the manifest is the record).
 */
interface ParkedEntry {
  rel: string;
  link: boolean;
  tracked?: boolean;
  staged?: boolean;
  deleted?: boolean;
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
 * Move one **tracked** modified file aside and reset its index + worktree to
 * `HEAD`, so `git merge`/`cherry-pick` can integrate the branch. The user's
 * version is copied to the backup (or recorded as a deletion) first; a failure to
 * reset puts it back before throwing.
 *
 * Only paths that exist in `HEAD` are passed here: a staged *new* file is a
 * different case (and a partial stage is refused by the caller), so this function
 * never runs `git restore` against a path `HEAD` does not know.
 */
function parkTrackedEntry(
  root: string,
  dir: string,
  rel: string,
  staged: boolean,
): ParkedEntry {
  const source = join(root, rel);
  const stat = lstatOrUndefined(source);
  let link = false;
  let deleted = false;

  if (!stat) {
    deleted = true;
  } else {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (stat.isSymbolicLink()) {
      link = true;
      symlinkSync(readlinkSync(source), target);
    } else if (stat.isFile()) {
      copyFileSync(source, target);
      chmodSync(target, stat.mode & 0o777);
    } else {
      throw new Error(`not a regular file`);
    }
  }

  return { rel, link, tracked: true, staged, deleted };
}

/**
 * Reset one parked tracked path (index + worktree) to `HEAD`.
 *
 * Called only after its backup entry is already in the caller's `parked` list,
 * so a failure here still rolls the path back through the normal restore path
 * instead of leaving its backup orphaned for cleanup to delete.
 */
function resetTrackedEntry(root: string, rel: string): void {
  const reset = git(root, [
    "restore",
    "--source=HEAD",
    "--staged",
    "--worktree",
    "--",
    rel,
  ]);
  if (reset.code !== 0) {
    throw new Error(reset.stderr || reset.stdout || `could not reset ${rel}`);
  }
}

/**
 * Put one parked file back where it was, preserving its exact form. **Throws**
 * when the backup copy is missing, so the caller counts the restore as failed and
 * keeps the backup directory instead of silently dropping it.
 */
function restoreEntry(root: string, dir: string, entry: ParkedEntry): void {
  const target = join(root, entry.rel);

  // A tracked deletion has no content copy: the restore is the deletion itself.
  if (entry.tracked && entry.deleted) {
    rmSync(target, { recursive: true, force: true });
    if (entry.staged) {
      const staged = git(root, ["rm", "--cached", "--", entry.rel]);
      if (staged.code !== 0) throw new Error(staged.stderr || staged.stdout);
    }
    return;
  }

  const source = join(dir, entry.rel);
  const stat = lstatOrUndefined(source);
  if (!stat) throw new Error(`backup copy for ${entry.rel} is missing`);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  if (entry.link) {
    symlinkSync(readlinkSync(source), target);
  } else {
    copyFileSync(source, target);
    // `copyFileSync` creates with the ambient umask, so restore the mode too.
    chmodSync(target, stat.mode & 0o777);
  }

  if (entry.tracked && entry.staged) {
    const staged = git(root, ["add", "--", entry.rel]);
    if (staged.code !== 0) throw new Error(staged.stderr || staged.stdout);
  }
}

/**
 * A human-readable record of what a successful promotion parked. The files
 * themselves are the backup; this manifest also covers a tracked **deletion**,
 * which has no content copy to inspect.
 */
function writeParkingManifest(dir: string, entries: ParkedEntry[]): void {
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    entries: entries.map((entry) => ({
      path: entry.rel,
      kind: entry.deleted ? "deleted" : entry.link ? "symlink" : "file",
      tracked: entry.tracked === true,
      staged: entry.staged === true,
    })),
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "w",
  });
}

/** Domain error raised for fail-closed worktree operations. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/**
 * Shared resource entries symlinked from the project root into a sandbox.
 *
 * `node_modules`/`.env` keep the iteration runnable; `.pi`/`.agents` keep the
 * agent's own project-scoped resources (MCP servers and skills for the
 * in-process pi driver) available even when they are untracked and therefore
 * absent from a worktree created from HEAD.
 */
const SHARED_DEPS = ["node_modules", ".env", ".pi", ".agents"] as const;

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
   * Reattach the sandbox an interrupted run left behind (ADR-56).
   *
   * A run that is aborted mid-iteration now keeps its worktree and branch, so the
   * partially-done work survives. The next run reuses them instead of creating a
   * fresh worktree from `HEAD` (which would throw the work away and re-run every
   * phase). Returns `null` when there is nothing safe to reattach, and the caller
   * creates a new sandbox instead.
   *
   * Fails closed on a directory that git does not list as a worktree: writing into
   * it could touch a real directory of the user's.
   */
  attachSandbox(projectRoot: string, iteration: number): Sandbox | null {
    const root = projectRoot || this.projectRoot;
    const branch = sandboxBranch(iteration);
    const existing = this.listSandboxes().find((sandbox) => sandbox.branch === branch);
    if (existing) {
      this.linkSharedDeps(root, existing.path);
      return existing;
    }

    const path = sandboxPath(root, iteration);
    if (existsSync(path)) return null;
    if (!this.branchExists(root, branch)) return null;

    try {
      assertDocPath(path, {
        projectPath: root,
        label: "the sandbox worktree",
        action: "create",
      });
    } catch {
      return null;
    }

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const res = git(root, ["worktree", "add", path, branch]);
    if (res.code !== 0) return null;

    this.linkSharedDeps(root, path);
    return { iteration, path, branch, projectRoot: root, baseCommit: headCommit(path) ?? "" };
  }

  /**
   * Commit everything the iteration left in the sandbox, so a successful
   * increment is always made of commits and cannot be discarded by
   * {@link promoteSandbox}. Returns the new HEAD when it had to commit.
   *
   * The agent's `COMMIT_ALL` phase is expected to leave a clean tree; this is the
   * deterministic backstop for the case where it did not (or where a profile has
   * no commit phase). Fails closed with a {@link WorktreeError} when git refuses
   * the commit, because promoting a dirty sandbox would silently lose work.
   */
  commitPendingChanges(
    sandbox: Sandbox,
    message: string,
  ): { commit?: string; pending: boolean } {
    const status = git(sandbox.path, ["status", "--porcelain"]);
    if (status.code !== 0) {
      throw new WorktreeError(
        `Cannot inspect the sandbox for ${sandbox.branch}: ${status.stderr || status.stdout}`,
      );
    }
    if (status.stdout.trim().length === 0) return { pending: false };

    const add = git(sandbox.path, ["add", "-A"]);
    if (add.code !== 0) {
      throw new WorktreeError(
        `Cannot stage the sandbox for ${sandbox.branch}: ${add.stderr || add.stdout}`,
      );
    }
    const commit = git(
      sandbox.path,
      ["commit", "--no-gpg-sign", "-m", message],
      {
        // A missing git identity (or a configured signing key) must not lose a
        // completed increment. This is a harness-authored checkpoint, so it
        // carries the harness identity and never signs.
        env: {
          GIT_AUTHOR_NAME: "huginn",
          GIT_AUTHOR_EMAIL: "huginn@localhost",
          GIT_COMMITTER_NAME: "huginn",
          GIT_COMMITTER_EMAIL: "huginn@localhost",
        },
      },
    );
    if (commit.code !== 0) {
      throw new WorktreeError(
        `Cannot commit the sandbox for ${sandbox.branch}: ${commit.stderr || commit.stdout}`,
      );
    }
    const head = git(sandbox.path, ["rev-parse", "HEAD"]).stdout.trim();
    return { commit: head || undefined, pending: true };
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
   * integrating, every local file the branch would overwrite — untracked **or**
   * tracked with staged/unstaged changes — is parked under
   * `.huginn/promotion-backup/` (with a `manifest.json`), which is what used to
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
      const pending = git(sandbox.path, ["status", "--porcelain"]);
      if (pending.code === 0 && pending.stdout.trim().length > 0) {
        // The caller should have checkpointed first. Never delete the only copy
        // of the iteration's work: report a failed promotion and keep the
        // worktree for recovery.
        return {
          promoted: false,
          method: "none",
          commits,
          failure: "failed",
          detail:
            "the sandbox has uncommitted changes and no commits to promote; " +
            "run commitPendingChanges() first",
        };
      }
      this.removeWorktreeAndBranch(root, sandbox);
      return { promoted: false, method: "none", commits };
    }

    // Resolve collisions *before* integrating: `git merge --ff-only` refuses to
    // overwrite an untracked file **or** a tracked file with local changes, which
    // is what stranded the iteration this ADR exists for.
    const parked = this.parkCollisions(root, sandbox);
    if (parked.error) {
      // huginn could not safely move the colliding file(s): do not integrate, but
      // never discard the iteration either — the branch keeps the finished work
      // and the run reports a *failed* promotion (AC-49.2, AC-49.3, NFR-15).
      // `parkCollisions` has already rolled back; its `backups` is the
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

  /** Branch-changed paths, or an empty set when git could not answer. */
  private branchFiles(root: string, sandbox: Sandbox): Set<string> {
    const res = git(root, [
      "diff",
      "--name-only",
      "-z",
      `${sandbox.baseCommit}..${sandbox.branch}`,
    ]);
    return res.code === 0 ? pathSet(res) : new Set();
  }

  /**
   * Untracked, non-ignored files in the primary tree that the sandbox branch would
   * add or modify — exactly the paths `git merge` refuses to overwrite
   * (AC-49.1). Paths that escape the project, and huginn's own `.huginn`/`.harness`
   * artifacts, are dropped; `-z` is used so git never C-quotes a name.
   */
  private untrackedCollisions(root: string, sandbox: Sandbox): string[] {
    const branchFiles = this.branchFiles(root, sandbox);
    if (branchFiles.size === 0) return [];
    const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
    if (untracked.code !== 0) return [];
    return [...pathSet(untracked)].filter(
      (rel) => branchFiles.has(rel) && isParkablePath(rel),
    );
  }

  /**
   * Tracked files in the primary tree with local changes (staged or unstaged)
   * that the branch also changes. These are the paths `git merge`/`cherry-pick`
   * refuses with "Your local changes … would be overwritten".
   *
   * Partial staging and staged *new* files are reported as unsafe rather than
   * parked: reproducing their exact index state would require copying index blobs,
   * and a guess could lose the staged version. The caller then fails closed and
   * leaves the commits on the branch, which is always recoverable.
   */
  private trackedCollisions(
    root: string,
    sandbox: Sandbox,
  ): { conflicts: string[]; staged: Set<string>; unsupported: string[] } {
    const branchFiles = this.branchFiles(root, sandbox);
    if (branchFiles.size === 0) {
      return { conflicts: [], staged: new Set(), unsupported: [] };
    }

    const staged = pathSet(git(root, ["diff", "--cached", "--name-only", "-z"]));
    const unstaged = pathSet(git(root, ["diff", "--name-only", "-z"]));
    const candidates = new Set(
      [...staged, ...unstaged].filter(
        (rel) => branchFiles.has(rel) && isParkablePath(rel),
      ),
    );

    const conflicts: string[] = [];
    const unsupported: string[] = [];
    for (const rel of candidates) {
      if (staged.has(rel) && unstaged.has(rel)) {
        unsupported.push(`${rel} (partially staged)`);
        continue;
      }
      const inHead = git(root, ["cat-file", "-e", `HEAD:${rel}`]).code === 0;
      if (!inHead) {
        // A staged new file is not recoverable through `git restore --source=HEAD`.
        if (staged.has(rel)) unsupported.push(`${rel} (staged new file)`);
        continue;
      }
      conflicts.push(rel);
    }
    return { conflicts, staged, unsupported };
  }

  /**
   * Move every colliding untracked or tracked-modified file into
   * `.huginn/promotion-backup/<stamp>/`, preserving it exactly, so the
   * integration can proceed. Returns the backup directory (when anything moved)
   * and a restore closure that puts every file (and its index state) back.
   *
   * Never throws: a failure is returned as {@link ParkedCollisions.error} after
   * putting back whatever already moved, so the caller can preserve the sandbox
   * instead of discarding a completed iteration (ADR-48, NFR-15).
   */
  private parkCollisions(root: string, sandbox: Sandbox): ParkedCollisions {
    const untracked = this.untrackedCollisions(root, sandbox);
    const tracked = this.trackedCollisions(root, sandbox);
    if (tracked.unsupported.length > 0) {
      return {
        restore: () => undefined,
        error: sanitizeTerminalText(
          `cannot park ${tracked.unsupported.join(", ")}: commit, unstage or stash ` +
            `the file(s) before re-running; the iteration's commits are safe on ${sandbox.branch}`,
        ),
      };
    }

    const collisions = [...untracked, ...tracked.conflicts];
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
      for (const rel of untracked) {
        parked.push(parkEntry(root, dir, rel));
      }
      for (const rel of tracked.conflicts) {
        // Park first, then reset: if the reset fails, `putBack` still knows about
        // this entry and restores it instead of deleting its backup.
        const entry = parkTrackedEntry(root, dir, rel, tracked.staged.has(rel));
        parked.push(entry);
        resetTrackedEntry(root, rel);
      }
      writeParkingManifest(dir, parked);
    } catch (err) {
      // Name the backup whenever anything is still parked there, so a partial
      // rollback can never leave a user file stranded unannounced (NFR-15).
      const leftovers = putBack();
      return {
        restore: () => undefined,
        backups: leftovers,
        error: sanitizeTerminalText(
          `could not park colliding file(s) for ${sandbox.branch}: ${message(err)}`,
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
   *
   * `keepIteration` is the iteration an interrupted run is about to resume: its
   * worktree and branch are the only copy of that iteration's work, so the sweep
   * must leave them alone (ADR-56). Everything else is still reclaimed.
   */
  cleanupAll(keepIteration?: number): number {
    let reclaimed = 0;
    for (const sandbox of this.listSandboxes()) {
      if (keepIteration !== undefined && sandbox.iteration === keepIteration) continue;
      this.discardSandbox(sandbox);
      reclaimed += 1;
    }
    const keptBranch =
      keepIteration === undefined ? undefined : `huginn/task-iter-${keepIteration}`;
    const orphanedBranches = this.orphanedSandboxBranches().filter(
      (branch) => branch !== keptBranch,
    );
    for (const branch of orphanedBranches) {
      // Best-effort: a branch still checked out in a worktree makes git refuse,
      // which is exactly the correct outcome (it is not orphaned).
      git(this.projectRoot, ["branch", "-D", branch]);
    }
    return reclaimed + orphanedBranches.length;
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
