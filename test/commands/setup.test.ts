import { afterAll, describe, expect, it, vi } from "vitest";
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
import {
  AGENT_REGISTRY,
  AGENT_TARGETS,
  MUNINN_RULES_END,
  MUNINN_RULES_START,
  injectRulesForTarget,
  listRegistry,
  registerMcpForTarget,
  resolveMcpPaths,
  setup,
  writePortableMcpConfig,
} from "../../src/agents/integrator.js";
import { handleSetupCommand } from "../../src/commands/setup.js";

const roots: string[] = [];

interface Env {
  root: string;
  project: string;
  home: string;
  opencodeConfigDir: string;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "huginn-setup-test-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  const opencodeConfigDir = join(root, "opencode-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(opencodeConfigDir, { recursive: true });
  return { root, project, home, opencodeConfigDir };
}

function baseOpts(env: Env, envVars: Record<string, string | undefined> = {}) {
  return {
    projectPath: env.project,
    homeDir: env.home,
    opencodeConfigDir: env.opencodeConfigDir,
    env: envVars,
  };
}

function writeFileEnsured(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
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

describe("AGENT_REGISTRY", () => {
  it("contains exactly the twelve documented targets", () => {
    expect(AGENT_TARGETS).toEqual([
      "cursor",
      "claude",
      "opencode",
      "windsurf",
      "gemini",
      "qwen",
      "codex",
      "agy",
      "kimi",
      "pi",
      "commandcode",
      "omp",
    ]);
    expect(listRegistry().map((s) => s.id)).toEqual(AGENT_TARGETS);
    expect(AGENT_REGISTRY.codex.format).toBe("toml");
    expect(AGENT_REGISTRY.opencode.format).toBe("opencode");
    expect(AGENT_REGISTRY.cursor.mcpPaths).toHaveLength(2);
    expect(AGENT_REGISTRY.claude.mcpPaths).toHaveLength(3);
  });
});

describe("resolveMcpPaths", () => {
  it("expands placeholders and honors the injected opencode config dir", () => {
    const env = makeEnv();
    expect(resolveMcpPaths("cursor", baseOpts(env))).toEqual([
      join(env.project, ".cursor", "mcp.json"),
      join(env.home, ".cursor", "mcp.json"),
    ]);
    expect(resolveMcpPaths("opencode", baseOpts(env))).toEqual([
      join(env.opencodeConfigDir, "opencode.json"),
    ]);
  });

  it("applies the colon-separated HUGINN_AGENT_<ID>_MCP_PATH override", () => {
    const env = makeEnv();
    const a = join(env.root, "custom", "a.json");
    const b = join(env.root, "custom", "b.json");
    const paths = resolveMcpPaths("cursor", baseOpts(env, { HUGINN_AGENT_CURSOR_MCP_PATH: `${a}:${b}` }));
    expect(paths).toEqual([a, b]);
  });
});

describe("registerMcpForTarget", () => {
  it("creates the target's config file(s) with the correct format and entry", () => {
    for (const target of AGENT_TARGETS) {
      const env = makeEnv();
      const opts = baseOpts(env);
      const regs = registerMcpForTarget(target, opts);
      const expected = resolveMcpPaths(target, opts);
      expect(regs.map((r) => r.path)).toEqual(expected);
      for (const path of expected) {
        expect(existsSync(path)).toBe(true);
        const raw = readFileSync(path, "utf8");
        if (AGENT_REGISTRY[target].format === "toml") {
          expect(raw).toContain("[mcp_servers.muninn]");
          expect(raw).toContain('command = "huginn"');
          expect(raw).toContain(
            `args = ["mcp", "run", "--project", ${JSON.stringify(env.project)}]`,
          );
        } else {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const container =
            AGENT_REGISTRY[target].format === "opencode"
              ? (parsed.mcp as Record<string, unknown>)
              : (parsed.mcpServers as Record<string, unknown>);
          expect(container.muninn).toBeDefined();
        }
      }
    }
  });

  it("writes the mcpServers shape exactly", () => {
    const env = makeEnv();
    registerMcpForTarget("gemini", baseOpts(env));
    const parsed = JSON.parse(readFileSync(join(env.home, ".gemini", "settings.json"), "utf8"));
    expect(parsed.mcpServers.muninn).toEqual({
      command: "huginn",
      args: ["mcp", "run", "--project", env.project],
    });
  });

  it("writes the opencode shape exactly", () => {
    const env = makeEnv();
    registerMcpForTarget("opencode", baseOpts(env));
    const parsed = JSON.parse(readFileSync(join(env.opencodeConfigDir, "opencode.json"), "utf8"));
    expect(parsed.mcp.muninn).toEqual({
      type: "local",
      command: ["huginn", "mcp", "run", "--project", env.project],
      enabled: true,
    });
  });

  it("writes every path of a multi-path target", () => {
    for (const target of ["cursor", "claude", "agy"] as const) {
      const env = makeEnv();
      const regs = registerMcpForTarget(target, baseOpts(env));
      expect(regs).toHaveLength(AGENT_REGISTRY[target].mcpPaths.length);
      for (const reg of regs) expect(existsSync(reg.path)).toBe(true);
    }
  });

  it("preserves unrelated keys and sibling servers", () => {
    const env = makeEnv();
    const path = join(env.project, ".cursor", "mcp.json");
    writeFileEnsured(path, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
    registerMcpForTarget("cursor", baseOpts(env));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.mcpServers.muninn.command).toBe("huginn");
  });

  it("is idempotent: a second run reports no change and keeps bytes identical", () => {
    const env = makeEnv();
    registerMcpForTarget("claude", baseOpts(env));
    const path = join(env.project, ".mcp.json");
    const before = readFileSync(path, "utf8");
    const second = registerMcpForTarget("claude", baseOpts(env));
    expect(second.every((r) => !r.changed && !r.skipped)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("skips a differing existing muninn entry without --force and overwrites with --force", () => {
    const env = makeEnv();
    const path = join(env.project, ".cursor", "mcp.json");
    const original = JSON.stringify({
      mcpServers: { muninn: { command: "other", args: [] } },
    });
    writeFileEnsured(path, original);

    const skipped = registerMcpForTarget("cursor", baseOpts(env));
    expect(skipped.find((r) => r.path === path)?.skipped).toBe(true);
    expect(skipped.find((r) => r.path === path)?.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);

    const forced = registerMcpForTarget("cursor", { ...baseOpts(env), force: true });
    expect(forced.find((r) => r.path === path)?.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.muninn.command).toBe("huginn");
  });

  it("fails closed on malformed existing JSON without writing", () => {
    const env = makeEnv();
    const path = join(env.project, ".cursor", "mcp.json");
    writeFileEnsured(path, "{ this is not json");
    expect(() => registerMcpForTarget("cursor", baseOpts(env))).toThrow(/malformed JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });
});

describe("TOML handling (codex)", () => {
  it("parses and preserves unrelated tables around the injected table", () => {
    const env = makeEnv();
    const path = join(env.home, ".codex", "config.toml");
    const original =
      'model = "o3"\n\n[other]\nkey = "value"\n\n[mcp_servers.existing]\ncommand = "foo"\n';
    writeFileEnsured(path, original);

    const regs = registerMcpForTarget("codex", baseOpts(env));
    expect(regs[0].changed).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('model = "o3"');
    expect(raw).toContain("[other]");
    expect(raw).toContain('key = "value"');
    expect(raw).toContain("[mcp_servers.existing]");
    expect(raw).toContain('command = "foo"');
    expect(raw).toContain("[mcp_servers.muninn]");
    expect(raw).toContain(`args = ["mcp", "run", "--project", ${JSON.stringify(env.project)}]`);
  });

  it("is idempotent with byte-identical output", () => {
    const env = makeEnv();
    const path = join(env.home, ".codex", "config.toml");
    registerMcpForTarget("codex", baseOpts(env));
    const before = readFileSync(path, "utf8");
    const second = registerMcpForTarget("codex", baseOpts(env));
    expect(second[0].changed).toBe(false);
    expect(second[0].skipped).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("skips a differing muninn table without --force and replaces with --force", () => {
    const env = makeEnv();
    const path = join(env.home, ".codex", "config.toml");
    const original = '[mcp_servers.muninn]\ncommand = "other"\nargs = []\n';
    writeFileEnsured(path, original);

    const skipped = registerMcpForTarget("codex", baseOpts(env));
    expect(skipped[0].skipped).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);

    registerMcpForTarget("codex", { ...baseOpts(env), force: true });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain('command = "huginn"');
    expect(raw).not.toContain('"other"');
  });

  it("fails closed on a malformed muninn table", () => {
    const env = makeEnv();
    const path = join(env.home, ".codex", "config.toml");
    const original = "[mcp_servers.muninn]\ncommand = huginn\n";
    writeFileEnsured(path, original);
    expect(() => registerMcpForTarget("codex", baseOpts(env))).toThrow(/malformed/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

describe("portable fallback", () => {
  it("writes the standard mcpServers file at <home>/.huginn/mcp.json", () => {
    const env = makeEnv();
    const result = writePortableMcpConfig(baseOpts(env));
    expect(result.path).toBe(join(env.home, ".huginn", "mcp.json"));
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(parsed.mcpServers.muninn).toEqual({
      command: "huginn",
      args: ["mcp", "run", "--project", env.project],
    });
    expect(writePortableMcpConfig(baseOpts(env)).changed).toBe(false);
  });
});

describe("rules injection", () => {
  it("inserts the marked block, preserves user content, and replaces idempotently", () => {
    const env = makeEnv();
    const path = join(env.project, ".cursorrules");
    writeFileEnsured(path, "# My rules\n\nKeep me.\n");

    expect(injectRulesForTarget("cursor", baseOpts(env)).changed).toBe(true);
    const first = readFileSync(path, "utf8");
    expect(first).toContain("# My rules");
    expect(first).toContain("Keep me.");
    expect(first).toContain(MUNINN_RULES_START);
    expect(first).toContain(MUNINN_RULES_END);
    expect(first).toContain("muninn_context");
    expect(first).toContain("muninn_inspect_symbol");
    expect(first).toContain("muninn_verify_contract");

    expect(injectRulesForTarget("cursor", baseOpts(env)).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(first);

    const stale = first.replace(/## Muninn memory directives[\s\S]*?<!-- huginn:muninn-rules:end -->/, `STALE\n${MUNINN_RULES_END}`);
    writeFileEnsured(path, stale);
    expect(injectRulesForTarget("cursor", baseOpts(env)).changed).toBe(true);
    const finalContent = readFileSync(path, "utf8");
    expect(finalContent).toContain("# My rules");
    expect(finalContent).toContain("Keep me.");
    expect(finalContent).not.toContain("STALE");
  });
});

describe("setup()", () => {
  it("runs every registry target and writes the portable fallback", () => {
    const env = makeEnv();
    const report = setup({ agent: "all", ...baseOpts(env) });
    expect(report.registrations.length).toBe(
      AGENT_TARGETS.reduce((sum, t) => sum + AGENT_REGISTRY[t].mcpPaths.length, 0),
    );
    expect(report.rules).toHaveLength(AGENT_TARGETS.length);
    expect(report.portable.path).toBe(join(env.home, ".huginn", "mcp.json"));
    expect(existsSync(report.portable.path)).toBe(true);
    // shared AGENTS.md injected once and reported unchanged for later targets
    const agentsRules = join(env.project, "AGENTS.md");
    expect(existsSync(agentsRules)).toBe(true);
  });

  it("applies a HUGINN_AGENT_<ID>_MCP_PATH override end to end", () => {
    const env = makeEnv();
    const custom = join(env.root, "custom", "cursor.json");
    const report = setup({
      agent: "cursor",
      ...baseOpts(env, { HUGINN_AGENT_CURSOR_MCP_PATH: custom }),
    });
    expect(report.registrations.map((r) => r.path)).toEqual([custom]);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(join(env.project, ".cursor", "mcp.json"))).toBe(false);
  });
});

describe("handleSetupCommand", () => {
  it("configures a target from CLI args", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleSetupCommand({
        "--agent": "cursor",
        "--project": env.project,
        "--home": env.home,
        "--opencode-config-dir": env.opencodeConfigDir,
      });
      expect(existsSync(join(env.project, ".cursor", "mcp.json"))).toBe(true);
      expect(existsSync(join(env.project, ".cursorrules"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("rejects an unknown agent with a non-zero exit code", async () => {
    const env = makeEnv();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await handleSetupCommand({ "--agent": "nope", "--project": env.project, "--home": env.home });
      expect(process.exitCode).toBe(1);
      expect(existsSync(join(env.project, ".cursor", "mcp.json"))).toBe(false);
    } finally {
      process.exitCode = previous;
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
