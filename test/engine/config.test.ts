import { describe, it, expect, afterAll, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_THINKER_MODEL,
  getProjectConfigPath,
  getUserConfigPath,
  loadUserConfig,
  resolveModelsFromConfig,
  saveUserConfig,
  saveGlobalUserConfig,
} from "../../src/config.js";

// Each test gets an isolated project + home directory so config files never
// leak across cases. Every temp root is removed once at the end.
const roots: string[] = [];

function makeEnv(): { project: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "huginn-config-test-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { project, home };
}

function writeProjectConfig(project: string, value: unknown): void {
  mkdirSync(join(project, ".huginn"), { recursive: true });
  const body = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(getProjectConfigPath(project), body, "utf8");
}

function writeUserConfig(home: string, value: unknown): void {
  mkdirSync(join(home, ".huginn"), { recursive: true });
  const body = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(getUserConfigPath(home), body, "utf8");
}

function silenceWarnings(): void {
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

describe("resolveModelsFromConfig", () => {
  it("falls back to the documented defaults when no layer provides a model", () => {
    expect(resolveModelsFromConfig({ env: {} })).toEqual({
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("resolves from the environment when nothing higher is set", () => {
    expect(
      resolveModelsFromConfig({
        env: { HUGINN_THINKER_MODEL: "env/thinker", HUGINN_EXECUTOR_MODEL: "env/executor" },
      }),
    ).toEqual({ thinker: "env/thinker", executor: "env/executor" });
  });

  it("prefers user config over the environment, per key", () => {
    expect(
      resolveModelsFromConfig({
        userConfig: { thinker: "user/thinker" },
        env: { HUGINN_THINKER_MODEL: "env/thinker", HUGINN_EXECUTOR_MODEL: "env/executor" },
      }),
    ).toEqual({ thinker: "user/thinker", executor: "env/executor" });
  });

  it("prefers project config over user config, per key", () => {
    expect(
      resolveModelsFromConfig({
        projectConfig: { thinker: "project/thinker" },
        userConfig: { thinker: "user/thinker", executor: "user/executor" },
        env: { HUGINN_THINKER_MODEL: "env/thinker" },
      }),
    ).toEqual({ thinker: "project/thinker", executor: "user/executor" });
  });

  it("prefers CLI flags over every persistent layer", () => {
    expect(
      resolveModelsFromConfig({
        flagThinker: "flag/thinker",
        flagExecutor: "flag/executor",
        projectConfig: { thinker: "project/thinker", executor: "project/executor" },
        userConfig: { thinker: "user/thinker", executor: "user/executor" },
        env: { HUGINN_THINKER_MODEL: "env/thinker", HUGINN_EXECUTOR_MODEL: "env/executor" },
      }),
    ).toEqual({ thinker: "flag/thinker", executor: "flag/executor" });
  });

  it("treats blank values as absent and keeps falling through", () => {
    expect(
      resolveModelsFromConfig({
        flagThinker: "   ",
        projectConfig: { thinker: "project/thinker" },
        env: {},
      }).thinker,
    ).toBe("project/thinker");
  });

  it("reads process.env only when an injectable env is not provided", () => {
    const prevT = process.env.HUGINN_THINKER_MODEL;
    const prevE = process.env.HUGINN_EXECUTOR_MODEL;
    process.env.HUGINN_THINKER_MODEL = "proc/thinker";
    process.env.HUGINN_EXECUTOR_MODEL = "proc/executor";
    try {
      expect(resolveModelsFromConfig({})).toEqual({
        thinker: "proc/thinker",
        executor: "proc/executor",
      });
    } finally {
      if (prevT === undefined) delete process.env.HUGINN_THINKER_MODEL;
      else process.env.HUGINN_THINKER_MODEL = prevT;
      if (prevE === undefined) delete process.env.HUGINN_EXECUTOR_MODEL;
      else process.env.HUGINN_EXECUTOR_MODEL = prevE;
    }
  });
});

describe("config paths", () => {
  it("builds the documented project and user paths", () => {
    expect(getProjectConfigPath("/tmp/proj")).toBe(join("/tmp/proj", ".huginn", "config.json"));
    expect(getUserConfigPath("/tmp/home")).toBe(join("/tmp/home", ".huginn", "config.json"));
  });
});

describe("loadUserConfig", () => {
  it("returns an empty object when neither file exists", () => {
    const { project, home } = makeEnv();
    expect(loadUserConfig(project, home)).toEqual({});
  });

  it("reads the user config when the project config is missing", () => {
    const { project, home } = makeEnv();
    writeUserConfig(home, { thinker: "user/thinker", executor: "user/executor" });
    expect(loadUserConfig(project, home)).toEqual({
      thinker: "user/thinker",
      executor: "user/executor",
    });
  });

  it("prefers project keys over user keys", () => {
    const { project, home } = makeEnv();
    writeUserConfig(home, { thinker: "user/thinker", executor: "user/executor" });
    writeProjectConfig(project, { thinker: "project/thinker" });
    expect(loadUserConfig(project, home)).toEqual({
      thinker: "project/thinker",
      executor: "user/executor",
    });
  });

  it("ignores a malformed project config and falls back to the user config", () => {
    const { project, home } = makeEnv();
    writeUserConfig(home, { thinker: "user/thinker" });
    writeProjectConfig(project, "{ definitely not json");
    silenceWarnings();
    expect(loadUserConfig(project, home)).toEqual({ thinker: "user/thinker" });
  });

  it("runtime-validates known keys and preserves unknown ones", () => {
    const { project, home } = makeEnv();
    writeProjectConfig(project, { mode: "bogus", thinker: 42, keepMe: { a: 1 } });
    silenceWarnings();
    expect(loadUserConfig(project, home)).toEqual({ keepMe: { a: 1 } });
  });
});

describe("saveUserConfig", () => {
  it("round-trips values and preserves pre-existing unknown keys", () => {
    const { project, home } = makeEnv();
    writeProjectConfig(project, { thinker: "project/thinker", customKey: { nested: true } });

    saveUserConfig(project, { executor: "project/executor" });

    expect(loadUserConfig(project, home)).toEqual({
      thinker: "project/thinker",
      executor: "project/executor",
      customKey: { nested: true },
    });

    const onDisk = JSON.parse(readFileSync(getProjectConfigPath(project), "utf8")) as Record<string, unknown>;
    expect(onDisk.customKey).toEqual({ nested: true });
  });

  it("creates .huginn/ with mode 0o700 and the config with mode 0o600", () => {
    const { project } = makeEnv();
    saveUserConfig(project, { thinker: "project/thinker" });
    expect(statSync(join(project, ".huginn")).mode & 0o777).toBe(0o700);
    expect(statSync(getProjectConfigPath(project)).mode & 0o777).toBe(0o600);
  });

  it("writes valid JSON that a subsequent load can read", () => {
    const { project, home } = makeEnv();
    saveUserConfig(project, { mode: "supervised", extra: "value" });
    expect(loadUserConfig(project, home)).toEqual({ mode: "supervised", extra: "value" });
  });

  it("refuses to write when the .huginn directory is a symlink (SEC-901)", () => {
    const { project } = makeEnv();
    const real = join(project, "real-huginn");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(project, ".huginn"));

    expect(() => saveUserConfig(project, { thinker: "evil/thinker" })).toThrow(/symlink/i);
    // nothing was written through the symlink
    expect(existsSync(join(real, "config.json"))).toBe(false);
  });

  it("never writes through a pre-existing symlink at the legacy temp path (SEC-901)", () => {
    const { project, home } = makeEnv();
    mkdirSync(join(project, ".huginn"), { recursive: true });
    const victim = join(project, "victim.txt");
    writeFileSync(victim, "original", "utf8");
    // The old implementation wrote to `<config>.tmp` with default flags, which
    // would follow this symlink and clobber the victim.
    symlinkSync(victim, `${getProjectConfigPath(project)}.tmp`);

    saveUserConfig(project, { thinker: "safe/thinker" });

    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(loadUserConfig(project, home)).toEqual({ thinker: "safe/thinker" });
    // no stray temp files left behind
    const leftovers = readdirSync(join(project, ".huginn")).filter((f) => f.endsWith(".tmp"));
    expect(leftovers.filter((f) => f !== "config.json.tmp")).toEqual([]);
  });
});

describe("saveGlobalUserConfig", () => {
  it("persists global user config using primary signature (config, homeDir) (SEC-003)", () => {
    const { project, home } = makeEnv();
    saveGlobalUserConfig({ thinker: "global/thinker", executor: "global/executor" }, home);

    expect(loadUserConfig(project, home)).toEqual({
      thinker: "global/thinker",
      executor: "global/executor",
    });

    const onDisk = JSON.parse(readFileSync(getUserConfigPath(home), "utf8")) as Record<string, unknown>;
    expect(onDisk.thinker).toBe("global/thinker");
    expect(onDisk.executor).toBe("global/executor");
  });

  it("supports legacy overload (homeDir, config) cleanly (SEC-003)", () => {
    const { project, home } = makeEnv();
    saveGlobalUserConfig(home, { thinker: "legacy/thinker" });

    expect(loadUserConfig(project, home)).toEqual({
      thinker: "legacy/thinker",
    });
  });

  it("supports single-argument call saveGlobalUserConfig(config) without undefined as any (SEC-003)", () => {
    const { project, home } = makeEnv();
    const orig = process.env.HUGINN_HOME;
    process.env.HUGINN_HOME = home;
    try {
      saveGlobalUserConfig({ thinker: "direct/thinker" });
      expect(loadUserConfig(project, home)).toEqual({
        thinker: "direct/thinker",
      });
    } finally {
      if (orig === undefined) delete process.env.HUGINN_HOME;
      else process.env.HUGINN_HOME = orig;
    }
  });
});

describe("sanitizeConfig prototype safety", () => {
  it("does not let __proto__ in config JSON pollute the prototype (SEC-902)", () => {
    const { project, home } = makeEnv();
    writeProjectConfig(project, '{"__proto__":{"polluted":true},"thinker":"project/thinker"}');
    silenceWarnings();

    const cfg = loadUserConfig(project, home);

    expect(cfg.thinker).toBe("project/thinker");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(cfg.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype);
  });

  it("rejects constructor and prototype keys as well", () => {
    const { project, home } = makeEnv();
    writeProjectConfig(project, { constructor: { bad: true }, prototype: { bad: true }, thinker: "x" });
    silenceWarnings();

    const cfg = loadUserConfig(project, home);
    expect(cfg.thinker).toBe("x");
    expect(Object.prototype.hasOwnProperty.call(cfg, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cfg, "prototype")).toBe(false);
  });

  it("validates agent against AGENT_TARGETS allowlist and rejects arbitrary binaries (SEC-001)", () => {
    const { project, home } = makeEnv();
    writeProjectConfig(project, { agent: "malicious_binary", thinker: "safe/thinker" });
    silenceWarnings();

    const cfg = loadUserConfig(project, home);
    expect(cfg.thinker).toBe("safe/thinker");
    expect(cfg.agent).toBeUndefined();

    writeProjectConfig(project, { agent: "claude" });
    const validCfg = loadUserConfig(project, home);
    expect(validCfg.agent).toBe("claude");
  });
});
