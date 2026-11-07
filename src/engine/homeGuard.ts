/**
 * A tripwire for writes that escape the project.
 *
 * The sandbox isolates **where an iteration's edits land**, not what the agent
 * may touch: a driver only ever promises `filesystemIsolation: "worktree"`, so an
 * agent that runs the project's own CLI can still rewrite the user's agent
 * configuration under `$HOME`. That is not hypothetical — one run of this
 * repository's own `setup` command, executed by the executor as a smoke test,
 * moved four configs from `huginn mcp run` to `muninn mcp run`.
 *
 * This module cannot prevent it. It can make it *visible*: snapshot the config
 * files the agent's own toolchain owns, compare after each phase, and report what
 * moved and when. A warning that names the file is worth more than a comment in a
 * document saying nobody should do that.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, isAbsolute, resolve } from "node:path";
import { AGENT_REGISTRY, AGENT_TARGETS, resolveMcpPaths } from "../agents/integrator.js";

/** One file worth watching, with the human label that makes a warning readable. */
export interface WatchedPath {
  path: string;
  label: string;
}

/** What the file looked like: enough to tell "changed" from "untouched". */
export interface FileStamp {
  /** Milliseconds since the epoch, or -1 when the file does not exist. */
  mtimeMs: number;
  /** Bytes, or -1 when the file does not exist. */
  size: number;
}

export interface WorldChange {
  path: string;
  label: string;
  detail: string;
}

export interface WatchOptions {
  projectPath: string;
  homeDir?: string;
  opencodeConfigDir?: string;
  env?: Record<string, string | undefined>;
}

/**
 * The files to watch: every agent config the provisioning matrix knows, plus the
 * memory stores, minus everything inside the project.
 *
 * Project-scoped configs (`.mcp.json`, `.cursor/mcp.json`, …) are deliberately
 * excluded: they are supposed to change during a run, they land in the
 * iteration's git diff, and warning about them would train the user to ignore
 * the warning that matters.
 */
export function watchedPaths(options: WatchOptions): WatchedPath[] {
  const projectPath = resolve(options.projectPath);
  const home = options.homeDir ?? process.env.HUGINN_HOME ?? homedir();
  const seen = new Set<string>();
  const watched: WatchedPath[] = [];

  const add = (path: string, label: string): void => {
    const absolute = resolve(path);
    if (seen.has(absolute)) return;
    if (isInsideProject(absolute, projectPath)) return;
    seen.add(absolute);
    watched.push({ path: absolute, label });
  };

  for (const target of AGENT_TARGETS) {
    const label = AGENT_REGISTRY[target].label;
    let paths: string[] = [];
    try {
      paths = resolveMcpPaths(target, {
        projectPath,
        homeDir: home,
        opencodeConfigDir: options.opencodeConfigDir,
        env: options.env,
      });
    } catch {
      // A target whose paths cannot be resolved simply has nothing to watch.
      continue;
    }
    for (const path of paths) add(path, `${label} MCP config`);
  }

  // The memory stores both tools write, outside any project.
  add(resolve(home, ".muninn", "mcp.json"), "Muninn portable MCP config");
  add(resolve(home, ".huginn", "mcp.json"), "Huginn portable MCP config");
  add(resolve(home, ".huginn", "config.json"), "Huginn user config");

  return watched;
}

function isInsideProject(path: string, projectPath: string): boolean {
  const rel = relative(projectPath, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Stamp every watched file; a missing file is stamped as `{ mtimeMs: -1 }`. */
export function snapshotWorld(paths: WatchOptions | WatchedPath[]): Map<string, FileStamp> {
  const list = Array.isArray(paths) ? paths : watchedPaths(paths);
  const stamps = new Map<string, FileStamp>();
  for (const entry of list) {
    stamps.set(entry.path, stamp(entry.path));
  }
  return stamps;
}

function stamp(path: string): FileStamp {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: -1, size: -1 };
  }
}

/**
 * What changed between two snapshots, in a form a warning can print.
 *
 * A file that appeared, disappeared or was rewritten all count: the point is that
 * something outside the project moved while a phase ran, not the kind of move.
 */
export function diffWorld(
  before: Map<string, FileStamp>,
  after: Map<string, FileStamp>,
  paths: WatchedPath[],
): WorldChange[] {
  const labels = new Map(paths.map((entry) => [entry.path, entry.label]));
  const changes: WorldChange[] = [];
  for (const [path, now] of after) {
    const then = before.get(path);
    if (then === undefined) continue;
    if (then.mtimeMs === now.mtimeMs && then.size === now.size) continue;

    const detail =
      then.mtimeMs === -1
        ? "created during this phase"
        : now.mtimeMs === -1
          ? "deleted during this phase"
          : `rewritten during this phase (${then.size} → ${now.size} bytes)`;
    changes.push({ path, label: labels.get(path) ?? "watched path", detail });
  }
  return changes;
}
