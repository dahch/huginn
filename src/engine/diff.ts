import { join } from "node:path";

export function git(projectPath: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const res = Bun.spawnSync(["git", ...args], {
    cwd: projectPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: res.stdout.toString().trim(),
    stderr: res.stderr.toString().trim(),
    code: res.exitCode,
  };
}

export function isGitRepo(projectPath: string): boolean {
  return git(projectPath, ["rev-parse", "--is-inside-work-tree"]).code === 0;
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
