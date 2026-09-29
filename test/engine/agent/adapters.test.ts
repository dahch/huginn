import { describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  ClaudeRuntimeAdapter,
  CodexRuntimeAdapter,
  CommandCodeRuntimeAdapter,
  GenericSubprocessRuntimeAdapter,
  OmpRuntimeAdapter,
  OpencodeRuntimeAdapter,
  QwenRuntimeAdapter,
} from "../../../src/engine/agent/adapters/index.js";
import { OpencodeSession } from "../../../src/engine/agent/adapters/opencode.js";

describe("Agent Runtime Adapters Interface Adherence", () => {
  it("OpencodeRuntimeAdapter conforms to IAgentRuntime interface", async () => {
    const mockClient = {
      provider: {
        list: async () => ({
          all: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: { "claude-sonnet-5": { id: "claude-sonnet-5", name: "Claude Sonnet 5" } },
            },
          ],
          default: {},
          connected: ["anthropic"],
        }),
      },
    } as unknown as OpencodeClient;
    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    expect(adapter.id).toBe("opencode");
    expect(adapter.name).toBe("OpenCode");

    const models = await adapter.getAvailableModels();
    expect(models).toEqual([
      {
        id: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        // REV-004: the provider *id*, matching what the CLI fallback reports.
        provider: "anthropic",
        description: undefined,
      },
    ]);

    const mcp = await adapter.getMcpStatus();
    expect(mcp).toHaveProperty("servers");
    expect(mcp).toHaveProperty("totalTools");
    expect(mcp).toHaveProperty("healthy");
  });

  it("ClaudeRuntimeAdapter conforms to IAgentRuntime and reports no catalog (REQ-27)", async () => {
    const adapter = new ClaudeRuntimeAdapter();
    expect(adapter.id).toBe("claude");
    expect(adapter.name).toBe("Claude Code");

    // AC-27.4: the CLI exposes no listing command, so discovery is honestly empty.
    expect(await adapter.getAvailableModels()).toEqual([]);

    const mcp = await adapter.getMcpStatus();
    expect(Array.isArray(mcp.servers)).toBe(true);
  });

  it("CodexRuntimeAdapter conforms to IAgentRuntime and reports no catalog (REQ-27)", async () => {
    const adapter = new CodexRuntimeAdapter();
    expect(adapter.id).toBe("codex");
    expect(adapter.name).toBe("OpenAI Codex CLI");

    expect(await adapter.getAvailableModels()).toEqual([]);

    const mcp = await adapter.getMcpStatus();
    expect(Array.isArray(mcp.servers)).toBe(true);
  });

  it("OmpRuntimeAdapter lists its real catalog through `omp models` (REQ-27 / AC-27.4)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-omp-models-"));
    try {
      // The fake CLI only answers to `omp models`, so this asserts the wired
      // argv as well as the parser wiring.
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

      const adapter = new OmpRuntimeAdapter({ env: { PATH: tempDir } });
      expect(adapter.id).toBe("omp");
      expect(adapter.name).toBe("Oh My Pi");

      expect(await adapter.getAvailableModels()).toEqual([
        {
          id: "deepseek/deepseek-flash",
          name: "deepseek-flash",
          provider: "deepseek",
          description: "context 1M",
        },
      ]);

      const mcp = await adapter.getMcpStatus();
      expect(Array.isArray(mcp.servers)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("CommandCodeRuntimeAdapter conforms to IAgentRuntime and returns [] when the CLI is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-cmdcode-models-absent-"));
    try {
      const adapter = new CommandCodeRuntimeAdapter({ env: { PATH: tempDir } });
      expect(adapter.id).toBe("commandcode");
      expect(adapter.name).toBe("Command Code");

      // AC-27.3: no `commandcode/default` literal; no listing CLI → honest [].
      expect(await adapter.getAvailableModels()).toEqual([]);

      const mcp = await adapter.getMcpStatus();
      expect(Array.isArray(mcp.servers)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("QwenRuntimeAdapter conforms to IAgentRuntime and reports no catalog (REQ-27)", async () => {
    const adapter = new QwenRuntimeAdapter();
    expect(adapter.id).toBe("qwen");
    expect(adapter.name).toBe("Qwen Code");

    expect(await adapter.getAvailableModels()).toEqual([]);

    const mcp = await adapter.getMcpStatus();
    expect(Array.isArray(mcp.servers)).toBe(true);
  });
});

describe("Secondary Binary Fallbacks for CommandCode and Qwen", () => {
  it("CommandCode returns true when primary binary 'commandcode' is present", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-cmdcode-primary-"));
    try {
      const primaryBin = join(tempDir, "commandcode");
      writeFileSync(primaryBin, "#!/bin/sh\nexit 0\n");
      chmodSync(primaryBin, 0o755);

      const adapter = new CommandCodeRuntimeAdapter({
        env: { PATH: tempDir },
      });
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("CommandCode falls back to 'command-code' when 'commandcode' is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-cmdcode-test-"));
    try {
      const fallbackBin = join(tempDir, "command-code");
      writeFileSync(fallbackBin, "#!/bin/sh\nexit 0\n");
      chmodSync(fallbackBin, 0o755);

      const adapter = new CommandCodeRuntimeAdapter({
        env: { PATH: tempDir },
      });
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("CommandCode returns false when neither binary exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-cmdcode-absent-"));
    try {
      const adapter = new CommandCodeRuntimeAdapter({
        env: { PATH: tempDir },
      });
      const available = await adapter.isAvailable();
      expect(available).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Qwen returns true when primary binary 'qwen' is present", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-qwen-primary-"));
    try {
      const primaryBin = join(tempDir, "qwen");
      writeFileSync(primaryBin, "#!/bin/sh\nexit 0\n");
      chmodSync(primaryBin, 0o755);

      const adapter = new QwenRuntimeAdapter({
        env: { PATH: tempDir },
      });
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Qwen falls back to 'qwen-code' when 'qwen' is absent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-qwen-test-"));
    try {
      const fallbackBin = join(tempDir, "qwen-code");
      writeFileSync(fallbackBin, "#!/bin/sh\nexit 0\n");
      chmodSync(fallbackBin, 0o755);

      const adapter = new QwenRuntimeAdapter({
        env: { PATH: tempDir },
      });
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Qwen returns false when neither binary exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-qwen-absent-"));
    try {
      const adapter = new QwenRuntimeAdapter({
        env: { PATH: tempDir },
      });
      const available = await adapter.isAvailable();
      expect(available).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("GenericSubprocessRuntimeAdapter & Session Execution", () => {
  it("executes prompt via subprocess stdio and captures output", async () => {
    // We use node -e "console.log(...)" as a portable command test
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: [
        "-e",
        "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => console.log('Result from agent:', d));",
      ],
    });

    const session = await adapter.createSession({ title: "Test Session" });
    expect(session.id).toBeDefined();

    const result = await session.prompt("hello world");
    expect(result.text).toContain("Result from agent: hello world");
    expect(result.messageId).toBeDefined();
  });

  it("executes runCommand translated into prompt", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: [
        "-e",
        "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => console.log('Executed:', d));",
      ],
    });

    const session = await adapter.createSession({ title: "Command Session" });
    const result = await session.runCommand?.("validate-step", "arg1 arg2");
    expect(result?.text).toContain("Executed: /validate-step arg1 arg2");
  });

  it("handles timeout in GenericSubprocessSession", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: ["-e", "setTimeout(() => console.log('done'), 5000);"],
    });

    const session = await adapter.createSession({ title: "Timeout Session" });
    await expect(session.prompt("wait", { timeoutMs: 100 })).rejects.toThrow("timed out");
  });

  it("handles abort in GenericSubprocessSession", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: ["-e", "setTimeout(() => console.log('done'), 5000);"],
    });

    const session = await adapter.createSession({ title: "Abort Session" });
    const promptPromise = session.prompt("wait", { timeoutMs: 5000 });
    await session.abort();
    // Subsequent calls immediately fail
    await expect(session.prompt("another")).rejects.toThrow("aborted");
    // Ensure active process doesn't hang the test
    try {
      await promptPromise;
    } catch {
      // Expected rejection or abort
    }
  });

  it("does not pass prompt in argv when streaming via stdin (SEC-002)", async () => {
    // Check that process.argv does not contain the prompt text
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: [
        "-e",
        "console.log('ARGV_LENGTH=' + process.argv.length); let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => console.log('STDIN=' + d));",
      ],
    });

    const session = await adapter.createSession({ title: "Argv Check Session" });
    const result = await session.prompt("super_secret_prompt_text");
    expect(result.text).toContain("ARGV_LENGTH=1"); // only [node]
    expect(result.text).toContain("STDIN=super_secret_prompt_text");
  });

  it("enforces max argument length and adds '--' delimiter when promptViaStdin is false (SEC-002)", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: ["-e", "console.log(process.argv.slice(1).join(' '));"],
      promptViaStdin: false,
      maxPromptArgLength: 50,
    });

    const session = await adapter.createSession({ title: "Arg Session" });
    // With '--' delimiter, the option parser does not treat -flag-like-prompt as a CLI flag
    const result = await session.prompt("-flag-like-prompt");
    expect(result.text).toContain("-flag-like-prompt");

    // Exceeding maxPromptArgLength throws
    const longPrompt = "a".repeat(60);
    await expect(session.prompt(longPrompt)).rejects.toThrow(/exceeds maximum command line argument limit/);
  });

  it("does not duplicate '--' when base args already include '--' (promptViaStdin=false)", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)));", "--"],
      promptViaStdin: false,
    });
    const session = await adapter.createSession({ title: "Existing Delimiter" });
    const result = await session.prompt("hello-arg");
    expect(result.text).toBe(JSON.stringify(["hello-arg"]));
  });

  it("accepts prompt exactly at maxPromptArgLength limit (promptViaStdin=false)", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: process.execPath,
      args: ["-e", "console.log(process.argv.slice(1).join(' '));"],
      promptViaStdin: false,
      maxPromptArgLength: 10,
    });
    const session = await adapter.createSession({ title: "Exact Limit" });
    const result = await session.prompt("1234567890");
    expect(result.text).toContain("1234567890");
  });

  it("rejects prompt when execution child process fails to spawn", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: "__non_existent_binary_for_test_12345__",
    });
    const session = await adapter.createSession({ title: "Spawn Failure" });
    await expect(session.prompt("test")).rejects.toThrow();
  });

  it("bounds output accumulation to 10MB to prevent memory DoS (SEC-003)", async () => {
    // Generate 12MB of output
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "pi",
      command: process.execPath,
      args: [
        "-e",
        "const chunk = 'x'.repeat(1024 * 1024); for (let i = 0; i < 12; i++) { process.stdout.write(chunk); }",
      ],
    });

    const session = await adapter.createSession({ title: "DoS test" });
    const result = await session.prompt("go");
    expect(result.raw.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it("returns an empty catalog when neither models nor modelListCommand is provided (REQ-27)", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: "pi",
    });
    const models = await adapter.getAvailableModels();
    expect(models).toEqual([]);
  });

  it("parses TOML MCP server definitions correctly", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-toml-"));
    try {
      const codexDir = join(tempDir, ".codex");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        join(codexDir, "config.toml"),
        `[mcp_servers.sqlite]\ncommand = "uvx"\n[mcp_servers.github]\ntransport = "stdio"\n`,
      );
      const adapter = new GenericSubprocessRuntimeAdapter({
        id: "codex",
        name: "OpenAI Codex CLI",
        command: "codex",
        homeDir: tempDir,
      });
      const mcp = await adapter.getMcpStatus();
      expect(mcp.servers).toHaveLength(2);
      expect(mcp.servers.map((s) => s.id).sort()).toEqual(["github", "sqlite"]);
      // AC-30.1: a TOML declaration is configuration, not liveness.
      expect(mcp.servers.every((s) => s.status === "unknown")).toBe(true);
      expect(mcp.healthy).toBe(false);
      expect(mcp.unverified).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses JSON MCP server definitions with tools count and transports", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-json-"));
    try {
      writeFileSync(
        join(tempDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            toolserver: {
              command: "node",
              tools: [{ name: "t1" }, { name: "t2" }],
            },
            remoteserver: {
              transport: "sse",
            },
          },
        }),
      );
      const adapter = new GenericSubprocessRuntimeAdapter({
        id: "claude",
        name: "Claude Code",
        command: "claude",
        projectPath: tempDir,
        homeDir: tempDir,
      });
      const mcp = await adapter.getMcpStatus();
      expect(mcp.servers.length).toBeGreaterThanOrEqual(2);
      const toolServer = mcp.servers.find((s) => s.id === "toolserver");
      expect(toolServer?.transport).toBe("stdio");
      expect(toolServer?.toolsCount).toBe(2);
      // AC-30.1: discovered in a config file ⇒ unverified, never "connected".
      expect(toolServer?.status).toBe("unknown");
      const remoteServer = mcp.servers.find((s) => s.id === "remoteserver");
      expect(remoteServer?.transport).toBe("sse");
      expect(remoteServer?.status).toBe("unknown");
      expect(mcp.healthy).toBe(false);
      expect(mcp.unverified).toBe(true);
      expect(mcp.degraded).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles malformed MCP configuration files gracefully", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-err-"));
    try {
      writeFileSync(join(tempDir, ".mcp.json"), "{ malformed JSON content !");
      const adapter = new GenericSubprocessRuntimeAdapter({
        id: "claude",
        name: "Claude Code",
        command: "claude",
        projectPath: tempDir,
        homeDir: tempDir,
      });
      const mcp = await adapter.getMcpStatus();
      expect(mcp.healthy).toBe(false);
      expect(mcp.servers.some((s) => s.status === "error")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("isAvailable ignores directories in PATH with command name (SEC-004)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-generic-path-"));
    try {
      const dirNamedCmd = join(tempDir, "my-cmd");
      mkdtempSync(dirNamedCmd);

      const adapter = new GenericSubprocessRuntimeAdapter({
        id: "pi",
        name: "pi",
        command: "my-cmd",
        env: { PATH: tempDir },
      });

      const available = await adapter.isAvailable();
      expect(available).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OpencodeRuntimeAdapter and OpencodeSession", () => {
  it("reports isAvailable=true when injected client is provided", async () => {
    const mockClient = {} as unknown as OpencodeClient;
    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    expect(await adapter.isAvailable()).toBe(true);
  });

  it("checks PATH for opencode binary when client is omitted", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-opencode-path-"));
    try {
      // 1. Without opencode binary in PATH
      const origPath = process.env.PATH;
      process.env.PATH = tempDir;
      try {
        const adapterAbsent = new OpencodeRuntimeAdapter();
        expect(await adapterAbsent.isAvailable()).toBe(false);

        // 2. With opencode binary in PATH
        const fakeOpencode = join(tempDir, "opencode");
        writeFileSync(fakeOpencode, "#!/bin/sh\nexit 0\n");
        chmodSync(fakeOpencode, 0o755);

        const adapterPresent = new OpencodeRuntimeAdapter();
        expect(await adapterPresent.isAvailable()).toBe(true);
      } finally {
        process.env.PATH = origPath;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("maps models from client.provider.list() for connected providers only (AC-27.1)", async () => {
    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          all: [
            {
              id: "custom-provider",
              name: "Custom Provider",
              models: {
                "model-a": { name: "Model A", description: "Awesome model" },
              },
            },
            {
              id: "catalog-only",
              name: "Catalog Only",
              models: {
                "model-b": { name: "Model B" },
              },
            },
          ],
          default: {},
          connected: ["custom-provider"],
        }),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    const models = await adapter.getAvailableModels();
    expect(models).toEqual([
      {
        id: "custom-provider/model-a",
        name: "Model A",
        provider: "custom-provider",
        description: "Awesome model",
      },
    ]);
  });

  it("falls back to parsing `opencode models` when client.provider.list() throws (AC-27.2)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-opencode-fallback-"));
    try {
      const fakeBin = join(tempDir, "opencode");
      writeFileSync(
        fakeBin,
        `#!/bin/sh\nprintf 'anthropic/claude-sonnet-5\\nfireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash\\n\\nnoise line\\n'\n`,
      );
      chmodSync(fakeBin, 0o755);

      const mockClient = {
        provider: {
          list: vi.fn().mockRejectedValue(new Error("Network error")),
        },
      } as unknown as OpencodeClient;

      const adapter = new OpencodeRuntimeAdapter({
        client: mockClient,
        modelsCommand: fakeBin,
      });
      const models = await adapter.getAvailableModels();
      expect(models).toEqual([
        { id: "anthropic/claude-sonnet-5", name: "claude-sonnet-5", provider: "anthropic" },
        {
          id: "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
          name: "deepseek-v4p1-flash",
          provider: "fireworks-ai",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns [] (never fakes) when both SDK and CLI discovery fail (AC-27.2)", async () => {
    const mockClient = {
      provider: {
        list: vi.fn().mockRejectedValue(new Error("Network error")),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({
      client: mockClient,
      modelsCommand: "__huginn_missing_opencode_binary__",
    });
    expect(await adapter.getAvailableModels()).toEqual([]);
  });

  it("falls back to the CLI when the connected set is empty (AC-27.2)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-opencode-empty-connected-"));
    try {
      const fakeBin = join(tempDir, "opencode");
      writeFileSync(fakeBin, `#!/bin/sh\nprintf 'deepseek/deepseek-v4-pro\\n'\n`);
      chmodSync(fakeBin, 0o755);

      const mockClient = {
        provider: {
          list: vi.fn().mockResolvedValue({
            all: [
              {
                id: "deepinfra",
                name: "DeepInfra",
                models: { "deepinfra-model": { name: "DeepInfra Model" } },
              },
            ],
            default: {},
            connected: [],
          }),
        },
      } as unknown as OpencodeClient;

      const adapter = new OpencodeRuntimeAdapter({
        client: mockClient,
        modelsCommand: fakeBin,
      });
      const models = await adapter.getAvailableModels();
      expect(models).toEqual([
        { id: "deepseek/deepseek-v4-pro", name: "deepseek-v4-pro", provider: "deepseek" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("maps MCP status from client.mcp.status()", async () => {
    const mockClient = {
      mcp: {
        status: vi.fn().mockResolvedValue({
          server1: { status: "connected" },
          server2: { status: "failed", error: "Connection refused" },
        }),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    const mcp = await adapter.getMcpStatus();
    expect(mcp.healthy).toBe(false);
    expect(mcp.servers).toHaveLength(2);
    expect(mcp.servers.find((s) => s.id === "server1")?.status).toBe("connected");
    expect(mcp.servers.find((s) => s.id === "server2")?.status).toBe("error");
  });

  it("returns empty MCP report when client.mcp.status() throws", async () => {
    const mockClient = {
      mcp: {
        status: vi.fn().mockRejectedValue(new Error("MCP offline")),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    const mcp = await adapter.getMcpStatus();
    expect(mcp.healthy).toBe(false);
    expect(mcp.servers).toHaveLength(0);
    // AC-30.2: a throwing probe must be distinguishable from "nothing configured".
    expect(mcp.degraded).toBe(true);
    expect(mcp.error).toBe("MCP offline");
  });

  it("manages daemon lifecycle gracefully", async () => {
    const adapter = new OpencodeRuntimeAdapter();
    const closeFn = vi.fn().mockResolvedValue(undefined);
    (adapter as any).serverHandle = { url: "http://127.0.0.1:9999", close: closeFn };

    // startDaemon early returns when handle already exists
    await adapter.startDaemon();
    expect(closeFn).not.toHaveBeenCalled();

    // stopDaemon closes and clears the handle
    await adapter.stopDaemon();
    expect(closeFn).toHaveBeenCalled();
    expect((adapter as any).serverHandle).toBeUndefined();

    // second stopDaemon is a noop
    await adapter.stopDaemon();
  });

  it("creates session and executes prompt, runCommand, and abort via OpencodeSession", async () => {
    const mockPrompt = vi.fn().mockResolvedValue({
      info: { id: "msg-prompt-1" },
      parts: [{ type: "text", text: "agent response" }],
    });
    const mockCommand = vi.fn().mockResolvedValue({
      info: { id: "cmd-1" },
      parts: [{ type: "text", text: "command output" }],
    });
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockCreate = vi.fn().mockResolvedValue({ id: "created-session-123" });

    const mockClient = {
      session: {
        create: mockCreate,
        prompt: mockPrompt,
        command: mockCommand,
        abort: mockAbort,
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    const session = await adapter.createSession({ title: "My Opencode Session", directory: "/custom/dir" });
    expect(session.id).toBe("created-session-123");
    expect(mockCreate).toHaveBeenCalledWith({
      body: { title: "My Opencode Session" },
      query: { directory: "/custom/dir" },
    });

    // Prompt with slash model
    const res1 = await session.prompt("build code", { model: "anthropic/claude-3-7-sonnet" });
    expect(res1.text).toBe("agent response");
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "created-session-123" },
        body: expect.objectContaining({
          model: { providerID: "anthropic", modelID: "claude-3-7-sonnet" },
        }),
      }),
    );

    // Prompt with non-slash model
    await session.prompt("build code 2", { model: "custom-model" });
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: "default", modelID: "custom-model" },
        }),
      }),
    );

    // RunCommand
    const cmdRes = await session.runCommand?.("test-cmd", "arg1 arg2");
    expect(cmdRes?.text).toBe("command output");
    expect(mockCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "created-session-123" },
        body: expect.objectContaining({
          command: "test-cmd",
          arguments: "arg1 arg2",
        }),
      }),
    );

    // Abort
    await session.abort();
    expect(mockAbort).toHaveBeenCalledWith({ path: { id: "created-session-123" } });
  });
});

describe("REV-3A-001 · promptFileFlag keeps oversized prompts off argv", () => {
  /**
   * A fake CLI that reads the `--prompt-file` it was handed, reports the file's
   * byte-length and mode, and (optionally) hangs so a timeout path can be
   * exercised — so a failure proves the *mechanism* (temp file written, flag +
   * path in argv, content intact, file removed), not just an internal field.
   *
   * `--` after `-e <script>` stops node from parsing the runtime's own flags
   * (`--prompt-file …`) as its options.
   */
  const READER = [
    "const fs = require('node:fs');",
    "const i = process.argv.indexOf('--prompt-file');",
    "const p = process.argv[i + 1];",
    "fs.writeFileSync(process.env.HUGINN_PROMPT_CAPTURE, p);",
    "const st = fs.statSync(p);",
    "const text = fs.readFileSync(p, 'utf8');",
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), path: p, len: text.length, head: text.slice(0, 8), mode: (st.mode & 0o777).toString(8) }));",
    "if (process.env.HUGINN_PROMPT_HANG === '1') setTimeout(() => {}, 10000);",
  ].join("\n");

  it("writes a 200 KB prompt to a 0600 temp file, passes --prompt-file <path>, and removes it", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-prompt-capture-"));
    try {
      const capture = join(tempDir, "path.txt");
      const adapter = new GenericSubprocessRuntimeAdapter({
        id: "devin",
        name: "Devin",
        command: process.execPath,
        args: ["-e", READER, "--"],
        promptViaStdin: false,
        promptFileFlag: "--prompt-file",
        env: { HUGINN_PROMPT_CAPTURE: capture },
      });

      const prompt = "P".repeat(200 * 1024); // 200 KB — far beyond the 4096 positional cap
      const session = await adapter.createSession({ title: "long prompt" });
      const result = await session.prompt(prompt);
      const info = JSON.parse(result.text) as {
        argv: string[];
        path: string;
        len: number;
        head: string;
        mode: string;
      };

      // The flag + a private temp path are on the argv; the prompt text never is.
      expect(info.argv).toEqual(["--prompt-file", info.path]);
      expect(info.argv).not.toContain(prompt);
      expect(info.path.startsWith(join(tmpdir(), "huginn-prompt-"))).toBe(true);
      // Written 0600 (owner-only) so the embedded spec/ADR/plan is not world-readable.
      expect(info.mode).toBe("600");
      // The CLI read back exactly what huginn wrote — no truncation at any limit.
      expect(info.len).toBe(prompt.length);
      expect(info.head).toBe("P".repeat(8));

      // The temp file is gone once the prompt settled.
      expect(existsSync(info.path)).toBe(false);
      expect(existsSync(readFileSync(capture, "utf8"))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("removes the temp file when the prompt times out", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-prompt-timeout-"));
    try {
      const capture = join(tempDir, "path.txt");
      const adapter = new GenericSubprocessRuntimeAdapter({
        id: "devin",
        name: "Devin",
        command: process.execPath,
        args: ["-e", READER, "--"],
        promptViaStdin: false,
        promptFileFlag: "--prompt-file",
        env: { HUGINN_PROMPT_CAPTURE: capture, HUGINN_PROMPT_HANG: "1" },
      });

      const session = await adapter.createSession({ title: "hanging prompt" });
      await expect(session.prompt("x".repeat(5000), { timeoutMs: 1500 })).rejects.toThrow(/timed out/);

      const path = readFileSync(capture, "utf8");
      expect(path.startsWith(join(tmpdir(), "huginn-prompt-"))).toBe(true);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the positional 4096 cap when no promptFileFlag is configured", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi",
      command: process.execPath,
      args: ["-e", "0", "--"],
      promptViaStdin: false,
      maxPromptArgLength: 50,
    });
    const session = await adapter.createSession({ title: "no file flag" });
    await expect(session.prompt("a".repeat(60))).rejects.toThrow(
      /exceeds maximum command line argument limit/,
    );
  });
});

