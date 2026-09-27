import { describe, it, expect, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const adapter = new OpencodeRuntimeAdapter({ port: 4096 });
    expect(adapter.id).toBe("opencode");
    expect(adapter.name).toBe("OpenCode");

    const models = await adapter.getAvailableModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBeDefined();

    const mcp = await adapter.getMcpStatus();
    expect(mcp).toHaveProperty("servers");
    expect(mcp).toHaveProperty("totalTools");
    expect(mcp).toHaveProperty("healthy");
  });

  it("ClaudeRuntimeAdapter conforms to IAgentRuntime and provides Claude models", async () => {
    const adapter = new ClaudeRuntimeAdapter();
    expect(adapter.id).toBe("claude");
    expect(adapter.name).toBe("Claude Code");

    const models = await adapter.getAvailableModels();
    expect(models.some((m) => m.id.includes("claude-3-7-sonnet"))).toBe(true);
    expect(models.some((m) => m.id.includes("claude-opus"))).toBe(true);

    const mcp = await adapter.getMcpStatus();
    expect(Array.isArray(mcp.servers)).toBe(true);
  });

  it("CodexRuntimeAdapter conforms to IAgentRuntime and provides Codex models", async () => {
    const adapter = new CodexRuntimeAdapter();
    expect(adapter.id).toBe("codex");
    expect(adapter.name).toBe("OpenAI Codex CLI");

    const models = await adapter.getAvailableModels();
    expect(models.some((m) => m.id.includes("gpt-5.1-codex"))).toBe(true);
    expect(models.some((m) => m.id.includes("o3-mini"))).toBe(true);

    const mcp = await adapter.getMcpStatus();
    expect(Array.isArray(mcp.servers)).toBe(true);
  });

  it("OmpRuntimeAdapter conforms to IAgentRuntime", async () => {
    const adapter = new OmpRuntimeAdapter();
    expect(adapter.id).toBe("omp");
    expect(adapter.name).toBe("Oh My Pi");

    const models = await adapter.getAvailableModels();
    expect(models.some((m) => m.id.includes("omp/default"))).toBe(true);

    const mcp = await adapter.getMcpStatus();
    expect(Array.isArray(mcp.servers)).toBe(true);
  });

  it("CommandCodeRuntimeAdapter conforms to IAgentRuntime", async () => {
    const adapter = new CommandCodeRuntimeAdapter();
    expect(adapter.id).toBe("commandcode");
    expect(adapter.name).toBe("Command Code");

    const models = await adapter.getAvailableModels();
    expect(models.some((m) => m.id.includes("commandcode/default"))).toBe(true);

    const mcp = await adapter.getMcpStatus();
    expect(Array.isArray(mcp.servers)).toBe(true);
  });

  it("QwenRuntimeAdapter conforms to IAgentRuntime", async () => {
    const adapter = new QwenRuntimeAdapter();
    expect(adapter.id).toBe("qwen");
    expect(adapter.name).toBe("Qwen Code");

    const models = await adapter.getAvailableModels();
    expect(models.some((m) => m.id.includes("qwen-2.5-coder"))).toBe(true);

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

  it("returns default model info when models option is omitted", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "pi",
      name: "Pi Agent",
      command: "pi",
    });
    const models = await adapter.getAvailableModels();
    expect(models).toEqual([
      {
        id: "pi/default",
        name: "Pi Agent Default Model",
        provider: "Pi Agent",
      },
    ]);
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
      expect(mcp.healthy).toBe(true);
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
      const remoteServer = mcp.servers.find((s) => s.id === "remoteserver");
      expect(remoteServer?.transport).toBe("sse");
      expect(mcp.healthy).toBe(true);
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

  it("maps models from client.provider.list()", async () => {
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
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    const models = await adapter.getAvailableModels();
    expect(models).toEqual([
      {
        id: "custom-provider/model-a",
        name: "Model A",
        provider: "Custom Provider",
        description: "Awesome model",
      },
    ]);
  });

  it("falls back to default models when client.provider.list() throws", async () => {
    const mockClient = {
      provider: {
        list: vi.fn().mockRejectedValue(new Error("Network error")),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    const models = await adapter.getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id.includes("claude-opus"))).toBe(true);
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

