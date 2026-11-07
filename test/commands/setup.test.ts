import { afterAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
import { configRegistersMuninn } from "../../src/commands/doctor.js";

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
  it("contains exactly the thirteen documented targets (gemini removed — REQ-35.3)", () => {
    expect(AGENT_TARGETS).toEqual([
      "cursor",
      "claude",
      "opencode",
      "devin",
      "qwen",
      "codex",
      "agy",
      "kimi",
      "pi",
      "commandcode",
      "omp",
      "mcode",
      "mimo",
    ]);
    expect(listRegistry().map((s) => s.id)).toEqual(AGENT_TARGETS);
    expect(AGENT_REGISTRY.codex.format).toBe("toml");
    expect(AGENT_REGISTRY.opencode.format).toBe("opencode");
    expect(AGENT_REGISTRY.cursor.mcpPaths).toHaveLength(2);
    expect(AGENT_REGISTRY.claude.mcpPaths).toHaveLength(3);
    // Command Code 1.88 reads `<project>/.mcp.json` for the project scope;
    // `.commandcode/mcp.json` inside the project is invisible to `cmd mcp list`.
    expect(AGENT_REGISTRY.commandcode.mcpPaths).toEqual([
      "{home}/.commandcode/mcp.json",
      "{project}/.mcp.json",
    ]);
  });

  it("registers the Phase 3B targets where their CLI really reads them", () => {
    // `mcode` has no `mcp` command and loads MCP servers from the project's
    // `.mcp.json` only (the `mcpServers` container); its rules file is the
    // `AGENTS.md` its own `init` command generates.
    expect(AGENT_REGISTRY.mcode).toMatchObject({
      label: "MiniMax Code",
      format: "mcpServers",
      mcpPaths: ["{project}/.mcp.json"],
      rulesFile: "AGENTS.md",
    });
    // `mimo` is opencode-shaped: the global config dir is `~/.config/mimocode`,
    // the container is `mcp` (`{ type: "local", command: [...] }` entries) and
    // project instructions are discovered by walking up for `AGENTS.md`.
    expect(AGENT_REGISTRY.mimo).toMatchObject({
      label: "MiMo Code",
      format: "opencode",
      mcpPaths: ["{home}/.config/mimocode/mimocode.json"],
      rulesFile: "AGENTS.md",
    });
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
    // Phase 3B: mcode is project-scoped, mimo global-scoped (XDG config dir).
    expect(resolveMcpPaths("mcode", baseOpts(env))).toEqual([join(env.project, ".mcp.json")]);
    expect(resolveMcpPaths("mimo", baseOpts(env))).toEqual([
      join(env.home, ".config", "mimocode", "mimocode.json"),
    ]);
    // Command Code: user scope is `~/.commandcode/mcp.json`; the project scope is
    // the root `.mcp.json` (reusing mcode's location, not a duplicate rule).
    expect(resolveMcpPaths("commandcode", baseOpts(env))).toEqual([
      join(env.home, ".commandcode", "mcp.json"),
      join(env.project, ".mcp.json"),
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
          // A user-global config (e.g. ~/.codex/config.toml) must not pin one
          // project; only a project-local file carries --project.
          const args = path.startsWith(env.project)
            ? ["mcp", "run", "--project", env.project]
            : ["mcp", "run"];
          expect(raw).toContain(`args = ${JSON.stringify(args)}`);
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
    registerMcpForTarget("devin", baseOpts(env));
    const parsed = JSON.parse(
      readFileSync(join(env.project, ".devin", "mcp_config.json"), "utf8"),
    );
    expect(parsed.mcpServers.muninn).toEqual({
      command: "huginn",
      args: ["mcp", "run", "--project", env.project],
    });
    // The user scope is written too.
    expect(existsSync(join(env.home, ".config", "devin", "mcp_config.json"))).toBe(true);
  });

  it("pins --project only in project-local configs, never in user-global ones", () => {
    const env = makeEnv();
    registerMcpForTarget("cursor", baseOpts(env));
    const project = JSON.parse(readFileSync(join(env.project, ".cursor", "mcp.json"), "utf8"));
    const global = JSON.parse(readFileSync(join(env.home, ".cursor", "mcp.json"), "utf8"));
    expect(project.mcpServers.muninn.args).toEqual(["mcp", "run", "--project", env.project]);
    // A user-global file is shared by every project; it resolves cwd at runtime.
    expect(global.mcpServers.muninn.args).toEqual(["mcp", "run"]);
  });

  it("writes the opencode shape exactly", () => {
    const env = makeEnv();
    registerMcpForTarget("opencode", baseOpts(env));
    const parsed = JSON.parse(readFileSync(join(env.opencodeConfigDir, "opencode.json"), "utf8"));
    // The opencode config dir is user-global: no project path is pinned.
    expect(parsed.mcp.muninn).toEqual({
      type: "local",
      command: ["huginn", "mcp", "run"],
      enabled: true,
    });
  });

  it("writes the Phase 3B shapes exactly, where each CLI reads them", () => {
    const env = makeEnv();

    // mcode: the project `.mcp.json` `mcpServers` map (stdio via `command`).
    registerMcpForTarget("mcode", baseOpts(env));
    const mcode = JSON.parse(readFileSync(join(env.project, ".mcp.json"), "utf8"));
    expect(mcode.mcpServers.muninn).toEqual({
      command: "huginn",
      args: ["mcp", "run", "--project", env.project],
    });

    // mimo: the global `mimocode.json` with opencode's `mcp` container.
    registerMcpForTarget("mimo", baseOpts(env));
    const mimo = JSON.parse(
      readFileSync(join(env.home, ".config", "mimocode", "mimocode.json"), "utf8"),
    );
    // mimo's config is user-global (`~/.config/mimocode`): no project path.
    expect(mimo.mcp.muninn).toEqual({
      type: "local",
      command: ["huginn", "mcp", "run"],
      enabled: true,
    });

    // Both read project instructions from the root `AGENTS.md`.
    expect(injectRulesForTarget("mcode", baseOpts(env)).path).toBe(
      join(env.project, "AGENTS.md"),
    );
    expect(injectRulesForTarget("mimo", baseOpts(env)).path).toBe(join(env.project, "AGENTS.md"));
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

  it("preserves the permission bits of a pre-existing config file (SEC-1001)", () => {
    const env = makeEnv();
    const path = join(env.project, ".cursor", "mcp.json");
    writeFileEnsured(path, JSON.stringify({ mcpServers: {} }));
    // Use a non-default mode so this test fails if stat-preservation is dropped
    // (0o600 is also the new-file default, which would mask a regression).
    chmodSync(path, 0o400);

    registerMcpForTarget("cursor", baseOpts(env));

    // The hardened 0o400 file must be preserved by the setup write, not widened.
    expect(statSync(path).mode & 0o777).toBe(0o400);
  });

  it("creates a new config file with restrictive 0o600 permissions (SEC-1001)", () => {
    const env = makeEnv();
    const regs = registerMcpForTarget("devin", baseOpts(env));
    expect(regs.length).toBeGreaterThan(0);
    expect(statSync(regs[0].path).mode & 0o777).toBe(0o600);
  });
});

describe("Command Code project scope (1.88)", () => {
  it("merges muninn into the project .mcp.json without touching other servers", () => {
    const env = makeEnv();
    const path = join(env.project, ".mcp.json");
    const codegraph = { command: "codegraph", args: ["serve"], env: { A: "1" } };
    writeFileEnsured(path, JSON.stringify({ mcpServers: { codegraph } }));

    const report = setup({ agent: "commandcode", ...baseOpts(env) });

    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    // The pre-existing server is byte-for-byte preserved; the writer merges into
    // the container instead of replacing the file.
    expect(parsed.mcpServers.codegraph).toEqual(codegraph);
    expect(parsed.mcpServers.muninn).toEqual({
      command: "huginn",
      args: ["mcp", "run", "--project", env.project],
    });
    expect(report.registrations.find((r) => r.path === path)?.changed).toBe(true);
    // The user scope is written too, and a user-global file never pins a project.
    const home = JSON.parse(
      readFileSync(join(env.home, ".commandcode", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(home.mcpServers.muninn).toEqual({ command: "huginn", args: ["mcp", "run"] });
    // `huginn doctor` sees the registration in the file Command Code actually reads.
    expect(configRegistersMuninn(path, "mcpServers")).toBe(true);
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
    // ~/.codex/config.toml is user-global, so it resolves the project from cwd.
    expect(raw).toContain(`args = ${JSON.stringify(["mcp", "run"])}`);
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
    // The portable fallback lives under $HOME, so it must not pin a project.
    expect(parsed.mcpServers.muninn).toEqual({
      command: "huginn",
      args: ["mcp", "run"],
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
    // The block asks for a write too: memory that is only ever read never grows.
    expect(first).toContain("muninn_save");
    expect(first).toContain("topicKey");
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

  it("provisions only the agents the user names (REQ-38 / AC-38.2)", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleSetupCommand({
        "--agent": "devin,claude",
        "--project": env.project,
        "--home": env.home,
        "--opencode-config-dir": env.opencodeConfigDir,
      });
      // Exactly those two — the other nine targets are untouched.
      expect(existsSync(join(env.project, ".devin", "mcp_config.json"))).toBe(true);
      expect(existsSync(join(env.home, ".config", "devin", "mcp_config.json"))).toBe(true);
      expect(existsSync(join(env.home, ".claude.json"))).toBe(true);
      expect(existsSync(join(env.home, ".gemini", "settings.json"))).toBe(false);
      expect(existsSync(join(env.project, ".cursor", "mcp.json"))).toBe(false);
      // ...and the shared brain is still reachable through the portable fallback.
      expect(existsSync(join(env.home, ".huginn", "mcp.json"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("rejects an unknown name inside a comma-separated list (AC-38.2)", async () => {
    const env = makeEnv();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = 0;
    try {
      await handleSetupCommand({
        "--agent": "claude,nope",
        "--project": env.project,
        "--home": env.home,
      });
      expect(process.exitCode).toBe(1);
      expect(existsSync(join(env.home, ".claude.json"))).toBe(false);
    } finally {
      process.exitCode = previous;
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("prints the provisioning matrix with the exact fix command (AC-38.4)", async () => {
    const env = makeEnv();
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      await handleSetupCommand(
        {
          "--status": true,
          "--project": env.project,
          "--home": env.home,
          "--opencode-config-dir": env.opencodeConfigDir,
        },
        // Inject detection: the fix line only names *installed* gaps, so the
        // assertion must not depend on which agent CLIs the runner has (CI has none).
        { detect: async () => AGENT_TARGETS.map((id) => ({ id, available: id === "claude" })) },
      );
      const output = lines.join("\n");
      expect(output).toContain("Muninn provisioning");
      // Every supported target is listed with its registration state...
      for (const id of AGENT_TARGETS) expect(output).toContain(id);
      expect(output).toContain("not registered");
      // ...and the fix names the gaps, not a vague "run huginn setup".
      expect(output).toContain("fix: huginn setup --agent claude");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("--dry-run reports the same work but writes nothing (AC-38.6)", async () => {
    const env = makeEnv();
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      await handleSetupCommand({
        "--agent": "devin,claude",
        "--dry-run": true,
        "--project": env.project,
        "--home": env.home,
        "--opencode-config-dir": env.opencodeConfigDir,
      });

      // The preview still describes the work...
      expect(lines.join("\n")).toMatch(/dry-run/i);
      // ...and touches *nothing*: no MCP config, no rules, no portable fallback.
      expect(existsSync(join(env.project, ".devin", "mcp_config.json"))).toBe(false);
      expect(existsSync(join(env.home, ".config", "devin", "mcp_config.json"))).toBe(false);
      expect(existsSync(join(env.home, ".claude.json"))).toBe(false);
      expect(existsSync(join(env.project, ".windsurf", "rules", "muninn.md"))).toBe(false);
      expect(existsSync(join(env.project, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(env.home, ".huginn", "mcp.json"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("--installed filters the selection and never widens it (AC-38.2)", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Only `claude` is "installed" and only `devin` is named: the intersection
    // is empty, so *nothing* may be written — the flag must not fall back to the
    // whole installed fleet.
    const detect = async () =>
      AGENT_TARGETS.map((id) => ({ id, available: id === "claude" })) as never;
    try {
      await handleSetupCommand(
        {
          "--agent": "devin",
          "--installed": true,
          "--project": env.project,
          "--home": env.home,
          "--opencode-config-dir": env.opencodeConfigDir,
        },
        { detect },
      );

      expect(existsSync(join(env.home, ".claude.json"))).toBe(false);
      expect(existsSync(join(env.project, ".devin", "mcp_config.json"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("--installed with no selection configures exactly the installed agents (AC-38.2)", async () => {
    const env = makeEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const detect = async () =>
      AGENT_TARGETS.map((id) => ({ id, available: id === "claude" || id === "devin" })) as never;
    try {
      await handleSetupCommand(
        { "--installed": true, "--project": env.project, "--home": env.home, "--opencode-config-dir": env.opencodeConfigDir },
        { detect },
      );

      expect(existsSync(join(env.home, ".claude.json"))).toBe(true);
      expect(existsSync(join(env.project, ".devin", "mcp_config.json"))).toBe(true);
      // An uninstalled target is untouched.
      expect(existsSync(join(env.home, ".qwen", "settings.json"))).toBe(false);
      expect(existsSync(join(env.project, ".cursor", "mcp.json"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });
});
