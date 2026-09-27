import { afterAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../../src/agents/integrator.js";
import {
  handleDoctorCommand,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorReport,
} from "../../src/commands/setup.js";

const roots: string[] = [];

interface Env {
  root: string;
  project: string;
  home: string;
  opencodeConfigDir: string;
  dbPath: string;
}

function makeEnv(gitInit: boolean): Env {
  const root = mkdtempSync(join(tmpdir(), "huginn-doctor-test-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  const opencodeConfigDir = join(root, "opencode-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(opencodeConfigDir, { recursive: true });
  if (gitInit) {
    const res = spawnSync("git", ["init"], { cwd: project, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git init failed: ${res.stderr}`);
  }
  return {
    root,
    project,
    home,
    opencodeConfigDir,
    dbPath: join(project, ".huginn", "muninn.db"),
  };
}

function options(env: Env) {
  return {
    projectPath: env.project,
    homeDir: env.home,
    opencodeConfigDir: env.opencodeConfigDir,
    env: {},
    dbPath: env.dbPath,
  };
}

function byId(report: DoctorReport): Map<string, DoctorCheck> {
  return new Map(report.checks.map((check) => [check.id, check]));
}

afterAll(() => {
  vi.restoreAllMocks();
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("runDoctorChecks", () => {
  it("returns an ok report with git/runtime/Muninn ok in an initialized git repo", () => {
    const env = makeEnv(true);
    const report = runDoctorChecks(options(env));
    const checks = byId(report);

    expect(report.ok).toBe(true);
    expect(checks.get("git-repo")?.status).toBe("ok");
    expect(checks.get("git-repo")?.critical).toBe(true);
    expect(checks.get("runtime")?.status).toBe("ok");
    expect(checks.get("runtime")?.critical).toBe(true);
    expect(checks.get("muninn")?.status).toBe("ok");
    expect(checks.get("muninn")?.critical).toBe(true);

    expect(checks.get("git-binary")?.status).toBe("ok");
    expect(report.checks.map((c) => c.id)).toEqual([
      "git-binary",
      "git-repo",
      "runtime",
      "node",
      "opencode",
      "integrations",
      "muninn",
    ]);
  });

  it("is independent of console output (structured report only)", () => {
    const env = makeEnv(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const report = runDoctorChecks(options(env));
      expect(logSpy).not.toHaveBeenCalled();
      expect(report.checks).toHaveLength(7);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("warns (never fails) while no agent integrations are registered", () => {
    const env = makeEnv(true);
    const report = runDoctorChecks(options(env));
    const integrations = byId(report).get("integrations");
    expect(integrations?.status).toBe("warn");
    expect(integrations?.critical).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("sees every registered target after setup()", () => {
    const env = makeEnv(true);
    setup({
      agent: "all",
      projectPath: env.project,
      homeDir: env.home,
      opencodeConfigDir: env.opencodeConfigDir,
      env: {},
    });

    const report = runDoctorChecks(options(env));
    const integrations = byId(report).get("integrations");
    expect(integrations?.status).toBe("ok");
    expect(integrations?.detail).toContain("12/12");
  });

  it("marks the git-repo critical check failed outside a repo", () => {
    const env = makeEnv(false);
    const report = runDoctorChecks(options(env));
    const checks = byId(report);

    expect(checks.get("git-repo")?.status).toBe("fail");
    expect(checks.get("git-repo")?.critical).toBe(true);
    expect(report.ok).toBe(false);
  });
});

describe("handleDoctorCommand", () => {
  it("sets exitCode 0 and prints check lines for a healthy repo", async () => {
    const env = makeEnv(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await handleDoctorCommand({
        "--project": env.project,
        "--home": env.home,
        "--opencode-config-dir": env.opencodeConfigDir,
      });
      expect(process.exitCode).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(printed).toContain("✔");
      expect(printed).toContain("all critical checks passed");
    } finally {
      process.exitCode = previous;
      logSpy.mockRestore();
    }
  });

  it("sets exitCode 1 when the project is not a git repository", async () => {
    const env = makeEnv(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await handleDoctorCommand({
        "--project": env.project,
        "--home": env.home,
        "--opencode-config-dir": env.opencodeConfigDir,
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
      logSpy.mockRestore();
    }
  });
});
