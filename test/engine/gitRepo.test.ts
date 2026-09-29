import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { git, gitRepoState, isGitRepo, headCommit } from "../../src/engine/diff.js";
import { ensureGitRepository } from "../../src/engine/gitRepo.js";
import { ensureGitRepositoryOrExit, parseArgs } from "../../src/cli.js";

const GITIGNORE = [
  "node_modules/",
  "dist/",
  "build/",
  ".harness/",
  ".huginn/",
  "*.log",
  "coverage/",
  ".DS_Store",
  ".env",
].join("\n") + "\n";

function commitCount(dir: string): number {
  const res = git(dir, ["rev-list", "--count", "HEAD"]);
  return res.code === 0 ? Number(res.stdout) : 0;
}

function mkdir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Result the bootstrap child process prints for its assertions. */
interface BootstrapResult {
  initialized: boolean;
  email: string;
  name: string;
  commits: string;
}

/**
 * `Bun.spawnSync` (used by `git()`) snapshots `process.env` at startup, so git
 * configuration can only be injected into the helper through a child process
 * that gets the hostile environment explicitly. `globalConfig` replaces the
 * (empty) global config file with the given content.
 */
function bootstrapInChild(
  tempDir: string,
  dir: string,
  gitConfig: Record<string, string>,
  globalConfig?: string,
): BootstrapResult {
  const engineDir = fileURLToPath(new URL("../../src/engine/", import.meta.url));
  const scriptPath = path.join(tempDir, "bootstrap.ts");
  fs.writeFileSync(
    scriptPath,
    `const gitRepo = await import(${JSON.stringify(path.join(engineDir, "gitRepo.ts"))});\n` +
      `const diff = await import(${JSON.stringify(path.join(engineDir, "diff.ts"))});\n` +
      `const dir = process.argv[2];\n` +
      `console.log(JSON.stringify({\n` +
      `  initialized: gitRepo.ensureGitRepository(dir).initialized,\n` +
      `  email: diff.git(dir, ["config", "--local", "user.email"]).stdout,\n` +
      `  name: diff.git(dir, ["config", "--local", "user.name"]).stdout,\n` +
      `  commits: diff.git(dir, ["rev-list", "--count", "HEAD"]).stdout,\n` +
      `}));\n`,
  );
  let globalPath = "/dev/null";
  if (globalConfig !== undefined) {
    globalPath = path.join(tempDir, "global.gitconfig");
    fs.writeFileSync(globalPath, globalConfig);
  }
  const entries = Object.entries(gitConfig);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalPath,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const bun = process.versions.bun ? process.execPath : "bun";
  const child = spawnSync(bun, [scriptPath, dir], { encoding: "utf-8", env });

  expect(child.status, `bootstrap child failed: ${child.stderr}`).toBe(0);
  return JSON.parse(String(child.stdout).trim().split("\n").at(-1)!) as BootstrapResult;
}

describe("ensureGitRepository (REQ-5)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-git-repo-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes a plain directory on main with the default .gitignore and a bootstrap commit", () => {
    const dir = mkdir(path.join(tempDir, "plain"));
    expect(isGitRepo(dir)).toBe(false);

    expect(ensureGitRepository(dir)).toEqual({ initialized: true });

    expect(isGitRepo(dir)).toBe(true);
    expect(git(dir, ["symbolic-ref", "--short", "HEAD"]).stdout).toBe("main");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(GITIGNORE);

    const log = git(dir, ["log", "--oneline"]);
    expect(log.stdout).not.toBe("");
    expect(log.stdout).toContain("chore: initialize repository");
    expect(commitCount(dir)).toBe(1);
    expect(git(dir, ["ls-files"]).stdout).toContain(".gitignore");
    // the bootstrap commit always carries a resolvable author identity
    expect(git(dir, ["log", "-1", "--format=%ae"]).stdout).toContain("@");
  });

  it("is idempotent: a second call adds nothing", () => {
    const dir = mkdir(path.join(tempDir, "idempotent"));
    expect(ensureGitRepository(dir)).toEqual({ initialized: true });
    const head = headCommit(dir);

    expect(ensureGitRepository(dir)).toEqual({ initialized: false });
    expect(commitCount(dir)).toBe(1);
    expect(headCommit(dir)).toBe(head);
  });

  it("leaves an existing repository untouched", () => {
    const dir = mkdir(path.join(tempDir, "existing"));
    expect(git(dir, ["init", "-b", "main"]).code).toBe(0);

    expect(ensureGitRepository(dir)).toEqual({ initialized: false });
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
    expect(commitCount(dir)).toBe(0);
  });

  it("never initializes a subdirectory of an existing repository", () => {
    const project = mkdir(path.join(tempDir, "project"));
    expect(ensureGitRepository(project)).toEqual({ initialized: true });
    const sub = mkdir(path.join(project, "packages", "app"));

    // the regression REQ-5 fixes: a subdirectory IS inside a work tree
    expect(isGitRepo(sub)).toBe(true);
    expect(ensureGitRepository(sub)).toEqual({ initialized: false });
    expect(fs.existsSync(path.join(sub, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(sub, ".gitignore"))).toBe(false);
    expect(commitCount(project)).toBe(1);
  });

  it("never initializes a linked git worktree", () => {
    const project = mkdir(path.join(tempDir, "worktree-root"));
    expect(ensureGitRepository(project).initialized).toBe(true);
    const linked = path.join(tempDir, "linked");
    expect(git(project, ["worktree", "add", "-b", "wt-branch", linked]).code).toBe(0);

    expect(isGitRepo(linked)).toBe(true);
    expect(ensureGitRepository(linked)).toEqual({ initialized: false });
    expect(headCommit(linked)).toBe(headCommit(project));
  });

  it("keeps a pre-existing .gitignore verbatim and still commits it (REV-008)", () => {
    const dir = mkdir(path.join(tempDir, "own-ignore"));
    fs.writeFileSync(path.join(dir, ".gitignore"), "my-own-rule\n");

    expect(ensureGitRepository(dir)).toEqual({ initialized: true });

    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("my-own-rule\n");
    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).stdout).toBe(".gitignore");
  });

  it("commits only .gitignore, even when the directory holds other files", () => {
    const dir = mkdir(path.join(tempDir, "with-files"));
    fs.writeFileSync(path.join(dir, "app.ts"), "export const app = 1;\n");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export {};\n");

    expect(ensureGitRepository(dir)).toEqual({ initialized: true });

    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).stdout).toBe(".gitignore");
    expect(git(dir, ["ls-files"]).stdout).toBe(".gitignore");
    expect(git(dir, ["status", "--porcelain"]).stdout).toContain("app.ts");
  });

  it("bootstraps the commit with no usable global identity", () => {
    const dir = mkdir(path.join(tempDir, "no-identity"));
    // `user.useConfigOnly` makes git refuse the implicit hostname identity, so
    // the commit only succeeds through huginn's local fallback.
    const result = bootstrapInChild(tempDir, dir, { "user.useConfigOnly": "true" });

    expect(result).toEqual({
      initialized: true,
      email: "huginn@localhost",
      name: "huginn",
      commits: "1",
    });
    expect(isGitRepo(dir)).toBe(true);
  });

  it("treats a configured-but-empty identity as missing (REV-007)", () => {
    const dir = mkdir(path.join(tempDir, "empty-identity"));
    // `useConfigOnly` plus an empty `user.email`/`user.name` makes `git config
    // user.email` answer "" with exit 0 — the shape that used to look like a
    // usable identity and made the bootstrap commit die with "empty ident name".
    const result = bootstrapInChild(
      tempDir,
      dir,
      {},
      "[user]\n\tuseConfigOnly = true\n\temail =\n\tname =\n",
    );

    expect(result).toEqual({
      initialized: true,
      email: "huginn@localhost",
      name: "huginn",
      commits: "1",
    });
  });

  it("completes the bootstrap commit under a global commit.gpgsign=true", () => {
    const dir = mkdir(path.join(tempDir, "gpgsign"));
    const result = bootstrapInChild(tempDir, dir, {
      "commit.gpgsign": "true",
      "user.useConfigOnly": "true",
    });

    expect(result).toEqual({
      initialized: true,
      email: "huginn@localhost",
      name: "huginn",
      commits: "1",
    });
    expect(isGitRepo(dir)).toBe(true);
  });

  it("fails with the git reason when the directory cannot be initialized", () => {
    // A read-only directory reads as "not a repo" but git cannot create `.git`
    // in it. Root bypasses the permission, so the case only holds unprivileged.
    if (process.getuid?.() === 0) return;
    const dir = mkdir(path.join(tempDir, "read-only"));
    fs.chmodSync(dir, 0o500);
    try {
      expect(gitRepoState(dir)).toBe("not-a-repo");
      expect(() => ensureGitRepository(dir)).toThrow(/git init -b main failed/);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe("gitRepoState (REV-001, REV-002)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-git-state-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports work-tree inside a repository and not-a-repo outside every one", () => {
    const dir = mkdir(path.join(tempDir, "plain"));
    expect(gitRepoState(dir)).toBe("not-a-repo");

    expect(git(dir, ["init", "-b", "main"]).code).toBe(0);
    expect(gitRepoState(dir)).toBe("work-tree");
    expect(gitRepoState(mkdir(path.join(dir, "src")))).toBe("work-tree");
  });

  it("reports not-a-repo for a bare repository and for `.git` itself (REV-002)", () => {
    const repo = mkdir(path.join(tempDir, "repo"));
    expect(git(repo, ["init", "-b", "main"]).code).toBe(0);
    const bare = mkdir(path.join(tempDir, "bare.git"));
    expect(git(bare, ["init", "--bare"]).code).toBe(0);

    // both print "false" with exit 0, so an exit code alone would call them repos
    const bareProbe = git(bare, ["rev-parse", "--is-inside-work-tree"]);
    const dotGitProbe = git(path.join(repo, ".git"), ["rev-parse", "--is-inside-work-tree"]);
    expect(bareProbe.code).toBe(0);
    expect(bareProbe.stdout).toBe("false");
    expect(dotGitProbe.code).toBe(0);
    expect(dotGitProbe.stdout).toBe("false");
    expect(gitRepoState(bare)).toBe("not-a-repo");
    expect(gitRepoState(path.join(repo, ".git"))).toBe("not-a-repo");
    expect(isGitRepo(bare)).toBe(false);
    expect(isGitRepo(path.join(repo, ".git"))).toBe(false);
  });

  it("reports error when git cannot answer, and never mutates the path (REV-001)", () => {
    const missing = path.join(tempDir, "does-not-exist");
    expect(gitRepoState(missing)).toBe("error");
    expect(() => ensureGitRepository(missing)).toThrow(/could not determine git repository state/);
    expect(fs.existsSync(missing)).toBe(false);

    // a file is not a working directory either: git can inspect neither
    const file = path.join(tempDir, "regular-file");
    fs.writeFileSync(file, "not a directory\n");
    expect(gitRepoState(file)).toBe("error");
    expect(() => ensureGitRepository(file)).toThrow(/could not determine git repository state/);
    expect(fs.readFileSync(file, "utf8")).toBe("not a directory\n");
  });
});

describe("ensureGitRepositoryOrExit (CLI gate)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-git-gate-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes and notices instead of aborting outside any work tree", () => {
    const dir = fs.realpathSync(mkdir(path.join(tempDir, "fresh")));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      ensureGitRepositoryOrExit(dir, parseArgs([]));
      expect(isGitRepo(dir)).toBe(true);
      const lines = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(lines).toContain(`initialized a git repository at ${dir}`);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("stays silent inside an existing repository (subdirectory included)", () => {
    const project = fs.realpathSync(mkdir(path.join(tempDir, "repo")));
    expect(ensureGitRepository(project).initialized).toBe(true);
    const sub = fs.realpathSync(mkdir(path.join(project, "src")));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => ensureGitRepositoryOrExit(sub, parseArgs([]))).not.toThrow();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps the fatal error behind --no-git-init", () => {
    const dir = path.join(tempDir, "no-init");
    mkdir(dir);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as unknown as typeof process.exit);
    try {
      expect(() => ensureGitRepositoryOrExit(dir, parseArgs(["--no-git-init"]))).toThrow(
        "process.exit called",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      const lines = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(lines).toContain(`"${dir}" is not a git repository.`);
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("exits without initializing when git cannot decide (error state, REV-001)", () => {
    const missing = path.join(tempDir, "does-not-exist");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as unknown as typeof process.exit);
    try {
      expect(() => ensureGitRepositoryOrExit(missing, parseArgs([]))).toThrow(
        "process.exit called",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      const lines = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(lines).toContain(`could not determine the git repository state at ${missing}`);
      expect(fs.existsSync(missing)).toBe(false);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("parses --no-git-init as a boolean flag that never eats the next argument", () => {
    const parsed = parseArgs(["live", "--no-git-init", "--project", "/tmp/x"]);
    expect(parsed["--no-git-init"]).toBe(true);
    expect(parsed["--project"]).toBe("/tmp/x");
  });

  it("treats --no-git-init=false and =0 as disabled instead of the fatal mode", () => {
    const spellings: Array<[string, string]> = [
      ["--no-git-init=false", "disabled"],
      ["--no-git-init=0", "zero"],
    ];
    for (const [flag, name] of spellings) {
      const dir = fs.realpathSync(mkdir(path.join(tempDir, name)));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() => ensureGitRepositoryOrExit(dir, parseArgs([flag]))).not.toThrow();
        expect(isGitRepo(dir)).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    }
  });
});
