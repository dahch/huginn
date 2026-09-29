import { join } from "node:path";
import child_process from "node:child_process";

export function git(projectPath: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const safeArgs = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ];

  if (typeof Bun !== "undefined" && typeof Bun.spawnSync === "function") {
    try {
      const res = Bun.spawnSync(["git", ...safeArgs], {
        cwd: projectPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        stdout: (res.stdout ? res.stdout.toString() : "").trim(),
        stderr: (res.stderr ? res.stderr.toString() : "").trim(),
        code: res.exitCode,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: String(err),
        code: 1,
      };
    }
  }

  try {
    const res = child_process.spawnSync("git", safeArgs, {
      cwd: projectPath,
      encoding: "utf-8",
    });
    const errorMsg = res.error ? String(res.error) : "";
    return {
      stdout: (res.stdout || "").trim(),
      stderr: (res.stderr || "").trim() || errorMsg,
      code: res.status ?? (res.error ? 1 : 0),
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: String(err),
      code: 1,
    };
  }
}

export type GitRepoState = "work-tree" | "not-a-repo" | "error";

/**
 * Three-way classification of `projectPath` with `git rev-parse
 * --is-inside-work-tree` (REV-001/REV-002), plus git's own message.
 *
 * A bare repository and a directory inside `.git` answer `false` *with exit 0*,
 * so an exit code alone cannot tell "greenfield directory" from "git already
 * knows this place", and a failure that is not git's "not a git repository"
 * (dubious ownership, permissions, git missing) must never be mistaken for a
 * directory that is safe to `git init`.
 */
export function probeGitRepo(projectPath: string): { state: GitRepoState; detail: string } {
  const res = git(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  const detail = res.stderr || res.stdout || `exit code ${res.code}`;
  if (res.code === 0) {
    if (res.stdout === "true") return { state: "work-tree", detail };
    if (res.stdout === "false") return { state: "not-a-repo", detail };
    return { state: "error", detail };
  }
  // Being outside every work tree is the only failure that means "initialize me".
  return `${res.stdout} ${res.stderr}`.toLowerCase().includes("not a git repository")
    ? { state: "not-a-repo", detail }
    : { state: "error", detail };
}

/** The tri-state alone, for callers that only branch on it. */
export function gitRepoState(projectPath: string): GitRepoState {
  return probeGitRepo(projectPath).state;
}

/** True only inside a work tree: a bare repo or `.git` itself is not one. */
export function isGitRepo(projectPath: string): boolean {
  return gitRepoState(projectPath) === "work-tree";
}

export function headCommit(projectPath: string): string | null {
  const res = git(projectPath, ["rev-parse", "HEAD"]);
  return res.code === 0 ? res.stdout : null;
}

export function pendingChanges(projectPath: string): string[] {
  const files = new Set<string>();
  const status = git(projectPath, ["status", "--porcelain"]);
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const p = line.slice(3).trim();
    if (p && !p.startsWith('.harness')) files.add(p);
  }
  const diff = git(projectPath, ["diff", "--name-only", "HEAD"]);
  for (const p of diff.stdout.split("\n")) {
    if (p && !p.startsWith('.harness')) files.add(p);
  }
  return [...files];
}

export function changedFilesSince(projectPath: string, base: string): string[] {
  const files = new Set<string>();
  const diff = git(projectPath, ["diff", "--name-only", `${base}..HEAD`]);
  for (const p of diff.stdout.split("\n")) {
    if (p && !p.startsWith(".harness")) files.add(p);
  }
  return [...files];
}

const IGNORED_DIRS = new Set([".harness", ".git", "node_modules", "dist", "build", ".DS_Store"]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt"]);

// File extensions that carry implementation logic the spec auditor should
// validate. Config/scaffolding files (package.json, tsconfig.json, lockfiles)
// are intentionally excluded so a scaffolded-but-empty repo still counts as
// greenfield.
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".cs", ".scala", ".clj", ".cljs",
  ".ex", ".exs", ".erl", ".hrl", ".hs", ".lua", ".r", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".prisma", ".graphql", ".gql", ".proto",
  ".dart", ".zig", ".nim", ".ml", ".mli", ".fs", ".fsx", ".sol",
]);

export function inferModules(projectPath: string, base?: string): string[] {
  const files = base ? changedFilesSince(projectPath, base) : pendingChanges(projectPath);
  const modules = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 0) continue;
    if (IGNORED_DIRS.has(parts[0])) continue;
    if (parts.length === 1) {
      continue; // root-level file, not a module
    }
    const seg = Math.min(2, parts.length - 1);
    modules.add(parts.slice(0, seg).join("/"));
  }
  return [...modules];
}

export function relativeToProject(projectPath: string, file: string): string {
  return join(projectPath, file);
}

export function hasImplementationCode(projectPath: string): boolean {
  const res = git(projectPath, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (res.code !== 0) return true; // fail-safe: don't skip the audit on a real repo
  for (const raw of res.stdout.split("\n")) {
    const f = raw.trim();
    if (!f) continue;
    if (IGNORED_DIRS.has(f.split("/")[0])) continue;
    const base = f.split("/").at(-1)!;
    if (base.startsWith(".")) continue; // hidden files (e.g. .gitignore, .prettierrc)
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
    if (DOC_EXTENSIONS.has(ext)) continue;
    if (SOURCE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}
