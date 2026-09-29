import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { PassThrough, Readable, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AGENT_TARGETS, type SetupReport } from "../../src/agents/integrator.js";
import { git } from "../../src/engine/diff.js";
import {
  detectPackageManager,
  handleInitCommand,
  printInitUsage,
  PRIMARY_AGENT_CLIS,
  type AgentDetection,
  type InitDeps,
  type InitReport,
  type PackageManager,
} from "../../src/commands/init.js";
import {
  DEFAULT_AGENT,
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_THINKER_MODEL,
  getProjectConfigPath,
} from "../../src/config.js";
import type { IAgentRuntime, ModelInfo } from "../../src/engine/agent/types.js";
import {
  handleGreenfieldLaunch,
  isGreenfieldLaunch,
  main,
  parseArgs,
  shouldLaunchInit,
  usage,
  usageCore,
} from "../../src/cli.js";

// Isolated temp project + home + opencode config dir per case so neither the
// real `~`, the real opencode config nor the real project is ever touched.
const roots: string[] = [];

interface Env {
  root: string;
  project: string;
  home: string;
  opencodeConfigDir: string;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "huginn-init-test-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  const opencodeConfigDir = join(root, "opencode-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(opencodeConfigDir, { recursive: true });
  return { root, project, home, opencodeConfigDir };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

/** A full 13-target PATH scan in the real registry order; two are installed. */
const DETECTED: AgentDetection[] = AGENT_TARGETS.map((id) =>
  id === "claude" || id === "opencode"
    ? { id, available: true, path: `/usr/local/bin/${id}` }
    : { id, available: false },
);
/**
 * The wizard's default agent for {@link DETECTED} — its first `available: true`
 * entry. `DETECTED` follows `AGENT_TARGETS`, which is the `AGENT_REGISTRY` key
 * order (cursor, claude, opencode, …), but the wizard displays and defaults from
 * `PRIMARY_AGENT_CLIS` (opencode, claude, codex, omp) first, so `opencode` beats
 * `claude` even though the registry lists `claude` first (REV-203/REV-212).
 */
const FIRST_AVAILABLE = "opencode";

/** A successful `huginn setup` result; the wizard only checks its presence. */
const SETUP_OK: SetupReport = {
  registrations: [],
  rules: [],
  portable: { path: "", changed: false },
};

/** A failed `huginn setup` delegation (unknown agent / write error). */
const SETUP_FAILED = undefined;

/**
 * A runtime stub whose catalog is empty *with a reason*, so the wizard takes the
 * plain-text model path. Injected by {@link runInit} by default so no test ever
 * spawns a real agent CLI (`opencode`/`claude`/`codex` are installed on the
 * reference machine); cases that exercise the Phase 5 picker override
 * `getRuntime` with a catalog-bearing fake.
 */
function emptyCatalogRuntime(reason = "no model-listing command for this runtime"): IAgentRuntime {
  return {
    id: "opencode",
    name: "stub",
    isAvailable: async () => false,
    getAvailableModels: async () => [],
    getModelCatalog: async () => ({ models: [], reason }),
    getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    createSession: async () => ({
      id: "stub-session",
      prompt: async () => ({ messageId: "stub", text: "" }),
      abort: async () => {},
    }),
  };
}

/** A runtime stub that reports the given (fake) model catalog. */
function catalogRuntime(models: ModelInfo[], reason?: string): IAgentRuntime {
  return {
    ...emptyCatalogRuntime(reason),
    getAvailableModels: async () => models,
    getModelCatalog: async () => ({ models, reason }),
  };
}

/**
 * A runtime stub that exposes ONLY the base `getAvailableModels()` accessor (no
 * `getModelCatalog`), the shape older adapters still have — exercises the
 * fallback branch of the shared discovery helper (REV-503).
 */
function legacyCatalogRuntime(models: ModelInfo[]): IAgentRuntime {
  return {
    id: "opencode",
    name: "stub",
    isAvailable: async () => false,
    getAvailableModels: async () => models,
    getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    createSession: async () => ({
      id: "stub-session",
      prompt: async () => ({ messageId: "stub", text: "" }),
      abort: async () => {},
    }),
  };
}

interface Capture {
  output: string;
  errors: string;
  report?: InitReport;
  setupCalls: Record<string, string | boolean | undefined>[];
  detectCalls: string[];
}

/**
 * Invoke the wizard with `--project`/`--home`/`--opencode-config-dir` pinned to
 * the temp env, `isTTY: false` + an empty environment, a fake agent scan and a
 * recording (never executing) `runSetup`. Everything is injectable, so nothing
 * outside the temp root can be written.
 */
async function runInit(
  env: Env,
  flags: Record<string, string | boolean | undefined> = {},
  deps: InitDeps = {},
): Promise<Capture> {
  const lines: string[] = [];
  const errors: string[] = [];
  const setupCalls: Record<string, string | boolean | undefined>[] = [];
  const detectCalls: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map((part) => String(part)).join(" "));
  });
  let report: InitReport | undefined;
  try {
    report = await handleInitCommand(
      {
        "--project": env.project,
        "--home": env.home,
        "--opencode-config-dir": env.opencodeConfigDir,
        ...flags,
      },
      {
        isTTY: false,
        env: {},
        // Phase 5: a hermetic runtime stub by default, so no test spawns a real
        // agent CLI for the model picker; catalog cases override `getRuntime`.
        getRuntime: () => emptyCatalogRuntime(),
        detectAgents: async (pathEnv?: string): Promise<AgentDetection[]> => {
          detectCalls.push(pathEnv ?? "");
          return DETECTED;
        },
        runSetup: async (args): Promise<SetupReport | undefined> => {
          setupCalls.push(args);
          return SETUP_OK;
        },
        ...deps,
      },
    );
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return {
    output: stripAnsi(lines.join("\n")),
    errors: stripAnsi(errors.join("\n")),
    report,
    setupCalls,
    detectCalls,
  };
}

async function captureMain(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  });
  try {
    await main(argv);
  } finally {
    logSpy.mockRestore();
  }
  return stripAnsi(lines.join("\n"));
}

function readConfig(env: Env): Record<string, unknown> {
  return JSON.parse(readFileSync(getProjectConfigPath(env.project), "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * A stand-in for an interactive terminal stdin, handed to the wizard through the
 * `stdin` dep. The real prompt implementation (`promptLine` → `node:readline`)
 * reads the injected stream, so this reaches the *production* readline path
 * without ever touching `process.stdin`. Exactly one line is pushed per
 * macrotask: that guarantees each scripted answer lands in the `readline`
 * interface that is waiting for it, instead of being emitted as a stray `line`
 * event while no `question()` is pending (and then dropped).
 */
class ScriptedTtyStdin extends Readable {
  isTTY = true;
  private scheduled = false;
  private lines: string[];

  constructor(lines: string[]) {
    super({ encoding: "utf8" });
    this.lines = [...lines];
  }

  /** `readline` calls this when it enters raw mode. */
  setRawMode(): this {
    return this;
  }

  /** Answers that no prompt consumed yet. */
  remaining(): number {
    return this.lines.length;
  }

  override _read(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const next = this.lines.shift();
      if (next !== undefined) this.push(`${next}\n`);
    });
  }
}

/** A TTY-looking sink so prompt output never reaches the test reporter. */
function discardOutput(): Writable {
  const sink = new Writable({
    write: (_chunk, _encoding, callback): void => callback(),
  }) as Writable & { isTTY?: boolean };
  sink.isTTY = true;
  return sink;
}

/**
 * Interactive wizard run driven by a scripted TTY injected through the
 * `stdin`/`stdout` seam (so the wizard's own TTY probe decides `interactive`)
 * and the *real* `promptChoiceDefault`/`promptTextDefault`/`promptLine`
 * executing real `node:readline` against those streams. Every side effect still
 * stays inside the temp project/home.
 */
async function runInitTty(
  env: Env,
  script: string[],
  flags: Record<string, string | boolean | undefined> = {},
  deps: InitDeps = {},
): Promise<Capture & { stdin: ScriptedTtyStdin }> {
  const stdin = new ScriptedTtyStdin(script);
  // `isTTY: undefined` defeats the `isTTY: false` default of `runInit` so the
  // wizard's own `stdin.isTTY && stdout.isTTY` probe runs.
  const cap = await runInit(env, flags, {
    isTTY: undefined,
    stdin,
    stdout: discardOutput(),
    ...deps,
  });
  return { ...cap, stdin };
}

/**
 * Interactive wizard run whose injected stdio is *not* a TTY: the wizard is told
 * `isTTY: true` (so it does call the prompt implementations) while the prompt's
 * own stream probe sees pipes, which must make every prompt short-circuit to its
 * fallback instead of blocking on input.
 */
async function runInitPiped(
  env: Env,
  flags: Record<string, string | boolean | undefined> = {},
  deps: InitDeps = {},
): Promise<Capture> {
  return runInit(env, flags, {
    isTTY: true,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    ...deps,
  });
}

function writeFileEnsured(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

afterEach(() => {
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

describe("detectPackageManager", () => {
  const cases: Array<[string, PackageManager]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];

  for (const [lockfile, expected] of cases) {
    it(`maps ${lockfile} to ${expected}`, () => {
      const env = makeEnv();
      writeFileSync(join(env.project, lockfile), "");
      expect(detectPackageManager(env.project)).toBe(expected);
    });
  }

  it("falls back to npm when only package.json is present", () => {
    const env = makeEnv();
    writeFileSync(join(env.project, "package.json"), "{}");
    expect(detectPackageManager(env.project)).toBe("npm");
  });

  it("returns unknown for a directory with neither package.json nor a lockfile", () => {
    const env = makeEnv();
    expect(detectPackageManager(env.project)).toBe("unknown");
  });

  it("prefers bun when several lockfiles coexist", () => {
    const env = makeEnv();
    writeFileSync(join(env.project, "package-lock.json"), "");
    writeFileSync(join(env.project, "yarn.lock"), "");
    writeFileSync(join(env.project, "bun.lock"), "");
    expect(detectPackageManager(env.project)).toBe("bun");
  });
});

describe("huginn init wizard — non-interactive", () => {
  it("writes .huginn/config.json and runs setup for the detected agent (--yes)", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true });

    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
    expect(cap.report?.configWritten).toBe(true);
    expect(cap.report?.setupRan).toBe(true);
    expect(cap.setupCalls).toHaveLength(1);
    expect(cap.setupCalls[0]["--agent"]).toBe(FIRST_AVAILABLE);
    expect(cap.setupCalls[0]["--project"]).toBe(env.project);
    expect(cap.setupCalls[0]["--home"]).toBe(env.home);
    expect(cap.setupCalls[0]["--opencode-config-dir"]).toBe(env.opencodeConfigDir);
  });

  it("keeps every side effect inside the injected project/home", async () => {
    const env = makeEnv();
    await runInit(env, { "--yes": true });

    expect(existsSync(getProjectConfigPath(env.project))).toBe(true);
    expect(existsSync(join(env.home, ".huginn"))).toBe(false);
    expect(existsSync(join(env.home, ".config"))).toBe(false);
    expect(existsSync(join(env.project, ".cursor"))).toBe(false);
    expect(existsSync(join(env.root, "home", ".claude.json"))).toBe(false);
  });

  it("prints every wizard step and reports the findings", async () => {
    const env = makeEnv();
    writeFileSync(join(env.project, "bun.lock"), "");
    const cap = await runInit(env, { "--yes": true });

    for (const step of [
      "1. Repository",
      "2. Package manager",
      "3. Agent CLIs",
      "4. Agent & models",
      "5. Muninn MCP",
      "6. Project config",
    ]) {
      expect(cap.output).toContain(step);
    }
    expect(cap.output).toContain("--yes defaults");
    expect(cap.output).toContain("init complete");
    // the findings are reported on stdout; InitReport carries only the decisions
    expect(cap.output).toContain("bun");
    expect(cap.output).toContain("devin");
    expect(cap.detectCalls).toHaveLength(1);
  });

  it("prints the primary CLIs first and defaults to the first available of that list", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true });

    const primaryLine = cap.output.indexOf(`✔ ${PRIMARY_AGENT_CLIS[0]}`);
    const secondaryPrimaryLine = cap.output.indexOf(`✔ ${PRIMARY_AGENT_CLIS[1]}`);
    expect(primaryLine).toBeGreaterThan(-1);
    expect(secondaryPrimaryLine).toBeGreaterThan(-1);
    // display order is primary-first...
    expect(primaryLine).toBeLessThan(secondaryPrimaryLine);
    // ...and the default derives from that same list, so the two agree (REV-203)
    expect(FIRST_AVAILABLE).toBe(PRIMARY_AGENT_CLIS[0]);
    expect(cap.report?.agent).toBe(FIRST_AVAILABLE);
    expect(readConfig(env).agent).toBe(FIRST_AVAILABLE);
  });

  it("honours --agent/--thinker/--executor flags", async () => {
    const env = makeEnv();
    const cap = await runInit(env, {
      "--yes": true,
      "--agent": "codex",
      "--thinker": "vendor/think",
      "--executor": "vendor/exec",
    });

    expect(readConfig(env)).toEqual({
      agent: "codex",
      thinker: "vendor/think",
      executor: "vendor/exec",
    });
    expect(cap.setupCalls[0]["--agent"]).toBe("codex");
  });

  it("falls back to the default agent when no agent CLI is installed", async () => {
    const env = makeEnv();
    const cap = await runInit(
      env,
      { "--yes": true },
      { detectAgents: async () => DETECTED.map((d) => ({ id: d.id, available: false })) },
    );

    expect(cap.report?.agent).toBe(DEFAULT_AGENT);
    expect(readConfig(env).agent).toBe(DEFAULT_AGENT);
  });

  it("never prompts without a TTY and uses the documented defaults", async () => {
    const env = makeEnv();
    const promptText = vi.fn(async () => "unused");
    const promptChoice = vi.fn(async () => "unused");
    const cap = await runInit(env, {}, { promptText, promptChoice });

    expect(promptText).not.toHaveBeenCalled();
    expect(promptChoice).not.toHaveBeenCalled();
    expect(cap.output).toContain("non-interactive");
    expect(cap.output).not.toContain("Default agent");
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("never prompts with --yes even on a TTY", async () => {
    const env = makeEnv();
    const promptText = vi.fn(async () => "unused");
    const promptChoice = vi.fn(async () => "unused");
    const cap = await runInit(env, { "--yes": true }, { isTTY: true, promptText, promptChoice });

    expect(promptText).not.toHaveBeenCalled();
    expect(promptChoice).not.toHaveBeenCalled();
    expect(cap.output).toContain("--yes defaults");
    expect(cap.output).not.toContain("Default agent");
  });

  it("always forwards --force to huginn setup", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true, "--force": true });

    expect(cap.setupCalls[0]["--force"]).toBe(true);
  });

  it("forwards env.PATH to the agent detector and labels a pathless install", async () => {
    const env = makeEnv();
    const detector = vi.fn(async () => [
      { id: "opencode" as const, available: true },
      { id: "claude" as const, available: false },
    ]);
    const cap = await runInit(env, { "--yes": true }, {
      env: { PATH: "/custom/bin" },
      detectAgents: detector,
    });

    expect(detector).toHaveBeenCalledTimes(1);
    expect(detector.mock.calls[0][0]).toBe("/custom/bin");
    expect(cap.output).toContain("opencode");
    expect(cap.output).toContain("on PATH");
    expect(cap.output).toContain("not installed");
    expect(cap.report?.agent).toBe("opencode");
    expect(readConfig(env).agent).toBe("opencode");
  });

  it("falls back to an empty PATH when neither env nor process.env provide one", async () => {
    const env = makeEnv();
    const previousPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const detector = vi.fn(async () => []);
      await runInit(env, { "--yes": true }, { detectAgents: detector });

      expect(detector).toHaveBeenCalledTimes(1);
      expect(detector.mock.calls[0][0]).toBe("");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("skips setup with --skip-setup but still writes the config", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true, "--skip-setup": true });

    expect(cap.setupCalls).toHaveLength(0);
    expect(cap.report?.setupRan).toBe(false);
    expect(cap.output).toContain("--skip-setup");
    expect(existsSync(getProjectConfigPath(env.project))).toBe(true);
    expect(readConfig(env).agent).toBe(FIRST_AVAILABLE);
  });

  it("is idempotent and preserves unknown config keys", async () => {
    const env = makeEnv();
    await runInit(env, { "--yes": true });
    writeFileEnsured(
      getProjectConfigPath(env.project),
      `${JSON.stringify({ mode: "supervised", customKey: 42 }, null, 2)}\n`,
    );

    await runInit(env, { "--yes": true });

    const merged = readConfig(env);
    expect(merged.mode).toBe("supervised");
    expect(merged.customKey).toBe(42);
    expect(merged.agent).toBe(FIRST_AVAILABLE);
    expect(merged.executor).toBe(DEFAULT_EXECUTOR_MODEL);
  });
});

describe("huginn init wizard — interactive", () => {
  it("prompts for agent and models and persists the answers", async () => {
    const env = makeEnv();
    const choices: string[][] = [];
    const answers = ["vendor/think", "vendor/exec"];
    let index = 0;
    const cap = await runInit(env, {}, {
      isTTY: true,
      promptChoice: async (_question, list, fallback) => {
        choices.push(list);
        return "codex";
      },
      promptText: async (_question, fallback) => answers[index++] ?? fallback,
    });

    expect(cap.output).not.toContain("non-interactive");
    expect(choices).toHaveLength(1);
    expect(choices[0]).toContain(FIRST_AVAILABLE);
    expect(choices[0]).toContain("opencode");
    expect(readConfig(env)).toEqual({
      agent: "codex",
      thinker: "vendor/think",
      executor: "vendor/exec",
    });
    expect(cap.setupCalls[0]["--agent"]).toBe("codex");
  });

  it("ignores an invalid prompted agent/model and keeps the safe default", async () => {
    const env = makeEnv();
    await runInit(env, {}, {
      isTTY: true,
      promptChoice: async () => "not-a-real-agent",
      promptText: async () => "   ",
    });

    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("keeps an existing config when the overwrite prompt is declined", async () => {
    const env = makeEnv();
    writeFileEnsured(
      getProjectConfigPath(env.project),
      `${JSON.stringify({ thinker: "keep/me" }, null, 2)}\n`,
    );
    const cap = await runInit(env, {}, {
      isTTY: true,
      confirm: async () => false,
      promptChoice: async (_question, _choices, fallback) => fallback,
      promptText: async (_question, fallback) => fallback,
    });

    expect(cap.report?.configWritten).toBe(false);
    expect(cap.output).toContain("keeping the existing");
    expect(readConfig(env).thinker).toBe("keep/me");
  });

  it("overwrites an existing config without prompting when --force is set", async () => {
    const env = makeEnv();
    writeFileEnsured(getProjectConfigPath(env.project), `${JSON.stringify({ thinker: "old/m" })}\n`);
    const confirm = vi.fn(async () => false);
    const cap = await runInit(env, { "--force": true }, {
      isTTY: true,
      confirm,
      promptChoice: async (_question, _choices, fallback) => fallback,
      promptText: async (_question, fallback) => fallback,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(cap.report?.configWritten).toBe(true);
    expect(readConfig(env).thinker).toBe(DEFAULT_THINKER_MODEL);
  });

  it("overwrites an existing config when the overwrite prompt is accepted", async () => {
    const env = makeEnv();
    const configPath = getProjectConfigPath(env.project);
    writeFileEnsured(
      configPath,
      `${JSON.stringify({ thinker: "old/model", customKey: 7 }, null, 2)}\n`,
    );
    const confirm = vi.fn(async () => true);
    const cap = await runInit(env, {}, {
      isTTY: true,
      confirm,
      promptChoice: async (_question, _choices, fallback) => fallback,
      promptText: async (_question, fallback) => fallback,
    });

    // asked exactly once, defaulting to "overwrite", and the write is announced
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining(`${configPath} already exists`),
      true,
    );
    expect(cap.report?.configWritten).toBe(true);
    expect(cap.output).toContain("(updated)");
    expect(cap.output).not.toContain("keeping the existing");
    expect(cap.output).toContain("init complete");

    const config = readConfig(env);
    expect(config.thinker).toBe(DEFAULT_THINKER_MODEL);
    expect(config.agent).toBe(FIRST_AVAILABLE);
    expect(config.customKey).toBe(7);
  });

  it("offers every AGENT_TARGETS entry when no agent CLI is installed", async () => {
    const env = makeEnv();
    const choices: string[][] = [];
    const cap = await runInit(env, {}, {
      isTTY: true,
      detectAgents: async () => [],
      promptChoice: async (_question, list, fallback) => {
        choices.push(list);
        return fallback;
      },
      promptText: async (_question, fallback) => fallback,
    });

    expect(choices).toHaveLength(1);
    expect(choices[0]).toEqual([...AGENT_TARGETS]);
    expect(cap.output).toContain("3. Agent CLIs");
    expect(cap.report?.agent).toBe(DEFAULT_AGENT);
    expect(readConfig(env).agent).toBe(DEFAULT_AGENT);
  });

  it("keeps the choice list duplicate-free when the agent is already detected", async () => {
    const env = makeEnv();
    const choices: string[][] = [];
    const cap = await runInit(env, { "--agent": "claude" }, {
      isTTY: true,
      promptChoice: async (_question, list, fallback) => {
        choices.push(list);
        return fallback;
      },
      promptText: async (_question, fallback) => fallback,
    });

    // DETECTED has claude + opencode available and the list is primary-first, so
    // the pre-selected agent is not appended a second time
    expect(choices[0]).toEqual(["opencode", "claude"]);
    expect(cap.report?.agent).toBe("claude");
  });

  it("appends a pre-selected agent that was not detected to the choice list", async () => {
    const env = makeEnv();
    const choices: string[][] = [];
    const cap = await runInit(env, { "--agent": "codex" }, {
      isTTY: true,
      detectAgents: async () =>
        DETECTED.map((d) => ({ ...d, available: d.id === "claude", path: undefined })),
      promptChoice: async (_question, list, fallback) => {
        choices.push(list);
        return fallback;
      },
      promptText: async (_question, fallback) => fallback,
    });

    expect(choices[0]).toEqual(["claude", "codex"]);
    expect(cap.report?.agent).toBe("codex");
  });

  it("defaults the overwrite prompt to yes when stdio is not a TTY", async () => {
    const env = makeEnv();
    writeFileEnsured(
      getProjectConfigPath(env.project),
      `${JSON.stringify({ thinker: "old/model" })}\n`,
    );
    // no injected `confirm`: the real promptYesNo runs and must not block
    const cap = await runInitPiped(env);

    expect(cap.report?.configWritten).toBe(true);
    expect(cap.output).toContain("(updated)");
    expect(readConfig(env).thinker).toBe(DEFAULT_THINKER_MODEL);
  });
});

describe("huginn init prompt implementations (real readline)", () => {
  /** No agent CLI installed, so the fallback choice list is AGENT_TARGETS. */
  const noAgents: InitDeps = { detectAgents: async () => [] };

  it("selects the agent by number and keeps the typed models", async () => {
    const env = makeEnv();
    const cap = await runInitTty(env, ["2", "vendor/thinker", "vendor/executor"], {}, noAgents);

    // the numbered list is printed by the real promptChoiceDefault
    expect(cap.output).toContain("Default agent");
    expect(cap.output).toContain(`   1) ${AGENT_TARGETS[0]}`);
    expect(cap.output).toContain(`   2) ${AGENT_TARGETS[1]}`);
    expect(cap.output).not.toContain("non-interactive");
    expect(cap.report?.agent).toBe(AGENT_TARGETS[1]);
    expect(cap.stdin.remaining()).toBe(0);
    expect(readConfig(env)).toEqual({
      agent: AGENT_TARGETS[1],
      thinker: "vendor/thinker",
      executor: "vendor/executor",
    });
    expect(cap.setupCalls[0]["--agent"]).toBe(AGENT_TARGETS[1]);
  });

  it("accepts a choice typed by name", async () => {
    const env = makeEnv();
    const cap = await runInitTty(env, ["codex", "vendor/thinker", "vendor/executor"], {}, noAgents);

    expect(cap.report?.agent).toBe("codex");
    expect(readConfig(env).agent).toBe("codex");
  });

  it("falls back for an out-of-range number and blank model answers", async () => {
    const env = makeEnv();
    const cap = await runInitTty(env, ["99", "   ", ""], {}, noAgents);

    expect(cap.report?.agent).toBe(DEFAULT_AGENT);
    expect(readConfig(env)).toEqual({
      agent: DEFAULT_AGENT,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("early-returns to the fallback when stdio is not a TTY", async () => {
    const env = makeEnv();
    const cap = await runInitPiped(env, {}, noAgents);

    // promptChoiceDefault still printed its numbered list...
    expect(cap.output).toContain("Default agent");
    expect(cap.output).toContain(`   1) ${AGENT_TARGETS[0]}`);
    // ...but askLine resolved every answer to the documented fallback
    expect(cap.report?.agent).toBe(DEFAULT_AGENT);
    expect(readConfig(env)).toEqual({
      agent: DEFAULT_AGENT,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("early-returns to the fallback when CI is set, even on a TTY", async () => {
    const env = makeEnv();
    // the injected env is the same seam the prompts read, so no process.env
    // mutation is needed for the wizard to see CI
    const cap = await runInitTty(env, ["2", "vendor/thinker", "vendor/executor"], {}, {
      ...noAgents,
      env: { CI: "1" },
    });

    // the scripted answers are never read: env.CI wins over the TTY probe
    expect(cap.stdin.remaining()).toBe(3);
    expect(cap.report?.agent).toBe(DEFAULT_AGENT);
    expect(readConfig(env).agent).toBe(DEFAULT_AGENT);
  });
});

describe("huginn init wizard — Phase 5 model picker", () => {
  const MODELS: ModelInfo[] = [
    { id: "acme/alpha", name: "Alpha", provider: "acme", description: "fast and cheap" },
    { id: "acme/beta", name: "Beta", provider: "acme" },
  ];

  it("offers a numbered picker built from the runtime catalog and persists the picks", async () => {
    const env = makeEnv();
    const modelPrompts: { question: string; choices: string[]; fallback: string }[] = [];
    const cap = await runInit(env, {}, {
      isTTY: true,
      getRuntime: () => catalogRuntime(MODELS),
      promptChoice: async (question, list, fallback) => {
        if (question.includes("Default agent")) return fallback;
        modelPrompts.push({ question, choices: list, fallback });
        // thinker → second model; executor → first model
        return question.includes("Thinker") ? list[1] : list[0];
      },
      promptText: async (_question, fallback) => fallback,
    });

    // one picker prompt per role, over the runtime's own catalog
    expect(modelPrompts).toHaveLength(2);
    expect(modelPrompts[0].question).toContain("Thinker model");
    expect(modelPrompts[1].question).toContain("Executor model");
    // the description is shown next to the id; with no flags the seeds mirror the
    // TUI's catalog seeding — thinker → FIRST model, executor → SECOND — so the
    // two pickers do not collide on the same model (REV-505)
    expect(modelPrompts[0].choices).toEqual(["acme/alpha — fast and cheap", "acme/beta"]);
    expect(modelPrompts[0].fallback).toBe("acme/alpha — fast and cheap");
    expect(modelPrompts[1].fallback).toBe("acme/beta");
    expect(cap.output).toContain("2 models available from");
    // the picked ids (not the display labels) are persisted
    expect(cap.report?.thinker).toBe("acme/beta");
    expect(cap.report?.executor).toBe("acme/alpha");
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: "acme/beta",
      executor: "acme/alpha",
    });
  });

  it("pre-selects the current value when the catalog contains it", async () => {
    const env = makeEnv();
    const fallbacks: string[] = [];
    const cap = await runInit(env, { "--thinker": "acme/beta", "--executor": "acme/alpha" }, {
      isTTY: true,
      getRuntime: () => catalogRuntime(MODELS),
      promptChoice: async (question, _list, fallback) => {
        if (question.includes("Default agent")) return fallback;
        fallbacks.push(fallback);
        return fallback; // accept the pre-selected default as-is
      },
      promptText: async (_question, fallback) => fallback,
    });

    // the pre-selected defaults are the current values (labels, with the
    // description suffix when the catalog carries one)
    expect(fallbacks).toEqual(["acme/beta", "acme/alpha — fast and cheap"]);
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: "acme/beta",
      executor: "acme/alpha",
    });
    expect(cap.report?.configWritten).toBe(true);
  });

  it("falls back to plain text and surfaces the reason when the catalog is empty", async () => {
    const env = makeEnv();
    const cap = await runInit(env, {}, {
      isTTY: true,
      getRuntime: () => catalogRuntime([], "no model-listing command for this runtime"),
      promptChoice: async (_question, _list, fallback) => fallback,
      promptText: async (_question, fallback) =>
        fallback === DEFAULT_THINKER_MODEL ? "typed/thinker" : "typed/executor",
    });

    expect(cap.output).toContain("no model catalog for");
    expect(cap.output).toContain("no model-listing command for this runtime");
    expect(cap.output).not.toContain("models available from");
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: "typed/thinker",
      executor: "typed/executor",
    });
  });

  it("sanitizes the discovery reason before printing it", async () => {
    const env = makeEnv();
    // \u0007 (BEL) is not an ANSI sequence, so `stripAnsi` cannot hide it: only
    // the wizard's own sanitizer can remove it.
    const cap = await runInit(env, {}, {
      isTTY: true,
      getRuntime: () => catalogRuntime([], "boom\u0007tail"),
      promptChoice: async (_question, _list, fallback) => fallback,
      promptText: async (_question, fallback) => fallback,
    });

    expect(cap.output).toContain("boomtail");
    expect(cap.output).not.toContain("boom\u0007tail");
  });

  it("degrades to plain text when model discovery throws", async () => {
    const env = makeEnv();
    const cap = await runInit(env, {}, {
      isTTY: true,
      getRuntime: () => {
        throw new Error("runtime exploded");
      },
      promptChoice: async (_question, _list, fallback) => fallback,
      promptText: async (_question, fallback) => fallback,
    });

    expect(cap.output).toContain("runtime exploded");
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("uses the base getAvailableModels() accessor when the runtime omits the richer catalog (REV-503)", async () => {
    const env = makeEnv();
    const modelPrompts: string[][] = [];
    const cap = await runInit(env, {}, {
      isTTY: true,
      getRuntime: () => legacyCatalogRuntime(MODELS),
      promptChoice: async (question, list, fallback) => {
        if (question.includes("Default agent")) return fallback;
        modelPrompts.push(list);
        return fallback;
      },
      promptText: async (_question, fallback) => fallback,
    });

    // the plain accessor still drives the numbered picker (no dead end), and the
    // empty-catalog copy is never shown
    expect(modelPrompts).toHaveLength(2);
    expect(modelPrompts[0]).toContain("acme/alpha — fast and cheap");
    expect(cap.output).toContain("2 models available from");
    expect(cap.output).not.toContain("no model catalog for");
    expect(readConfig(env).agent).toBe(FIRST_AVAILABLE);
  });

  it("degrades to plain text with the sanitized reason when getModelCatalog rejects (REV-508)", async () => {
    const env = makeEnv();
    const cap = await runInit(env, {}, {
      isTTY: true,
      getRuntime: () => ({
        ...emptyCatalogRuntime(),
        getModelCatalog: async () => {
          // an *async* rejection must be absorbed too, not just a sync throw
          throw new Error("catalog boom\u0007tail");
        },
      }),
      promptChoice: async (_question, _list, fallback) => fallback,
      promptText: async (_question, fallback) => fallback,
    });

    expect(cap.output).toContain("no model catalog for");
    // the reason is sanitized at the discovery boundary (BEL stripped)
    expect(cap.output).toContain("catalog boomtail");
    expect(cap.output).not.toContain("boom\u0007tail");
    expect(cap.output).not.toContain("models available from");
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("keeps an out-of-catalog --thinker/--executor flag when Enter is pressed (REV-501)", async () => {
    const env = makeEnv();
    const fallbacks: string[] = [];
    const cap = await runInit(env, { "--thinker": "vendor/think", "--executor": "vendor/exec" }, {
      isTTY: true,
      getRuntime: () => catalogRuntime(MODELS),
      promptChoice: async (question, _list, fallback) => {
        if (question.includes("Default agent")) return fallback;
        fallbacks.push(fallback);
        // pressing Enter accepts the preselected value verbatim
        return fallback;
      },
      promptText: async (_question, fallback) => fallback,
    });

    // neither flag is in the catalog, yet both survive as the preselection
    // instead of being silently replaced by the first discovered model
    expect(fallbacks).toEqual(["vendor/think", "vendor/exec"]);
    expect(cap.report?.thinker).toBe("vendor/think");
    expect(cap.report?.executor).toBe("vendor/exec");
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: "vendor/think",
      executor: "vendor/exec",
    });
  });

  it("retains an out-of-catalog flag through the real readline picker (REV-501)", async () => {
    const env = makeEnv();
    // answers: agent number, then blank lines → Enter keeps each flag
    const cap = await runInitTty(env, ["1", "", ""], {
      "--thinker": "vendor/think",
      "--executor": "vendor/exec",
    }, {
      detectAgents: async () => [],
      getRuntime: () => catalogRuntime(MODELS),
    });

    expect(cap.output).toContain("Thinker model");
    expect(cap.stdin.remaining()).toBe(0);
    expect(readConfig(env)).toEqual({
      agent: AGENT_TARGETS[0],
      thinker: "vendor/think",
      executor: "vendor/exec",
    });
  });

  it("never builds a runtime nor prompts with --yes, even on a TTY", async () => {
    const env = makeEnv();
    const getRuntime = vi.fn(() => catalogRuntime(MODELS));
    const promptChoice = vi.fn(async () => "unused");
    const promptText = vi.fn(async () => "unused");
    const cap = await runInit(env, { "--yes": true }, {
      isTTY: true,
      getRuntime,
      promptChoice,
      promptText,
    });

    expect(getRuntime).not.toHaveBeenCalled();
    expect(promptChoice).not.toHaveBeenCalled();
    expect(promptText).not.toHaveBeenCalled();
    expect(cap.output).toContain("--yes defaults");
    expect(cap.output).not.toContain("models available from");
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("renders the real numbered model picker (readline) and picks by number", async () => {
    const env = makeEnv();
    // answers: agent number, thinker number, executor number
    const cap = await runInitTty(env, ["1", "2", "1"], {}, {
      detectAgents: async () => [],
      getRuntime: () => catalogRuntime(MODELS),
    });

    expect(cap.output).toContain("Default agent");
    expect(cap.output).toContain("Thinker model");
    expect(cap.output).toContain("Executor model");
    // the numbered list is printed by the real promptChoiceDefault, with the
    // description appended to the id
    expect(cap.output).toContain("   1) acme/alpha — fast and cheap");
    expect(cap.output).toContain("   2) acme/beta");
    expect(cap.stdin.remaining()).toBe(0);
    expect(readConfig(env)).toEqual({
      agent: AGENT_TARGETS[0],
      thinker: "acme/beta",
      executor: "acme/alpha",
    });
  });

  it("never builds a runtime on the non-interactive (no TTY / CI) path (REV-504)", async () => {
    const env = makeEnv();
    // no TTY at all — the wizard never enters the prompt branch
    const noTty = vi.fn(() => catalogRuntime(MODELS));
    const piped = await runInit(env, {}, { getRuntime: noTty });
    expect(noTty).not.toHaveBeenCalled();
    expect(piped.output).toContain("non-interactive");

    // a TTY with CI set: `canPrompt` is false too, so the runtime is still never built
    const ci = vi.fn(() => catalogRuntime(MODELS));
    await runInit(env, {}, { isTTY: true, env: { CI: "1" }, getRuntime: ci });
    expect(ci).not.toHaveBeenCalled();
  });
});

describe("huginn init — setup delegation", () => {
  it("omits --opencode-config-dir from the setup args when the flag is absent", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true, "--opencode-config-dir": undefined });

    expect(cap.setupCalls).toHaveLength(1);
    const args = cap.setupCalls[0];
    expect("--opencode-config-dir" in args).toBe(false);
    expect("--force" in args).toBe(false);
    expect(args["--agent"]).toBe(FIRST_AVAILABLE);
    expect(args["--project"]).toBe(env.project);
    expect(args["--home"]).toBe(env.home);
  });

  it("reports the completion line as registered when the delegation succeeds", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const cap = await runInit(env, { "--yes": true });

      expect(cap.setupCalls).toHaveLength(1);
      expect(cap.report?.setupRan).toBe(true);
      expect(cap.errors).toBe("");
      expect(cap.output).toContain("muninn    registered");
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previous;
    }
  });

  it("warns and exits non-zero when the delegation returns no report (REV-201)", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const cap = await runInit(env, { "--yes": true }, { runSetup: async () => SETUP_FAILED });

      expect(cap.report?.setupRan).toBe(false);
      expect(cap.output).toContain("muninn    not registered");
      expect(cap.output).not.toContain("muninn    registered");
      expect(cap.errors).toContain("Muninn MCP registration did not complete");
      expect(cap.errors).toContain("huginn setup --agent");
      expect(process.exitCode).toBe(1);
      // the project config is still written so the repository stays usable
      expect(cap.report?.configWritten).toBe(true);
      expect(readConfig(env).agent).toBe(FIRST_AVAILABLE);
    } finally {
      process.exitCode = previous;
    }
  });

  it("treats a delegation that resolved but left exitCode 1 as a failure (REV-201)", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const cap = await runInit(env, { "--yes": true }, {
        runSetup: async () => {
          // how `handleSetupCommand` signals an error it swallowed internally
          process.exitCode = 1;
          return SETUP_OK;
        },
      });

      expect(cap.report?.setupRan).toBe(false);
      expect(cap.errors).toContain("Muninn MCP registration did not complete");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  });

  it("surfaces a real `huginn setup` failure (blocked home) as a warning + exit code", async () => {
    const env = makeEnv();
    // A *file* named `.huginn` makes the portable write fail: exactly the kind of
    // internal error `handleSetupCommand` used to swallow silently while the
    // wizard still printed "registered".
    const blockedHome = join(env.root, "blocked-home");
    mkdirSync(blockedHome, { recursive: true });
    writeFileEnsured(join(blockedHome, ".huginn"), "not a directory\n");
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      // `runSetup: undefined` keeps the real handler, so nothing is faked here
      const cap = await runInit(
        env,
        { "--yes": true, "--home": blockedHome },
        { runSetup: undefined },
      );

      expect(cap.setupCalls).toHaveLength(0);
      expect(cap.report?.setupRan).toBe(false);
      expect(cap.output).toContain("muninn    not registered");
      expect(cap.errors).toContain("setup failed");
      expect(cap.errors).toContain("Muninn MCP registration did not complete");
      expect(process.exitCode).toBe(1);
      // the config write is independent of the MCP registration
      expect(cap.report?.configWritten).toBe(true);
      expect(readConfig(env).agent).toBe(FIRST_AVAILABLE);
    } finally {
      process.exitCode = previous;
    }
  });
});

describe("huginn init path defaults", () => {
  it("resolves a relative --project/--home/--opencode-config-dir against the cwd", async () => {
    const env = makeEnv();
    const relative = join("some", "relative", "project");
    const cap = await runInit(env, {
      "--project": relative,
      "--home": relative,
      "--opencode-config-dir": relative,
      "--help": true,
    });

    expect(cap.report?.projectPath).toBe(resolve(relative));
    expect(cap.report?.homeDir).toBe(resolve(relative));
    // --help short-circuits before any write (the wizard's documented contract)
    expect(cap.output).toContain("huginn init — guided onboarding");
    expect(cap.report?.configWritten).toBe(false);
  });

  it("prefers --project/--home over the injected deps paths", async () => {
    const env = makeEnv();
    const cap = await runInit(
      env,
      { "--project": env.project, "--home": env.home, "--help": true },
      {
        projectPath: join(env.root, "other-project"),
        homeDir: join(env.root, "other-home"),
      },
    );

    expect(cap.report?.projectPath).toBe(env.project);
    expect(cap.report?.homeDir).toBe(env.home);
    expect(cap.report?.configPath).toBe(getProjectConfigPath(env.project));
  });

  it("falls back to deps.projectPath/deps.homeDir when the flags are absent", async () => {
    const env = makeEnv();
    const cap = await runInit(
      env,
      {
        "--project": undefined,
        "--home": undefined,
        "--opencode-config-dir": undefined,
        "--yes": true,
      },
      { projectPath: env.project, homeDir: env.home },
    );

    expect(cap.report?.projectPath).toBe(env.project);
    expect(cap.report?.homeDir).toBe(env.home);
    expect(cap.report?.configPath).toBe(getProjectConfigPath(env.project));
    expect(cap.report?.configWritten).toBe(true);
    expect(existsSync(getProjectConfigPath(env.project))).toBe(true);
    // the fallbacks also flow into the setup delegation
    expect(cap.setupCalls[0]["--project"]).toBe(env.project);
    expect(cap.setupCalls[0]["--home"]).toBe(env.home);
  });

  it("falls back to process.cwd()/homedir() when nothing is provided", async () => {
    const env = makeEnv();
    const cap = await runInit(env, {
      "--project": undefined,
      "--home": undefined,
      "--opencode-config-dir": undefined,
      "--help": true,
    });

    expect(cap.report?.projectPath).toBe(process.cwd());
    expect(cap.report?.configPath).toBe(getProjectConfigPath(process.cwd()));
    expect(cap.report?.homeDir).toBe(homedir());
    // the real cwd/home are only read, never written
    expect(cap.report?.configWritten).toBe(false);
    expect(cap.setupCalls).toHaveLength(0);
  });
});

describe("huginn init — flag parsing edges", () => {
  it("treats a blank --agent as absent instead of an error", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const cap = await runInit(env, { "--yes": true, "--agent": "  " });

      expect(cap.errors).toBe("");
      expect(process.exitCode).toBe(0);
      expect(cap.report?.agent).toBe(FIRST_AVAILABLE);
      expect(cap.setupCalls[0]["--agent"]).toBe(FIRST_AVAILABLE);
    } finally {
      process.exitCode = previous;
    }
  });

  it("case-folds and trims a known --agent", async () => {
    const upper = makeEnv();
    const first = await runInit(upper, { "--yes": true, "--agent": "CODEX" });
    expect(first.errors).toBe("");
    expect(first.report?.agent).toBe("codex");
    expect(readConfig(upper).agent).toBe("codex");
    expect(first.setupCalls[0]["--agent"]).toBe("codex");

    const padded = makeEnv();
    const second = await runInit(padded, { "--yes": true, "--agent": "  Codex  " });
    expect(second.errors).toBe("");
    expect(second.report?.agent).toBe("codex");
    expect(readConfig(padded).agent).toBe("codex");
  });

  it("falls back to the default models for empty --thinker/--executor values", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true, "--thinker": "", "--executor": "" });

    expect(cap.report?.thinker).toBe(DEFAULT_THINKER_MODEL);
    expect(cap.report?.executor).toBe(DEFAULT_EXECUTOR_MODEL);
    expect(readConfig(env)).toEqual({
      agent: FIRST_AVAILABLE,
      thinker: DEFAULT_THINKER_MODEL,
      executor: DEFAULT_EXECUTOR_MODEL,
    });
  });

  it("falls back to the default models for whitespace-only model values", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true, "--thinker": "   ", "--executor": "\t" });

    expect(cap.report?.thinker).toBe(DEFAULT_THINKER_MODEL);
    expect(cap.report?.executor).toBe(DEFAULT_EXECUTOR_MODEL);
  });
});

describe("huginn init — git detection and safety", () => {
  it("reports a git repository when the project is inside one (QA #19)", async () => {
    const env = makeEnv();
    // the same check the wizard uses: an empty `.git` directory is NOT a repo
    expect(git(env.project, ["init", "-b", "main"]).code).toBe(0);
    const cap = await runInit(env, { "--yes": true });

    expect(cap.output).toContain("git repository detected");
    expect(cap.output).not.toContain("no .git directory here");
  });

  it("reports a repository for a subdirectory of one, not just for a `.git` sibling", async () => {
    const env = makeEnv();
    expect(git(env.project, ["init", "-b", "main"]).code).toBe(0);
    const nested = join(env.project, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const cap = await runInit(env, { "--yes": true, "--project": nested });

    expect(cap.output).toContain("git repository detected");
    expect(cap.output).not.toContain("no .git directory here");
  });

  it("guides the developer when the project is outside any work tree without failing", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--yes": true });

    expect(cap.output).toContain("no .git directory here");
    expect(cap.output).toContain("git init");
    // informational only: the run still completes and writes the config
    expect(readConfig(env).agent).toBe(FIRST_AVAILABLE);
  });

  it("rejects an unknown --agent with exit code 1 and no side effects", async () => {
    const env = makeEnv();
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const cap = await runInit(env, { "--yes": true, "--agent": "nope" });
      expect(process.exitCode).toBe(1);
      expect(cap.errors).toContain("Unknown agent");
      expect(cap.setupCalls).toHaveLength(0);
      expect(existsSync(getProjectConfigPath(env.project))).toBe(false);
    } finally {
      process.exitCode = previous;
    }
  });

  it("surfaces a failed config write as an error and exit code 1 (REV-207)", async () => {
    const env = makeEnv();
    // `.huginn` as a *file* makes the atomic config write fail
    writeFileEnsured(join(env.project, ".huginn"), "not a directory\n");
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      const cap = await runInit(env, { "--yes": true });

      expect(cap.report?.configWritten).toBe(false);
      expect(cap.errors).toContain("could not write");
      expect(cap.output).toContain("init complete");
      expect(cap.output).toContain("unchanged");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  });

  it("prints its own usage for --help and writes nothing", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "--help": true });

    expect(cap.output).toContain("huginn init — guided onboarding");
    expect(cap.output).toContain("Usage:");
    expect(cap.output).toContain("--skip-setup");
    expect(cap.report?.configWritten).toBe(false);
    expect(cap.setupCalls).toHaveLength(0);
    expect(existsSync(join(env.project, ".huginn"))).toBe(false);
  });

  it("exposes printInitUsage", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printInitUsage();
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("huginn init routing & help hierarchy (AC-26.2)", () => {
  it("keeps usage() as the full-reference contract", () => {
    const full = usage();
    // required by test/muninn/commands.test.ts:88 — must not change
    expect(full).toContain("huginn memory init [--db <path>] [--project <path>]");
    expect(full).toContain("huginn mcp run [--db <path>] [--project <path>]");
    // the full reference inventories *every* subcommand, Core and advanced
    for (const command of [
      "live",
      "run",
      "init",
      "setup",
      "doctor",
      "plan",
      "install",
      "memory",
      "mcp",
      "check",
      "config",
    ]) {
      expect(full).toContain(`\n  ${command} `);
    }
    expect(full.length).toBeGreaterThan(usageCore().length);
  });

  it("groups the concise help around the core commands", () => {
    const core = usageCore();
    for (const command of ["live", "run", "init", "setup", "doctor"]) {
      expect(core).toContain(command);
    }
    expect(core).toContain("Core commands");
    expect(core).toContain("huginn --help --all");
    expect(core).not.toContain("huginn memory init [--db <path>]");
    expect(core).not.toContain("huginn config set");
  });

  it("cannot drift: every Core command token also exists in the full reference", () => {
    const core = usageCore();
    const section = core.slice(core.indexOf("Core commands:")).split("\n").slice(1);
    const coreCommands: string[] = [];
    for (const line of section) {
      // the block is `  <command>  <description>` lines terminated by a blank line
      if (line.trim().length === 0 || !line.startsWith("  ")) break;
      coreCommands.push(line.trim().split(/\s+/)[0]);
    }
    expect(coreCommands).toEqual(["live", "run", "init", "setup", "doctor"]);
    for (const command of coreCommands) {
      expect(usage()).toContain(`\n  ${command} `);
    }
  });

  it("prints the concise view for --help and the full reference for --all", async () => {
    const concise = await captureMain(["--help"]);
    expect(concise).toContain("Core commands");
    expect(concise).toContain("huginn --help --all");
    expect(concise).not.toContain("huginn memory init [--db <path>]");

    const full = await captureMain(["--help", "--all"]);
    expect(full).toContain("huginn memory init [--db <path>] [--project <path>]");

    const viaHelp = await captureMain(["help", "--all"]);
    expect(viaHelp).toContain("huginn memory init [--db <path>] [--project <path>]");

    const shortFlag = await captureMain(["-h"]);
    expect(shortFlag).toContain("Core commands");
  });

  it("prints the init wizard usage for `huginn init --help`", async () => {
    const output = await captureMain(["init", "--help"]);
    expect(output).toContain("huginn init — guided onboarding");
  });

  it("prints the concise view for the bare `help` command", async () => {
    const concise = await captureMain(["help"]);

    expect(concise).toContain("Core commands");
    expect(concise).toContain("huginn --help --all");
    expect(concise).not.toContain("huginn memory init [--db <path>]");
  });

  it("prints the init usage and writes nothing for `huginn init -h`", async () => {
    const env = makeEnv();
    const cap = await runInit(env, { "-h": true });

    expect(cap.output).toContain("huginn init — guided onboarding");
    expect(cap.output).toContain("Usage:");
    expect(cap.report?.configWritten).toBe(false);
    expect(cap.setupCalls).toHaveLength(0);
    expect(existsSync(join(env.project, ".huginn"))).toBe(false);
  });

  it("dispatches a plain `huginn init` from main() into the wizard", async () => {
    // `huginn init` is fully callable in-process: main() reaches the wizard
    // synchronously and `init` never imports the TUI/headless modules, so this
    // exercises the real dispatch branch (not just the routing predicate).
    const env = makeEnv();
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "));
    });
    try {
      await main([
        "init",
        "--project",
        env.project,
        "--home",
        env.home,
        "--opencode-config-dir",
        env.opencodeConfigDir,
        "--yes",
      ]);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const output = stripAnsi(lines.join("\n"));
    expect(output).toContain("[huginn] init — onboarding for");
    expect(output).toContain("init complete");
    expect(process.exitCode ?? 0).toBe(0);

    // the wizard wrote the pinned temp project config...
    expect(existsSync(getProjectConfigPath(env.project))).toBe(true);
    const config = readConfig(env);
    expect(AGENT_TARGETS).toContain(config.agent);
    expect(config.thinker).toBe(DEFAULT_THINKER_MODEL);
    expect(config.executor).toBe(DEFAULT_EXECUTOR_MODEL);
    // ...and delegated to the real `huginn setup` under the temp home/opencode dir
    expect(existsSync(join(env.home, ".huginn", "mcp.json"))).toBe(true);
  });

  it("recognizes init as a known command and a boolean --skip-setup", () => {
    expect(parseArgs(["init"])._command).toBe("init");
    expect(parseArgs(["init", "--yes"])._command).toBe("init");
    expect(parseArgs(["init", "--skip-setup"])["--skip-setup"]).toBe(true);
    expect(parseArgs(["init", "--all"])["--all"]).toBe(true);
    // an explicitly empty value is kept as the empty string (never mistaken for
    // a boolean flag), so `init` falls back to its defaults
    expect(parseArgs(["init", "--thinker", ""])["--thinker"]).toBe("");
    expect(parseArgs(["init", "--executor", ""])["--executor"]).toBe("");
  });
});

describe("huginn install — compatibility no-op", () => {
  it("prints the built-in notice, exits 0 and never enters the run/plan/live path", async () => {
    // `install` is a known command, so it must be handled before the live-first
    // default. A *greenfield* temp project is used on purpose: if the branch ever
    // regressed, the run/plan/live path would either git-init this directory or
    // `process.exit(1)` on the missing plan/spec/adr — so an untouched project,
    // empty stderr and exit 0 all prove the work checks never ran (REQ-26/AC-26).
    const env = makeEnv();
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map((part) => String(part)).join(" "));
    });
    try {
      const output = await captureMain(["install", "--project", env.project]);

      // the no-op prints exactly the notice and nothing else (no banner, no logs)
      expect(output).toBe(
        "[huginn] agents and step prompts are built in; there is nothing to install.",
      );
      expect(stripAnsi(errors.join("\n"))).toBe("");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }

    // no git repository, no harness state, no documents: run/plan/live was skipped
    expect(existsSync(join(env.project, ".git"))).toBe(false);
    expect(existsSync(join(env.project, ".huginn"))).toBe(false);
    expect(existsSync(join(env.project, "plan.md"))).toBe(false);
  });
});

describe("greenfield launch ergonomics", () => {
  it("treats a project without .huginn/ as never initialized", () => {
    const env = makeEnv();
    expect(isGreenfieldLaunch(env.project)).toBe(true);
    mkdirSync(join(env.project, ".huginn"));
    expect(isGreenfieldLaunch(env.project)).toBe(false);
  });

  it("only replaces the live-first default for a bare command on a greenfield project", () => {
    const env = makeEnv();
    expect(shouldLaunchInit(parseArgs([]), env.project)).toBe(true);
    // benign flags (target paths, --yes) do not request work: still a bare launch
    expect(shouldLaunchInit(parseArgs(["--project", env.project]), env.project)).toBe(true);
    expect(shouldLaunchInit(parseArgs(["--yes"]), env.project)).toBe(true);
    // work/mode flags keep normal routing
    expect(shouldLaunchInit(parseArgs(["--headless"]), env.project)).toBe(false);
    expect(shouldLaunchInit(parseArgs(["--resume"]), env.project)).toBe(false);
    expect(shouldLaunchInit(parseArgs(["--choose-model"]), env.project)).toBe(false);
    expect(shouldLaunchInit(parseArgs(["--thinker", "vendor/think"]), env.project)).toBe(false);
    // an explicit idea keeps live-first behavior
    expect(shouldLaunchInit(parseArgs(["add a payments module"]), env.project)).toBe(false);
    // known subcommands route explicitly
    expect(shouldLaunchInit(parseArgs(["run", "--project", env.project]), env.project)).toBe(false);
    expect(shouldLaunchInit(parseArgs(["--help"]), env.project)).toBe(false);
    // a project that already ran huginn keeps live-first behavior
    mkdirSync(join(env.project, ".huginn"));
    expect(shouldLaunchInit(parseArgs([]), env.project)).toBe(false);
  });

  it("keeps the short -h flag out of the greenfield init launch", () => {
    const env = makeEnv();
    expect(shouldLaunchInit(parseArgs(["-h"]), env.project)).toBe(false);
    expect(shouldLaunchInit(parseArgs(["-h", "--project", env.project]), env.project)).toBe(false);
    // --all is a help modifier, not a benign bare flag either
    expect(shouldLaunchInit(parseArgs(["--all"]), env.project)).toBe(false);
    // ...while the documented benign flags still allow the launch
    expect(
      shouldLaunchInit(parseArgs(["--project", env.project, "--home", env.project]), env.project),
    ).toBe(true);
  });

  it("points at `huginn init` when non-interactive", async () => {
    const env = makeEnv();
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "));
    });
    try {
      await handleGreenfieldLaunch(parseArgs([]), env.project, { interactive: false });
    } finally {
      logSpy.mockRestore();
    }

    const output = stripAnsi(lines.join("\n"));
    expect(output).toContain("has not been set up for huginn yet");
    expect(output).toContain("huginn init");
    expect(output).toContain("huginn --help");
    expect(existsSync(join(env.project, ".huginn"))).toBe(false);
  });

  it("onboards a bare `huginn` in an uninitialized repository through main()", async () => {
    const env = makeEnv();
    const previousCi = process.env.CI;
    process.env.CI = "1"; // pin the non-interactive branch deterministically
    try {
      const output = await captureMain(["--project", env.project]);
      expect(output).toContain("has not been set up for huginn yet");
      expect(output).toContain("huginn init");
      expect(existsSync(join(env.project, ".huginn"))).toBe(false);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  it("launches the real wizard (real huginn setup) from the interactive greenfield path", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleGreenfieldLaunch(
        parseArgs([
          "--project",
          env.project,
          "--home",
          env.home,
          "--opencode-config-dir",
          env.opencodeConfigDir,
          "--yes",
        ]),
        env.project,
        { interactive: true },
      );
    } finally {
      logSpy.mockRestore();
    }

    const config = readConfig(env);
    expect(AGENT_TARGETS).toContain(config.agent);
    expect(config.thinker).toBe(DEFAULT_THINKER_MODEL);
    // the real `huginn setup` delegated to by the wizard wrote the portable MCP
    // fallback under the injected temp home (never the real ~)
    const portablePath = join(env.home, ".huginn", "mcp.json");
    expect(existsSync(portablePath)).toBe(true);
    const portable = JSON.parse(readFileSync(portablePath, "utf8")) as {
      mcpServers: { muninn: { args: string[] } };
    };
    expect(portable.mcpServers.muninn.args).toEqual(["mcp", "run", "--project", env.project]);
  });
});
