import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { gitBounded, headCommit } from "./diff.js";
import { profileSpec, type ProfileEvidence, type ProfileName } from "./profiles.js";
import type { PhaseName, Verdict } from "./types.js";

/**
 * Frozen iteration evidence (REQ-36 / AC-36.4 / ADR-35).
 *
 * The failure mode this exists for: an agent *claims* the tests passed. A receipt
 * pins the exact tree that was verified — the base commit, the resulting commit
 * and its tree hash, plus the per-phase verdicts — so the claim is checkable
 * against a hash instead of taken on faith. `strict-tdd` additionally records the
 * pre-`EXECUTE` tree, so "the tests were failing first" is evidenced too.
 */
export interface IterationReceipt {
  profile: ProfileName;
  evidence: Exclude<ProfileEvidence, "none">;
  iteration: number;
  title: string;
  baseCommit?: string;
  headCommit?: string;
  /** Tree hash of the verified state — the frozen evidence. */
  treeHash?: string;
  /** `strict-tdd` only: the tree before `EXECUTE`, so test-first is provable. */
  preExecuteTree?: string;
  verdicts: Array<{ phase: PhaseName; verdict?: Verdict }>;
  createdAt: string;
}

/** Byte cap for each of the two git captures the tree signature is built from. */
const TREE_HASH_CAPTURE_BYTES = 1024 * 1024;

/**
 * A signature of the current working tree: the committed tree (`HEAD^{tree}`),
 * the tracked/untracked status and the working diff, hashed together.
 *
 * Unlike a bare `rev-parse HEAD^{tree}` (which only moves on commit), this
 * changes when a file is edited *without* being committed — which is exactly
 * what the read-only phase guard (REV-001) must detect. Returns `undefined`
 * when the directory is not a git work tree (or git fails): callers must treat
 * `undefined` as "cannot prove nothing changed" and fail closed.
 *
 * **Best effort by construction.** The signature can only see what git reports
 * for the hashed directory: a write that is restored before the "after"
 * snapshot, a write outside the hashed work tree, and any change inside a path
 * the filter below drops (`.harness/`, `.huginn/`, test artifacts) are all
 * invisible. It is a guard rail, not a sandbox — the real containment is the
 * sandboxed worktree (REQ-17).
 *
 * Every capture goes through the bounded, hardened runner (M-3/SEC-001), so a
 * huge diff cannot hang the engine and repository diff config cannot execute
 * host commands. Untracked *directories* are collapsed
 * (`--untracked-files=normal`) so a run that creates thousands of files still
 * produces a bounded, stable signature.
 */
export function treeHash(projectPath: string): string | undefined {
  try {
    const head = gitBounded(projectPath, ["rev-parse", "HEAD^{tree}"], {
      maxBytes: TREE_HASH_CAPTURE_BYTES,
    });
    const status = gitBounded(
      projectPath,
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      { maxBytes: TREE_HASH_CAPTURE_BYTES },
    );
    // `diff HEAD` needs a HEAD; a greenfield repo (no commit yet) still yields a
    // usable status-only signature.
    const diff = gitBounded(projectPath, ["diff", "HEAD", "--no-color"], {
      maxBytes: TREE_HASH_CAPTURE_BYTES,
    });
    if (head.code !== 0 && status.code !== 0) return undefined; // not a work tree
    // A repo *with* a HEAD whose diff cannot be read is an anomaly, not a clean
    // tree: fail closed instead of hashing an incomplete picture.
    if (head.code === 0 && diff.code !== 0) return undefined;
    const h = createHash("sha256");
    h.update(`head:${head.code === 0 ? head.stdout : ""}\0`);
    h.update(`status:${filterIgnoredStatus(status.stdout)}\0`);
    h.update(`diff:${filterIgnoredDiff(diff.stdout)}\0`);
    return h.digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Paths whose presence must never count as a repository mutation: huginn's own
 * state, and the artifacts ordinary test tooling writes. Matched at the root
 * only (`.harness/…`, never `src/.harness/…`) and on a path boundary, so a file
 * that merely *starts* with `.harness` or lives in `build-tools/` still counts.
 *
 * The artifact entries are what keeps a read-only audit from false-positiving
 * (REV-103/REV-104): running a test or build suite legitimately writes caches
 * into the repository, and those are not edits.
 */
const IGNORED_TREE_PATHS = [
  ".harness",
  ".huginn",
  "coverage",
  ".vitest",
  "node_modules",
  "dist",
  "build",
  ".pytest_cache",
  ".turbo",
  ".nyc_output",
  "target",
];

/**
 * Artifact *directories* ignored at any depth: language tooling writes them per
 * package (`pkg/__pycache__/mod.pyc`), so a root-anchored match would miss most
 * of them while still hiding nothing a human authored.
 */
const IGNORED_TREE_DIRS_ANYWHERE = ["__pycache__"];

/**
 * Artifact *file* names and suffixes ignored wherever they appear — build, lint
 * and test caches are written next to the config that produced them, not
 * necessarily at the project root.
 */
const IGNORED_TREE_FILE_NAMES = ["junit.xml", ".eslintcache"];
const IGNORED_TREE_FILE_SUFFIXES = [".tsbuildinfo"];

/** True when one side of a porcelain status path names an ignored artifact. */
function isIgnoredArtifactSide(side: string): boolean {
  if (IGNORED_TREE_PATHS.some((prefix) => side === prefix || side.startsWith(`${prefix}/`))) {
    return true;
  }
  const segments = side.split("/");
  if (segments.some((segment) => IGNORED_TREE_DIRS_ANYWHERE.includes(segment))) return true;
  const base = segments.at(-1) ?? side;
  return (
    IGNORED_TREE_FILE_NAMES.includes(base) ||
    IGNORED_TREE_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
}

function isIgnoredTreePath(rawPath: string): boolean {
  let path = rawPath.trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  path = path.replace(/^\.\//, "");
  if (path === "") return true;
  // A porcelain rename ("orig -> new") is ignored when either side is ignored.
  const sides = path.split(" -> ");
  return sides.some((side) => isIgnoredArtifactSide(side));
}

/**
 * Drop ignored entries from `git status --porcelain=v1` output. Porcelain v1
 * lines are `XY <path>`, so the path starts at column 3; unlike a loose prefix
 * match this never touches diff text (REV-103).
 */
function filterIgnoredStatus(output: string): string {
  return output
    .split("\n")
    .filter((line) => (line.trim() === "" ? false : !isIgnoredTreePath(line.slice(3))))
    .join("\n");
}

/**
 * Drop whole diff hunks that belong to an ignored path. A unified diff is a
 * sequence of `diff --git a/<path> b/<path>` blocks, so dropping the block is
 * enough — no line-level path guessing (REV-103). Best effort: git's C-quoted
 * paths are handled quoted-verbatim, not unescaped.
 */
function filterIgnoredDiff(output: string): string {
  if (output.trim() === "") return "";
  const kept: string[] = [];
  let keepBlock = true;
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      keepBlock = !diffHeaderTouchesIgnoredPath(line);
    }
    if (keepBlock) kept.push(line);
  }
  return kept.join("\n");
}

function diffHeaderTouchesIgnoredPath(header: string): boolean {
  const rest = header.slice("diff --git ".length);
  return rest
    .split(" ")
    .filter(Boolean)
    .some((token) => {
      let path = token;
      if (path.startsWith('"')) path = path.slice(1);
      if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
      return isIgnoredTreePath(path);
    });
}

/**
 * Write the receipt under `.huginn/receipts/iter-<n>.json` and return its path.
 * Best-effort: a receipt must never fail an otherwise-successful iteration.
 */
export function writeIterationReceipt(
  projectPath: string,
  receipt: IterationReceipt,
): string | undefined {
  try {
    const dir = join(projectPath, ".huginn", "receipts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `iter-${receipt.iteration}.json`);
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/** Build the receipt for a finished iteration, per the profile's evidence rule. */
export function buildIterationReceipt(opts: {
  profile: ProfileName | undefined;
  iteration: number;
  title: string;
  projectPath: string;
  /** Pre-iteration HEAD, so the receipt can show what changed. */
  baseCommit?: string;
  verdicts: Array<{ phase: PhaseName; verdict?: Verdict }>;
  preExecuteTree?: string;
}): IterationReceipt | undefined {
  const spec = profileSpec(opts.profile);
  if (spec.evidence === "none") return undefined;
  const head = headCommit(opts.projectPath) ?? undefined;
  return {
    profile: spec.id,
    evidence: spec.evidence,
    iteration: opts.iteration,
    title: opts.title,
    baseCommit: opts.baseCommit ?? head ?? undefined,
    headCommit: head ?? undefined,
    treeHash: treeHash(opts.projectPath),
    ...(spec.evidence === "snapshot" ? { preExecuteTree: opts.preExecuteTree } : {}),
    verdicts: opts.verdicts,
    createdAt: new Date().toISOString(),
  };
}
