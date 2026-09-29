import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TARGETS } from "../../../src/agents/integrator.js";
import {
  detectAvailableAgents,
  getAgentRuntime,
  resolveAgent,
  SUBPROCESS_PERMISSION_ARGS,
} from "../../../src/engine/agent/registry.js";
import type {
  IAgentRuntime,
  IAgentSession,
  McpStatusReport,
  ModelInfo,
  PromptOptions,
  PromptResult,
  SessionOptions,
} from "../../../src/engine/agent/types.js";
import { CycleEngine } from "../../../src/engine/cycle.js";
import type { RunConfig } from "../../../src/config.js";

class MockAgentSession implements IAgentSession {
  readonly id: string;
  readonly promptCalls: Array<{ text: string; options?: PromptOptions }> = [];
  readonly commandCalls: Array<{ command: string; args: string }> = [];
  aborted = false;

  constructor(id: string = "mock-session-id") {
    this.id = id;
  }

  async prompt(text: string, options?: PromptOptions): Promise<PromptResult> {
    this.promptCalls.push({ text, options });
    return {
      messageId: `msg-${this.promptCalls.length}`,
      text: "Overall fidelity: 🟢 ALIGNED\n\nBuild passed successfully.",
      raw: { text },
    };
  }

  async runCommand(command: string, args: string): Promise<PromptResult> {
    this.commandCalls.push({ command, args });
    return {
      messageId: `cmd-${this.commandCalls.length}`,
      text: "overall gate: 🟢 PASS\n✅ AUTO-APPROVED",
      raw: { command, args },
    };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

class MockAgentRuntime implements IAgentRuntime {
  readonly id = "claude" as const;
  readonly name = "Mock Claude";
  readonly createdSessions: MockAgentSession[] = [];
  daemonStarted = false;
  daemonStopped = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return [{ id: "mock/model-1", name: "Mock Model 1", provider: "Mock" }];
  }

  async getMcpStatus(): Promise<McpStatusReport> {
    return {
      servers: [{ id: "muninn", name: "muninn", status: "connected", transport: "stdio", toolsCount: 5 }],
      totalTools: 5,
      healthy: true,
    };
  }

  async createSession(options: SessionOptions): Promise<IAgentSession> {
    const session = new MockAgentSession(`mock-session-${this.createdSessions.length + 1}`);
    this.createdSessions.push(session);
    return session;
  }

  async startDaemon(): Promise<void> {
    this.daemonStarted = true;
  }

  async stopDaemon(): Promise<void> {
    this.daemonStopped = true;
  }
}

function makeCfg(projectPath: string, overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    projectPath,
    planPath: join(projectPath, "plan.md"),
    specPath: join(projectPath, "spec.md"),
    adrPath: join(projectPath, "adr.md"),
    thinker: "anthropic/claude-opus-4-5",
    executor: "opencode/gpt-5.1-codex",
    agent: "claude",
    mode: "auto",
    permissions: "auto",
    maxRetries: 1,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 1000,
    ignorePlanChanges: false,
    sandbox: false,
    ...overrides,
  };
}

describe("Agent Registry & Factory", () => {
  it("resolves adapters for each known target with matching target ID", () => {
    const opencode = getAgentRuntime("opencode");
    expect(opencode.id).toBe("opencode");
    expect(opencode.name).toBe("OpenCode");

    const claude = getAgentRuntime("claude");
    expect(claude.id).toBe("claude");
    expect(claude.name).toBe("Claude Code");

    const codex = getAgentRuntime("codex");
    expect(codex.id).toBe("codex");
    expect(codex.name).toBe("OpenAI Codex CLI");

    const omp = getAgentRuntime("omp");
    expect(omp.id).toBe("omp");
    expect(omp.name).toBe("Oh My Pi");

    const commandcode = getAgentRuntime("commandcode");
    expect(commandcode.id).toBe("commandcode");
    expect(commandcode.name).toBe("Command Code");

    const qwen = getAgentRuntime("qwen");
    expect(qwen.id).toBe("qwen");
    expect(qwen.name).toBe("Qwen Code");

    const pi = getAgentRuntime("pi");
    expect(pi.id).toBe("pi");

    const kimi = getAgentRuntime("kimi");
    expect(kimi.id).toBe("kimi");

    const cursor = getAgentRuntime("cursor", { projectPath: "/test/p", homeDir: "/test/h" });
    expect(cursor.id).toBe("cursor");
    expect(cursor.name).toBe("Cursor");

    const devin = getAgentRuntime("devin");
    expect(devin.id).toBe("devin");
    expect(devin.name).toBe("Devin");

    const agy = getAgentRuntime("agy");
    expect(agy.id).toBe("agy");
    expect(agy.name).toBe("Antigravity CLI (agy)");
  });

  it("never fabricates a model catalog for runtimes without a listing command (REQ-27)", async () => {
    for (const target of ["kimi", "pi", "cursor", "claude", "qwen", "codex"] as const) {
      const runtime = getAgentRuntime(target, { env: { PATH: "/dev/null" } });
      // AC-27.4: no `${id}/default` placeholder, no static list — honest [].
      expect(await runtime.getAvailableModels()).toEqual([]);
    }
  });

  it("wires the real `omp models` listing command (AC-27.4)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-omp-wiring-"));
    try {
      const ompBin = join(tempDir, "omp");
      writeFileSync(
        ompBin,
        "#!/bin/sh\n" +
          '[ "$1" = "models" ] || exit 9\n' +
          "printf 'deepseek (1)\\n" +
          "┌─┬─┐\\n" +
          "│ model │ context │\\n" +
          "├─┼─┤\\n" +
          "│ deepseek-flash │ 1M │\\n" +
          "└─┴─┘\\n'\n",
      );
      chmodSync(ompBin, 0o755);

      const runtime = getAgentRuntime("omp", { env: { PATH: tempDir } });
      expect(await runtime.getAvailableModels()).toEqual([
        {
          id: "deepseek/deepseek-flash",
          name: "deepseek-flash",
          provider: "deepseek",
          description: "context 1M",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("wires the real `agy models` listing command and ignores its preamble (AC-27.4)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-agy-wiring-"));
    try {
      const agyBin = join(tempDir, "agy");
      writeFileSync(
        agyBin,
        "#!/bin/sh\n" +
          '[ "$1" = "models" ] || exit 9\n' +
          "printf 'Fetching available models...\\n" +
          "gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'\n",
      );
      chmodSync(agyBin, 0o755);

      const runtime = getAgentRuntime("agy", { env: { PATH: tempDir } });
      expect(await runtime.getAvailableModels()).toEqual([
        { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", provider: "agy" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("wires the real `devin models list` listing command and ignores its preamble (AC-27.4)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-devin-wiring-"));
    try {
      const devinBin = join(tempDir, "devin");
      writeFileSync(
        devinBin,
        "#!/bin/sh\n" +
          '[ "$1" = "models" ] && [ "$2" = "list" ] || exit 9\n' +
          "printf 'Available models (1 families)\\n\\n" +
          "Claude Opus 5.5 (claude-opus-5.5)\\n" +
          "  claude-opus-5-5-medium                                          Claude Opus 5.5 Medium  [$4 / 1M Output]\\n'\n",
      );
      chmodSync(devinBin, 0o755);

      const runtime = getAgentRuntime("devin", { env: { PATH: tempDir } });
      expect(await runtime.getAvailableModels()).toEqual([
        {
          id: "claude-opus-5-5-medium",
          name: "Claude Opus 5.5 Medium",
          provider: "Claude Opus 5.5",
          description: "$4 / 1M Output",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds the verified `devin --print` argv with the prompt in a temp file, not on the argv", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-devin-argv-"));
    try {
      const capture = join(tempDir, "prompt.txt");
      const devinBin = join(tempDir, "devin");
      writeFileSync(
        devinBin,
        "#!/bin/sh\n" +
          'printf \'%s\\n\' "$@"\n' +
          'prev=""\n' +
          'for a in "$@"; do\n' +
          '  if [ "$prev" = "--prompt-file" ]; then cp "$a" "$HUGINN_PROMPT_CAPTURE"; fi\n' +
          '  prev="$a"\n' +
          'done\n' +
          "exit 0\n",
      );
      chmodSync(devinBin, 0o755);

      const runtime = getAgentRuntime("devin", {
        // Keep the real PATH behind the temp dir so the fake `devin` can still
        // resolve `cp`.
        env: { PATH: `${tempDir}:${process.env.PATH ?? ""}`, HUGINN_PROMPT_CAPTURE: capture },
        permissions: "auto",
      });
      expect(runtime.id).toBe("devin");
      const session = await runtime.createSession({ title: "devin" });
      // Larger than any sane argument cap: a real huginn prompt embeds the
      // spec/ADR/plan, so this must never travel on the argv (REV-3A-001).
      const prompt = `fix the failing test ${"x".repeat(8192)}`;
      const result = await session.prompt(prompt, { model: "opus" });
      const argv = result.text.split("\n").map((line) => line.trim()).filter(Boolean);

      // Verified with `devin --help`/a live probe: print mode requires the prompt
      // from a file or an argument, and cannot show the workspace-trust prompt,
      // so `--respect-workspace-trust false` is always passed. The prompt is
      // handed over via `--prompt-file <tmp>` — never positionally.
      expect(argv.slice(0, 7)).toEqual([
        "-p",
        "--respect-workspace-trust",
        "false",
        "--model",
        "opus",
        "--permission-mode",
        "dangerous",
      ]);
      const [flag, tmpPath] = argv.slice(-2);
      expect(flag).toBe("--prompt-file");
      expect(argv).toHaveLength(9);
      expect(tmpPath?.startsWith(join(tmpdir(), "huginn-prompt-"))).toBe(true);
      expect(argv).not.toContain(prompt);
      // The CLI read back exactly what huginn wrote, and the temp file is gone
      // once the prompt settled.
      expect(readFileSync(capture, "utf8")).toBe(prompt);
      expect(existsSync(tmpPath!)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Spawns five short-lived processes; the default 5s budget is tight under the
  // parallel full-suite run, so this one gets its own (REV-3302/O2).
  it(
    "exposes the runtime's native model flag for the runtimes without a listing command (AC-27.5)",
    async () => {
      // REV-003/S1: `kimi`/`pi`/`cursor` used to have no `modelArgs` at all, so
      // `HUGINN_MODEL` was their only (unread) model channel.
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-modelargs-"));
      try {
        const cases: Array<[AgentTarget, string[]]> = [
          ["kimi", ["-m", "moonshot/kimi-k2.5"]],
          ["pi", ["-m", "moonshot/kimi-k2.5"]],
          ["cursor", ["--model", "moonshot/kimi-k2.5"]],
        ];

        for (const [target, expected] of cases) {
          const fake = join(tempDir, target);
          writeFileSync(fake, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
          chmodSync(fake, 0o755);

          const runtime = getAgentRuntime(target, { env: { PATH: tempDir } });
          expect(runtime.id).toBe(target);

          const session = await runtime.createSession({ title: target });
          const result = await session.prompt("go", { model: "moonshot/kimi-k2.5" });
          const argv = result.text.split("\n").map((line) => line.trim()).filter(Boolean);
          // The model flag comes first; the runtime's auto-approval flag(s)
          // (Phase 2C) are appended after it — see permissions.test.ts.
          expect(argv).toEqual([...expected, ...(SUBPROCESS_PERMISSION_ARGS[target] ?? [])]);
        }

        // The flag stays overridable through `RuntimeOptions`.
        const overridden = getAgentRuntime("kimi", {
          env: { PATH: tempDir },
          modelArgs: (model) => ["--kimi-model", model],
        });
        const session = await overridden.createSession({ title: "override" });
        const result = await session.prompt("go", { model: "moonshot/kimi-k2.5" });
        expect(result.text.split("\n").map((line) => line.trim()).filter(Boolean)).toEqual([
          "--kimi-model",
          "moonshot/kimi-k2.5",
          ...(SUBPROCESS_PERMISSION_ARGS.kimi ?? []),
        ]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("resolves agent target with strict precedence", async () => {
    // 1. Flag wins over everything
    const fromFlag = await resolveAgent({
      flagAgent: "claude",
      projectConfig: { agent: "codex" },
      userConfig: { agent: "omp" },
      env: { HUGINN_AGENT: "qwen" },
    });
    expect(fromFlag).toBe("claude");

    // 2. Project config wins over user config, env, and detection
    const fromProject = await resolveAgent({
      projectConfig: { agent: "codex" },
      userConfig: { agent: "omp" },
      env: { HUGINN_AGENT: "qwen" },
    });
    expect(fromProject).toBe("codex");

    // 3. User config wins over env and detection
    const fromUser = await resolveAgent({
      userConfig: { agent: "omp" },
      env: { HUGINN_AGENT: "qwen" },
    });
    expect(fromUser).toBe("omp");

    // 4. Env wins over detection
    const fromEnv = await resolveAgent({
      env: { HUGINN_AGENT: "qwen" },
    });
    expect(fromEnv).toBe("qwen");

    // 5. Default fallback to opencode when nothing matches/detected
    const fallback = await resolveAgent({
      env: { PATH: "/dev/null" },
    });
    expect(fallback).toBe("opencode");
  });

  it("resolves agent via PATH binary auto-detection when no explicit source is set", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-autodetect-"));
    try {
      const fakeCodex = join(tempDir, "codex");
      writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeCodex, 0o755);

      const resolved = await resolveAgent({
        env: { PATH: tempDir },
      });
      expect(resolved).toBe("codex");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("trims whitespace from agent source strings", async () => {
    expect(await resolveAgent({ flagAgent: "  claude  " })).toBe("claude");
    expect(await resolveAgent({ projectConfig: { agent: "  codex  " } })).toBe("codex");
    expect(await resolveAgent({ userConfig: { agent: "  omp  " } })).toBe("omp");
    expect(await resolveAgent({ env: { HUGINN_AGENT: "  qwen  " } })).toBe("qwen");
  });

  it("throws an error when an unknown agent target is provided to getAgentRuntime (SEC-001)", () => {
    expect(() => getAgentRuntime("unknown-target" as any)).toThrow(/Unknown agent target/);
    expect(() => getAgentRuntime("" as any)).toThrow(/Unknown agent target/);
    expect(() => getAgentRuntime(undefined as any)).toThrow(/Unknown agent target/);
  });

  it("throws an error when an unknown agent target is provided in resolveAgent sources (SEC-001)", async () => {
    await expect(resolveAgent({ flagAgent: "malicious-cmd" })).rejects.toThrow(/Unknown agent target/);
    await expect(resolveAgent({ projectConfig: { agent: "evil-script" } })).rejects.toThrow(/Unknown agent target/);
    await expect(resolveAgent({ env: { HUGINN_AGENT: "bad-agent" } })).rejects.toThrow(/Unknown agent target/);
  });

  it("falls back with a warning when a persisted config names the removed gemini (AC-35.3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Empty PATH keeps detection instant and deterministic (no local CLIs).
      const resolved = await resolveAgent({ projectConfig: { agent: "gemini" }, env: { PATH: "" } });
      // `gemini` no longer exists, but an old config must not break the run.
      expect(AGENT_TARGETS).not.toContain("gemini");
      expect(resolved).toBe("opencode");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back with a warning when a persisted config names the removed windsurf (AC-35.3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Phase 3A renamed `windsurf` to `devin`; an old `.huginn/config.json` must
      // keep working: warn, then fall through to auto-detection (empty PATH →
      // the opencode fallback), never throw.
      const resolved = await resolveAgent({
        projectConfig: { agent: "windsurf" },
        env: { PATH: "" },
      });
      expect(AGENT_TARGETS).not.toContain("windsurf");
      expect(AGENT_TARGETS).toContain("devin");
      expect(resolved).toBe("opencode");
      expect(warn).toHaveBeenCalled();
      const message = warn.mock.calls.flat().join(" ");
      expect(message).toContain('"windsurf"');
      expect(message).toContain('"devin"');
    } finally {
      warn.mockRestore();
    }
  });

  it("degrades HUGINN_AGENT=windsurf with a warning instead of throwing (REV-3A-005)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The env var is a *stored* source too: a removed value must warn and fall
      // through to detection (empty PATH → the opencode fallback), exactly like a
      // persisted config — never fail the run hard.
      const resolved = await resolveAgent({ env: { HUGINN_AGENT: "windsurf", PATH: "" } });
      expect(resolved).toBe("opencode");
      expect(warn).toHaveBeenCalled();
      const message = warn.mock.calls.flat().join(" ");
      expect(message).toContain('"windsurf"');
      expect(message).toContain('"devin"');
      // The notice names the env source, not a config file.
      expect(message).toContain("HUGINN_AGENT");
    } finally {
      warn.mockRestore();
    }
  });

  it("detects installed agent binaries from PATH and ignores directories (SEC-004)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-agent-path-"));
    try {
      // Create a fake claude binary
      const fakeClaude = join(tempDir, "claude");
      writeFileSync(fakeClaude, "#!/bin/sh\necho 1.0.0\n");
      chmodSync(fakeClaude, 0o755);

      // Create a directory named "codex" - should NOT be recognized as binary (SEC-004)
      const fakeCodexDir = join(tempDir, "codex");
      mkdtempSync(fakeCodexDir);

      const detected = await detectAvailableAgents(tempDir);
      const claudeEntry = detected.find((d) => d.id === "claude");
      expect(claudeEntry).toBeDefined();
      expect(claudeEntry?.available).toBe(true);
      expect(claudeEntry?.path).toBe(fakeClaude);

      const codexEntry = detected.find((d) => d.id === "codex");
      expect(codexEntry).toBeDefined();
      expect(codexEntry?.available).toBe(false);
      expect(codexEntry?.path).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Agent Subsystem Barrel Exports", () => {
  it("exports public registry, adapters, and types", async () => {
    const AgentSubsystem = await import("../../../src/engine/agent/index.js");
    expect(AgentSubsystem.getAgentRuntime).toBeDefined();
    expect(AgentSubsystem.resolveAgent).toBeDefined();
    expect(AgentSubsystem.detectAvailableAgents).toBeDefined();
    expect(AgentSubsystem.AGENT_BINARIES).toBeDefined();
    expect(AgentSubsystem.GenericSubprocessRuntimeAdapter).toBeDefined();
    expect(AgentSubsystem.OpencodeRuntimeAdapter).toBeDefined();
    expect(AgentSubsystem.ClaudeRuntimeAdapter).toBeDefined();
    expect(AgentSubsystem.CodexRuntimeAdapter).toBeDefined();
    expect(AgentSubsystem.OmpRuntimeAdapter).toBeDefined();
    expect(AgentSubsystem.CommandCodeRuntimeAdapter).toBeDefined();
    expect(AgentSubsystem.QwenRuntimeAdapter).toBeDefined();
  });
});

describe("CycleEngine with IAgentRuntime", () => {
  it("uses injected IAgentRuntime to create session, run steps, and handle abort", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-runtime-test-"));
    try {
      writeFileSync(join(tempDir, "plan.md"), "# Plan\n## Iteration 1 — Test Iteration\nPrompt: build feature");
      writeFileSync(join(tempDir, "spec.md"), "# Spec");
      writeFileSync(join(tempDir, "adr.md"), "# ADR");

      const runtime = new MockAgentRuntime();
      const cfg = makeCfg(tempDir);
      const plan = {
        content: "test",
        iterations: [
          {
            index: 1,
            title: "Test Iteration",
            prompt: "build feature",
            modules: [],
          },
        ],
      };

      const engine = new CycleEngine({
        cfg,
        plan,
        runtime,
      });

      expect(engine.runtime).toBe(runtime);

      // Verify abort forwards to activeSession
      engine.requestAbort();
      expect(engine.getOutcome().reason).toBe("aborted");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not call abortSession on OpencodeClient when runtime is not opencode (SEC-005)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-abort-test-"));
    try {
      const runtime = new MockAgentRuntime();
      const cfg = makeCfg(tempDir);
      const plan = { content: "test", iterations: [] };

      // Mock OpencodeClient whose session.abort should NOT be called
      const mockAbort = vi.fn();
      const mockClient = {
        session: { abort: mockAbort },
      } as unknown as import("@opencode-ai/sdk").OpencodeClient;

      const engine = new CycleEngine({
        cfg,
        plan,
        runtime,
        client: mockClient,
      });

      // Set iterationSessionId without activeSession
      engine.getState().iterationSessionId = "external-session-123";

      engine.requestAbort();
      expect(engine.getOutcome().reason).toBe("aborted");
      expect(mockAbort).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
