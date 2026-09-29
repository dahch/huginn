import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  git,
  gitBounded,
  gitSubcommand,
  hasImplementationCode,
  safeGitArgs,
} from "./diff";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-diff-"));
  git(dir, ["init", "-q"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function commitAll(repo: string): void {
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "fixtures", "--no-gpg-sign"]);
}

/** Raw git, i.e. exactly what huginn used to run — the attack baseline. */
function rawGit(repo: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

describe("hardened git args (SEC-001)", () => {
  it("knows which argv token is the subcommand", () => {
    expect(gitSubcommand(["diff", "HEAD"])).toBe("diff");
    expect(gitSubcommand(["-c", "commit.gpgsign=false", "commit", "-m", "x"])).toBe("commit");
    expect(gitSubcommand(["--no-pager", "log"])).toBe("log");
    expect(gitSubcommand(["-c", "a=b"])).toBeUndefined();
  });

  it("neutralises the pager on every invocation", () => {
    const args = safeGitArgs(["status", "--short"]);
    expect(args).toContain("--no-pager");
    expect(args).toContain("core.pager=cat");
    expect(args).toContain("core.hooksPath=/dev/null");
  });

  it("inserts --no-ext-diff/--no-textconv after diff-producing subcommands only", () => {
    for (const subcommand of ["diff", "show", "log", "whatchanged"]) {
      const args = safeGitArgs([subcommand, "HEAD"]);
      const at = args.indexOf(subcommand);
      expect(args[at + 1]).toBe("--no-ext-diff");
      expect(args[at + 2]).toBe("--no-textconv");
    }
    // Non-diff subcommands must not receive diff options (git would reject them).
    expect(safeGitArgs(["status", "--porcelain"])).not.toContain("--no-ext-diff");
    expect(safeGitArgs(["ls-files"])).not.toContain("--no-ext-diff");
  });

  it("hardens `log` even when global options precede the subcommand", () => {
    const args = safeGitArgs(["-c", "core.pager=evil", "log", "-p", "-1"]);
    const at = args.indexOf("log");
    expect(args[at + 1]).toBe("--no-ext-diff");
  });

  it("does not run `diff.external` configured by the repository (SEC-001)", () => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    git(dir, ["config", "diff.external", 'sh -c "echo PWNED-EXT >&2; echo {}"']);

    // The repro is real: raw git executes the repository's program on the host.
    expect(rawGit(dir, ["diff", "HEAD"])).toContain("PWNED-EXT");

    for (const args of [
      ["diff", "HEAD"],
      ["log", "-p", "-1"],
      ["show", "HEAD"],
    ]) {
      const res = git(dir, args);
      expect(`${res.stdout}${res.stderr}`).not.toContain("PWNED-EXT");
    }
  });

  it("does not run a `textconv` driver declared in .gitattributes (SEC-001)", () => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    writeFileSync(join(dir, ".gitattributes"), "*.txt diff=evil\n");
    git(dir, ["config", "diff.evil.textconv", 'sh -c "echo PWNED-TEXTCONV >&2; cat"']);

    // `--no-ext-diff` alone is not enough: the driver still runs.
    expect(rawGit(dir, ["diff", "--no-ext-diff", "HEAD"])).toContain("PWNED-TEXTCONV");

    const res = git(dir, ["diff", "HEAD"]);
    expect(`${res.stdout}${res.stderr}`).not.toContain("PWNED-TEXTCONV");
  });

  it("appends the diff hardening after caller args so a later flag cannot undo it (SEC-001b)", () => {
    // `--ext-diff`/`--textconv` are last-one-wins in git's option parsing, so the
    // hardening must also close the argv, not only follow the subcommand.
    const args = safeGitArgs(["diff", "HEAD", "--ext-diff"]);
    expect(args.slice(-2)).toEqual(["--no-ext-diff", "--no-textconv"]);
    // A `--` path separator ends the option list: nothing may be appended after it
    // (git would read the flags as paths).
    const withSeparator = safeGitArgs(["diff", "HEAD", "--", "src"]);
    expect(withSeparator.lastIndexOf("--no-textconv")).toBeLessThan(
      withSeparator.indexOf("--"),
    );
  });

  it("refuses the flags that undo or redirect the hardening (SEC-001b)", () => {
    for (const args of [
      ["diff", "--textconv", "HEAD"],
      ["diff", "--ext-diff", "HEAD"],
      ["diff", "--no-index", "a", "b"],
      ["log", "--config-env=diff.external=evil", "HEAD"],
      ["log", "--git-dir=/tmp/elsewhere", "HEAD"],
      ["log", "--work-tree=/tmp/elsewhere"],
      ["diff", "HEAD", "--textconv"],
      ["diff", "HEAD", "--ext-diff"],
    ]) {
      const res = gitBounded(dir, args);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("forbidden git argument");
      expect(res.stdout).toBe("");
    }
  });

  it("still fails closed on the same flags before the subcommand or after another one (SEC-103)", () => {
    // The screen is positional: the `rev-parse` exemption below must not reopen
    // the global option position (`git --git-dir=… …`), nor any other subcommand.
    for (const args of [
      ["--git-dir=/tmp/elsewhere", "rev-parse", "HEAD"],
      ["-c", "core.pager=evil", "rev-parse", "HEAD"],
      ["log", "--git-dir", "HEAD"],
      ["rev-parse", "--git-dir=/tmp/elsewhere"],
    ]) {
      const res = gitBounded(dir, args);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("forbidden git argument");
    }
  });

  it("allows the read-only `rev-parse --git-dir` queries huginn needs (SEC-103)", () => {
    // `git rev-parse --git-dir` *asks git where the repository is*; it redirects
    // nothing. Screening it blind made `getDiagnostics().worktreeSandbox`
    // permanently false and warned on every `/status`.
    const gitDir = git(dir, ["rev-parse", "--git-dir"]);
    expect(gitDir.code).toBe(0);
    expect(gitDir.stdout.length).toBeGreaterThan(0);
    expect(gitDir.stderr).toBe("");

    const absolute = gitBounded(dir, ["rev-parse", "--absolute-git-dir"]);
    expect(absolute.code).toBe(0);
    expect(absolute.stdout.trim().length).toBeGreaterThan(0);

    // The exemption is positional, not a hole in the allowlist: the same bare
    // flag stays refused for every other subcommand.
    expect(gitBounded(dir, ["log", "--git-dir"]).stderr).toContain("forbidden git argument");
  });

  it("does not run a repository `diff.external` regardless of caller flags (SEC-001b)", () => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    git(dir, ["config", "diff.external", 'sh -c "echo PWNED-EXT >&2; echo {}"']);

    // Explicitly asking for the external diff runs the repository's program...
    expect(rawGit(dir, ["diff", "--ext-diff", "HEAD"])).toContain("PWNED-EXT");

    // ...the bounded runner refuses the flag...
    const refused = gitBounded(dir, ["diff", "--ext-diff", "HEAD"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("forbidden git argument");
    expect(`${refused.stdout}${refused.stderr}`).not.toContain("PWNED-EXT");

    // ...and the hardened argv neutralises it anyway: the hardening is appended
    // after the caller's arguments, so it wins the last-one-wins race.
    const viaGit = git(dir, ["diff", "--ext-diff", "HEAD"]);
    expect(`${viaGit.stdout}${viaGit.stderr}`).not.toContain("PWNED-EXT");
  });

  it("does not run a textconv driver the caller re-enables with --textconv (SEC-001b)", () => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
    writeFileSync(join(dir, "f.txt"), "a\nb\n");
    writeFileSync(join(dir, ".gitattributes"), "*.txt diff=evil\n");
    git(dir, ["config", "diff.evil.textconv", 'sh -c "echo PWNED-TEXTCONV >&2; cat"']);

    expect(rawGit(dir, ["diff", "--textconv", "HEAD"])).toContain("PWNED-TEXTCONV");

    const refused = gitBounded(dir, ["diff", "--textconv", "HEAD"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("forbidden git argument");
    expect(`${refused.stdout}${refused.stderr}`).not.toContain("PWNED-TEXTCONV");

    const viaGit = git(dir, ["diff", "--textconv", "HEAD"]);
    expect(`${viaGit.stdout}${viaGit.stderr}`).not.toContain("PWNED-TEXTCONV");
  });
});

describe("gitBounded (M-3/REV-104/REV-106/SEC-006)", () => {
  beforeEach(() => {
    writeFileSync(join(dir, "f.txt"), "a\n");
    commitAll(dir);
  });

  it("refuses a subcommand outside the allowlist", () => {
    const res = gitBounded(dir, ["push", "origin", "main"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not allowed");
  });

  it("refuses write/exec escape-hatch flags", () => {
    for (const args of [
      ["log", "-c", "core.pager=evil"],
      ["log", "--output=evil.txt"],
      ["log", "--exec-path=/tmp"],
      ["log", "--upload-pack=evil"],
      ["log", "-Ox"],
    ]) {
      const res = gitBounded(dir, args);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("forbidden git argument");
    }
  });

  it("treats a signal-killed process as a failure, not an empty success (REV-106)", () => {
    const res = gitBounded(dir, ["log", "-p"], { timeoutMs: 1 });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("timed out");
  });

  it("bounds the capture and reports stdout truncation separately from stderr", () => {
    const res = gitBounded(dir, ["log", "-p"], { maxBytes: 8 });
    expect(res.stdoutTruncated).toBe(true);
    expect(res.stderrTruncated).toBe(false);
    expect(res.stdout.length).toBeLessThanOrEqual(8);
  });

  it("runs a normal read-only query", () => {
    const res = gitBounded(dir, ["rev-parse", "HEAD"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toHaveLength(40);
  });
});

describe("hasImplementationCode", () => {
  it("returns false when only markdown docs exist", () => {
    for (const f of ["SPEC.md", "ADR.md", "PLAN.md", "README.md"]) {
      writeFileSync(join(dir, f), "# doc\n");
    }
    expect(hasImplementationCode(dir)).toBe(false);
  });

  it("returns false for a scaffolded repo with config but no source", () => {
    writeFileSync(join(dir, "SPEC.md"), "# spec\n");
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "tsconfig.json"), "{}\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    mkdirSync(join(dir, "src"));
    expect(hasImplementationCode(dir)).toBe(false);
  });

  it("returns false for only hidden files and ignored dirs", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    mkdirSync(join(dir, ".harness"));
    writeFileSync(join(dir, ".harness/state.json"), "{}");
    expect(hasImplementationCode(dir)).toBe(false);
  });

  it("returns true when a source file exists in a source dir", () => {
    writeFileSync(join(dir, "SPEC.md"), "# doc\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/index.ts"), "export const a = 1;\n");
    expect(hasImplementationCode(dir)).toBe(true);
  });

  it("returns true for a root-level source file", () => {
    writeFileSync(join(dir, "app.py"), "print('hi')\n");
    expect(hasImplementationCode(dir)).toBe(true);
  });

  it("does not treat non-source files (html/json/markdown variants) as implementation", () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/index.html"), "<p>hi</p>\n");
    writeFileSync(join(dir, "notes.mdx"), "# notes\n");
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data/config.json"), "{}");
    expect(hasImplementationCode(dir)).toBe(false);
  });
});
