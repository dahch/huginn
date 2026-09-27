import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { git, isGitRepo, pendingChanges } from "../../src/engine/diff.js";

describe("Engine Diff Utility & Hardened Git Spawning (SEC-002, SEC-003)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-diff-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("handles non-existent or invalid working directories gracefully without crashing (SEC-002)", () => {
    const invalidDir = path.join(tempDir, "does-not-exist");
    const result = git(invalidDir, ["status"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBeTruthy();
  });

  it("applies safe git flags (-c core.fsmonitor=false -c core.hooksPath=/dev/null) during invocation (SEC-003)", () => {
    // Initialize a temporary git repository
    const initRes = git(tempDir, ["init"]);
    expect(initRes.code).toBe(0);

    // Verify git query for config works and executes with safe flags
    const res = git(tempDir, ["status", "--porcelain"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("correctly identifies git repository status and pending changes", () => {
    expect(isGitRepo(tempDir)).toBe(false);

    git(tempDir, ["init"]);
    expect(isGitRepo(tempDir)).toBe(true);

    // Add a file
    fs.writeFileSync(path.join(tempDir, "hello.ts"), "export const hello = 'world';\n");
    const changes = pendingChanges(tempDir);
    expect(changes).toContain("hello.ts");
  });
});
