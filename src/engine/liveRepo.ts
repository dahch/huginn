import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { events } from "./engineEvents";
import { clearStaleHarness } from "../state/store";
import { git } from "./diff";

const IGNORED_DIRS = new Set([".harness", ".git", "node_modules", "dist", "build"]);

/**
 * Best-effort file read. Returns "" on any failure and logs a warning instead
 * of silently treating an unreadable file as absent.
 */
export function readOptional(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch (err) {
    events.emit("log", { level: "warn", message: `could not read ${path}: ${(err as Error).message}` });
    return "";
  }
}

export function writeDoc(path: string, content: string): { bytes: number; path: string } {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { bytes: Buffer.byteLength(content, "utf8"), path };
}

function sourceTree(projectPath: string): string {
  const res = git(projectPath, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  const dirs = new Set<string>();
  const roots: string[] = [];
  for (const raw of res.stdout.split("\n")) {
    const f = raw.trim();
    if (!f) continue;
    const parts = f.split("/");
    if (IGNORED_DIRS.has(parts[0])) continue;
    if (parts.length === 1) {
      if (!f.startsWith(".")) roots.push(f);
      continue;
    }
    dirs.add(parts.slice(0, Math.min(2, parts.length - 1)).join("/"));
  }
  const lines = [...dirs].sort();
  if (roots.length > 0) lines.push(...roots.sort().map((f) => `/${f}`));
  return lines.length > 0 ? lines.join("\n") : "(no source files yet)";
}

/** Snapshot of git history, working-tree state and source tree for prompts. */
export function repoContext(projectPath: string): string {
  const log = git(projectPath, ["log", "--oneline", "-30"]);
  const status = git(projectPath, ["status", "--short"]);
  return [
    `git log --oneline -30:\n${log.stdout || "(no commits yet)"}`,
    `git status --short:\n${status.stdout || "(clean working tree)"}`,
    `Source tree:\n${sourceTree(projectPath)}`,
  ].join("\n\n");
}

/**
 * Stages docs as intent-to-add so `git diff HEAD -- <docs>` shows the drafts
 * for human review. No content is staged, only the intent.
 */
export function stageDocsForReview(projectPath: string, docs: string[]): void {
  git(projectPath, ["add", "-N", "--", ...docs]);
}

/** Drops intent-to-add entries when the human aborts before the docs commit. */
export function unstageDocs(projectPath: string, docs: string[]): void {
  git(projectPath, ["reset", "-q", "--", ...docs]);
}

/**
 * Adds and commits the updated docs. Returns the list of staged file names on
 * success, null when there was nothing to commit or the commit failed.
 */
export function commitDocs(projectPath: string, docs: string[], subject: string): string[] | null {
  git(projectPath, ["add", "--", ...docs]);
  const staged = git(projectPath, ["diff", "--cached", "--name-only"]).stdout;
  if (!staged) return null;
  const commit = git(projectPath, ["commit", "-m", `docs(scope): ${subject}`]);
  if (commit.code !== 0) {
    const err = commit.stderr || commit.stdout || "unknown";
    events.emit("log", { level: "warn", message: `docs commit failed: ${err}` });
    return null;
  }
  return staged.split("\n").filter(Boolean);
}

/** Clears the stale harness directory before handing off to execution. */
export function resetHarnessState(projectPath: string): void {
  clearStaleHarness(projectPath);
}
