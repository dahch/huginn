import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { handleConfigCommand, printConfigUsage } from "../../src/commands/config.js";
import {
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_THINKER_MODEL,
  getProjectConfigPath,
  getUserConfigPath,
} from "../../src/config.js";

// Isolated temp project + home per case so the real `~` is never touched.
const roots: string[] = [];

interface Env {
  project: string;
  home: string;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "huginn-config-cmd-test-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { project, home };
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

/**
 * Invoke the handler with `--project`/`--home` pinned to the temp env, capture
 * and return everything it logged (ANSI stripped).
 */
async function invoke(
  env: Env,
  subcommand: string | undefined,
  flags: Record<string, string | boolean | undefined> = {},
): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  });
  try {
    await handleConfigCommand(subcommand, {
      "--project": env.project,
      "--home": env.home,
      ...flags,
    });
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return stripAnsi(lines.join("\n"));
}

const ENV_KEYS = ["HUGINN_THINKER_MODEL", "HUGINN_EXECUTOR_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Point a model env var at a value (or remove it) and remember the original. */
function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("huginn config set", () => {
  it("writes the project config and show reflects it with source: project", async () => {
    const env = makeEnv();

    const setOutput = await invoke(env, "set", { "--thinker": "project/model" });
    expect(setOutput).toContain(getProjectConfigPath(env.project));
    expect(existsSync(getProjectConfigPath(env.project))).toBe(true);
    const onDisk = JSON.parse(readFileSync(getProjectConfigPath(env.project), "utf8")) as {
      thinker?: string;
    };
    expect(onDisk.thinker).toBe("project/model");

    const showOutput = await invoke(env, "show");
    expect(showOutput).toMatch(/thinker\s*=\s*project\/model\s+\(source:\s*project\)/);
    expect(showOutput).toContain(getProjectConfigPath(env.project));
    expect(showOutput).toContain(getUserConfigPath(env.home));
  });

  it("persists to the user config with --global and leaves the project untouched", async () => {
    const env = makeEnv();

    const output = await invoke(env, "set", { "--global": true, "--executor": "user/exec" });
    expect(output).toContain(getUserConfigPath(env.home));
    expect(existsSync(getUserConfigPath(env.home))).toBe(true);
    expect(existsSync(getProjectConfigPath(env.project))).toBe(false);

    const onDisk = JSON.parse(readFileSync(getUserConfigPath(env.home), "utf8")) as {
      executor?: string;
    };
    expect(onDisk.executor).toBe("user/exec");

    const showOutput = await invoke(env, "show");
    expect(showOutput).toMatch(/executor\s*=\s*user\/exec\s+\(source:\s*user\)/);
  });

  it("errors (non-zero) when no model flag is provided", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const output = await invoke(env, "set");
      expect(process.exitCode).toBe(1);
      expect(output).toContain("Usage:");
      expect(existsSync(getProjectConfigPath(env.project))).toBe(false);
    } finally {
      process.exitCode = previous;
    }
  });

  it("errors (non-zero) on an empty model value", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const output = await invoke(env, "set", { "--thinker": "   " });
      expect(process.exitCode).toBe(1);
      expect(output).toContain("Usage:");
      expect(existsSync(getProjectConfigPath(env.project))).toBe(false);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe("huginn config show precedence", () => {
  it("reports flag → project → user → env → default by layer", async () => {
    const env = makeEnv();
    writeConfig(getProjectConfigPath(env.project), { thinker: "project/t" });
    writeConfig(getUserConfigPath(env.home), { executor: "user/e" });
    setEnv("HUGINN_THINKER_MODEL", "env/t");
    setEnv("HUGINN_EXECUTOR_MODEL", "env/e");

    // Flag wins for thinker; executor falls through the absent project key to user.
    const withFlag = await invoke(env, "show", { "--thinker": "flag/t" });
    expect(withFlag).toMatch(/thinker\s*=\s*flag\/t\s+\(source:\s*flag\)/);
    expect(withFlag).toMatch(/executor\s*=\s*user\/e\s+\(source:\s*user\)/);

    // Without the flag, project then user win over env.
    const withoutFlag = await invoke(env, "show");
    expect(withoutFlag).toMatch(/thinker\s*=\s*project\/t\s+\(source:\s*project\)/);
    expect(withoutFlag).toMatch(/executor\s*=\s*user\/e\s+\(source:\s*user\)/);
  });

  it("falls back to env and then to the documented defaults", async () => {
    const env = makeEnv();
    setEnv("HUGINN_THINKER_MODEL", "env/t");
    setEnv("HUGINN_EXECUTOR_MODEL", "env/e");

    const fromEnv = await invoke(env, "show");
    expect(fromEnv).toMatch(/thinker\s*=\s*env\/t\s+\(source:\s*env\)/);
    expect(fromEnv).toMatch(/executor\s*=\s*env\/e\s+\(source:\s*env\)/);

    setEnv("HUGINN_THINKER_MODEL", undefined);
    setEnv("HUGINN_EXECUTOR_MODEL", undefined);
    const defaults = await invoke(env, "show");
    expect(defaults).toContain(`thinker  = ${DEFAULT_THINKER_MODEL}`);
    expect(defaults).toContain(`executor = ${DEFAULT_EXECUTOR_MODEL}`);
    expect(defaults).toMatch(/thinker\s*=\s*.*\(source:\s*default\)/);
    expect(defaults).toMatch(/executor\s*=\s*.*\(source:\s*default\)/);
  });
});

describe("huginn config routing", () => {
  it("prints usage (no error) for no subcommand", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const output = await invoke(env, undefined);
      expect(output).toContain("Usage:");
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previous;
    }
  });

  it("rejects an unknown subcommand with a non-zero exit code", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const output = await invoke(env, "bogus");
      expect(process.exitCode).toBe(1);
      expect(output).toContain("Unknown subcommand");
      expect(output).toContain("Usage:");
    } finally {
      process.exitCode = previous;
    }
  });

  it("exposes a usage printer", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printConfigUsage();
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
