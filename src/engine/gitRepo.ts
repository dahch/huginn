import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, probeGitRepo } from "./diff";

/**
 * Default ignore list written by the bootstrap commit. Kept deliberately small:
 * it only covers huginn's own state (`.harness/`, `.huginn/`) plus the usual
 * build/test artifacts of a greenfield project.
 */
const GITIGNORE_PATTERNS = [
  "node_modules/",
  "dist/",
  "build/",
  ".harness/",
  ".huginn/",
  "*.log",
  "coverage/",
  ".DS_Store",
  ".env",
];

function run(projectPath: string, args: string[], stage: string): void {
  const res = git(projectPath, args);
  if (res.code !== 0) {
    const reason = res.stderr || res.stdout || `exit code ${res.code}`;
    throw new Error(`${stage} failed: ${reason}`);
  }
}

/**
 * A repository can only be committed to with a resolved identity, and a machine
 * without a global `user.email`/`user.name` (CI, containers, a throwaway HOME)
 * would otherwise abort the bootstrap commit. A configured-but-empty value is no
 * identity either, so both `code !== 0` and an empty answer count as missing.
 * Local config wins for this repo and never touches the user's global
 * configuration.
 */
function ensureCommitIdentity(projectPath: string): void {
  const email = git(projectPath, ["config", "user.email"]);
  if (email.code !== 0 || email.stdout === "") {
    run(projectPath, ["config", "--local", "user.email", "huginn@localhost"], "git config user.email");
  }
  const name = git(projectPath, ["config", "user.name"]);
  if (name.code !== 0 || name.stdout === "") {
    run(projectPath, ["config", "--local", "user.name", "huginn"], "git config user.name");
  }
}

/**
 * Make `projectPath` usable as a huginn project (REQ-5).
 *
 * An existing work tree is detected with `git rev-parse --is-inside-work-tree`,
 * so a subdirectory, a linked worktree or a symlinked path is correctly
 * recognized instead of being reported as "not a git repository". Only a
 * directory that is inside no work tree is initialized in place — `git init -b
 * main`, a `.gitignore` when the project has none, and a bootstrap commit so the
 * engine always has a HEAD to diff against. A bare repository counts as "not
 * initialized yet" (it has no work tree), and a path git cannot classify at all
 * raises instead of being mutated (REV-001).
 */
export function ensureGitRepository(projectPath: string): { initialized: boolean } {
  const { state, detail } = probeGitRepo(projectPath);
  if (state === "work-tree") return { initialized: false };
  if (state === "error") {
    throw new Error(`could not determine git repository state: ${detail}`);
  }

  run(projectPath, ["init", "-b", "main"], "git init -b main");

  const gitignorePath = join(projectPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_PATTERNS.join("\n")}\n`);
  }

  ensureCommitIdentity(projectPath);

  run(projectPath, ["add", "-f", ".gitignore"], "git add .gitignore");
  // A globally enabled `commit.gpgsign` must not turn onboarding into a fatal
  // error; the bootstrap commit is huginn's, not the user's signature.
  run(
    projectPath,
    ["-c", "commit.gpgsign=false", "commit", "-m", "chore: initialize repository"],
    "git commit",
  );

  return { initialized: true };
}
