import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, McpStatusReport } from "../../../src/engine/agent/types.js";
import { fetchMcpStatusWithTimeout, formatMcpBadge } from "../../../src/engine/agent/mcpStatus.js";
import {
  isReservedKey,
  loadProjectMcpConfig,
  parseMcpServerEntry,
  sanitizeTerminalText,
} from "../../../src/engine/agent/mcpConfig.js";
import { GenericSubprocessRuntimeAdapter } from "../../../src/engine/agent/adapters/generic.js";

function createMockRuntime(opts: {
  delayMs?: number;
  report?: McpStatusReport;
  shouldThrow?: boolean;
}): IAgentRuntime {
  return {
    id: "opencode",
    name: "OpenCode",
    isAvailable: async () => true,
    getAvailableModels: async () => [],
    getMcpStatus: async () => {
      if (opts.shouldThrow) {
        throw new Error("MCP provider connection failure");
      }
      if (opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      return (
        opts.report ?? {
          servers: [
            {
              id: "muninn",
              name: "muninn",
              status: "connected",
              transport: "stdio",
              toolsCount: 5,
              tools: [
                { name: "memory_search", description: "Search memory" },
                { name: "memory_save", description: "Save memory" },
              ],
            },
          ],
          totalTools: 5,
          healthy: true,
        }
      );
    },
    createSession: async () => ({} as any),
  };
}

describe("MCP Status & Timeout Helper (AC-24.1, ADR-24)", () => {
  it("resolves quickly when runtime.getMcpStatus is responsive", async () => {
    const runtime = createMockRuntime({ delayMs: 10 });
    const report = await fetchMcpStatusWithTimeout(runtime, 1500);

    expect(report.healthy).toBe(true);
    expect(report.degraded).toBeFalsy();
    expect(report.servers).toHaveLength(1);
    expect(report.servers[0]!.name).toBe("muninn");
    expect(report.totalTools).toBe(5);
  });

  it("enforces strict non-blocking timeout via Promise.race when MCP hangs", async () => {
    // 2000ms delay exceeds 100ms timeout
    const runtime = createMockRuntime({ delayMs: 2000 });
    const start = Date.now();
    const report = await fetchMcpStatusWithTimeout(runtime, 100);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1000);
    expect(report.healthy).toBe(false);
    expect(report.degraded).toBe(true);
    expect(report.error).toContain("timed out after 100ms");
    expect(report.servers).toHaveLength(0);
    expect(report.totalTools).toBe(0);
  });

  it("handles runtime errors gracefully without throwing", async () => {
    const runtime = createMockRuntime({ shouldThrow: true });
    const report = await fetchMcpStatusWithTimeout(runtime, 1500);

    expect(report.healthy).toBe(false);
    expect(report.degraded).toBe(true);
    expect(report.error).toBe("MCP provider connection failure");
    expect(report.servers).toHaveLength(0);
  });

  it("marks report degraded when any server has status error without mutating original", async () => {
    const originalReport: McpStatusReport = {
      servers: [
        {
          id: "broken-server",
          name: "broken-server",
          status: "error",
          transport: "stdio",
          toolsCount: 0,
          error: "Failed to start binary",
        },
      ],
      totalTools: 0,
      healthy: false,
    };
    const runtime = createMockRuntime({
      report: originalReport,
    });

    const report = await fetchMcpStatusWithTimeout(runtime, 1500);
    expect(report.healthy).toBe(false);
    expect(report.degraded).toBe(true);
    expect(originalReport.degraded).toBeUndefined();
    expect(report).not.toBe(originalReport);
  });

  it("formats header badges correctly for active, degraded, timeout, and empty states", () => {
    expect(formatMcpBadge(null)).toEqual({
      text: "MCP: ⚪ 0 active",
      color: "gray",
    });

    expect(
      formatMcpBadge({
        servers: [],
        totalTools: 0,
        healthy: false,
      }),
    ).toEqual({
      text: "MCP: ⚪ 0 active",
      color: "gray",
    });

    expect(
      formatMcpBadge({
        servers: [
          {
            id: "muninn",
            name: "muninn",
            status: "connected",
            transport: "stdio",
            toolsCount: 8,
          },
        ],
        totalTools: 8,
        healthy: true,
      }),
    ).toEqual({
      text: "MCP: 🟢 1 active (8 tools)",
      color: "green",
    });

    expect(
      formatMcpBadge({
        servers: [],
        totalTools: 0,
        healthy: false,
        degraded: true,
        error: "MCP status timed out after 1500ms",
      }),
    ).toEqual({
      text: "MCP: 🟡 timeout",
      color: "yellow",
    });

    expect(
      formatMcpBadge({
        servers: [
          {
            id: "err",
            name: "err",
            status: "error",
            transport: "stdio",
            toolsCount: 0,
          },
        ],
        totalTools: 0,
        healthy: false,
        degraded: true,
      }),
    ).toEqual({
      text: "MCP: 🟡 degraded",
      color: "yellow",
    });

    // undefined report
    expect(formatMcpBadge(undefined)).toEqual({
      text: "MCP: ⚪ 0 active",
      color: "gray",
    });

    // healthy: false with server error but degraded is undefined/false and no error message
    expect(
      formatMcpBadge({
        servers: [
          {
            id: "err2",
            name: "err2",
            status: "error",
            transport: "stdio",
            toolsCount: 0,
          },
        ],
        totalTools: 0,
        healthy: false,
      }),
    ).toEqual({
      text: "MCP: 🟡 degraded",
      color: "yellow",
    });

    // report with "timeout" in error
    expect(
      formatMcpBadge({
        servers: [],
        totalTools: 0,
        healthy: false,
        degraded: true,
        error: "Connection timeout occurred",
      }),
    ).toEqual({
      text: "MCP: 🟡 timeout",
      color: "yellow",
    });

    // disconnected servers only (activeCount = 0)
    expect(
      formatMcpBadge({
        servers: [
          {
            id: "offline",
            name: "offline",
            status: "disconnected",
            transport: "stdio",
            toolsCount: 0,
          },
        ],
        totalTools: 0,
        healthy: true,
      }),
    ).toEqual({
      text: "MCP: ⚪ 0 active",
      color: "gray",
    });
  });

  it("handles non-Error thrown values in fetchMcpStatusWithTimeout", async () => {
    const runtime: IAgentRuntime = {
      id: "raw-throw",
      name: "Raw Throw",
      isAvailable: async () => true,
      getAvailableModels: async () => [],
      getMcpStatus: async () => {
        throw "string error message";
      },
      createSession: async () => ({} as any),
    };

    const report = await fetchMcpStatusWithTimeout(runtime, 500);
    expect(report.healthy).toBe(false);
    expect(report.degraded).toBe(true);
    expect(report.error).toBe("string error message");
  });

  it("uses default timeout parameter (1500ms) when timeoutMs is omitted", async () => {
    const runtime = createMockRuntime({ delayMs: 10 });
    const report = await fetchMcpStatusWithTimeout(runtime);
    expect(report.healthy).toBe(true);
  });

  it("handles timeout exceeding 1500ms with default timeout parameter", async () => {
    const runtime = createMockRuntime({ delayMs: 2500 });
    // Use smaller timeout for fast test execution
    const report = await fetchMcpStatusWithTimeout(runtime, 50);
    expect(report.healthy).toBe(false);
    expect(report.degraded).toBe(true);
    expect(report.error).toContain("timed out after 50ms");
  });
});

describe("Project-level .huginn/mcp.json parsing (AC-24.3)", () => {
  it("returns null when .huginn/mcp.json does not exist", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-none-"));
    try {
      expect(loadProjectMcpConfig(tempDir)).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses valid .huginn/mcp.json configuration file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-cfg-"));
    try {
      const huginnDir = join(tempDir, ".huginn");
      mkdirSync(huginnDir, { recursive: true });
      writeFileSync(
        join(huginnDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
              tools: [
                { name: "read_file", description: "Read file contents" },
                { name: "write_file", description: "Write file contents" },
              ],
            },
          },
        }),
      );

      const config = loadProjectMcpConfig(tempDir);
      expect(config).not.toBeNull();
      expect(config?.mcpServers?.filesystem).toBeDefined();
      expect(config?.mcpServers?.filesystem?.command).toBe("npx");
      expect(config?.mcpServers?.filesystem?.tools).toHaveLength(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("GenericSubprocessRuntimeAdapter integrates .huginn/mcp.json servers and tool details", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-adapter-"));
    try {
      const huginnDir = join(tempDir, ".huginn");
      mkdirSync(huginnDir, { recursive: true });
      writeFileSync(
        join(huginnDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            custom_db: {
              command: "node",
              args: ["./db-server.js"],
              latencyMs: 12,
              tools: [
                { name: "query", description: "Execute SQL query" },
                { name: "schema", description: "Get database schema" },
              ],
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

      const report = await adapter.getMcpStatus();
      expect(report.healthy).toBe(true);
      const customDb = report.servers.find((s) => s.id === "custom_db");
      expect(customDb).toBeDefined();
      expect(customDb?.status).toBe("connected");
      expect(customDb?.transport).toBe("stdio");
      expect(customDb?.toolsCount).toBe(2);
      expect(customDb?.latencyMs).toBe(12);
      expect(customDb?.tools).toEqual([
        { name: "query", description: "Execute SQL query" },
        { name: "schema", description: "Get database schema" },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("File size limits (SEC-002)", () => {
    it("rejects .huginn/mcp.json exceeding 1MB limit and returns null", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-size-"));
      try {
        const huginnDir = join(tempDir, ".huginn");
        mkdirSync(huginnDir, { recursive: true });
        const filePath = join(huginnDir, "mcp.json");
        // Create file larger than 1MB (1024 * 1024 + 1 bytes)
        const largeContent = Buffer.alloc(1024 * 1024 + 10, " ");
        writeFileSync(filePath, largeContent);

        const config = loadProjectMcpConfig(tempDir);
        expect(config).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects .huginn/mcp.json when it is a directory instead of a regular file", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-dir-"));
      try {
        const fakeFilePath = join(tempDir, ".huginn", "mcp.json");
        mkdirSync(fakeFilePath, { recursive: true });

        const config = loadProjectMcpConfig(tempDir);
        expect(config).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("Prototype pollution key filtering (SEC-003)", () => {
    it("filters out __proto__, constructor, and prototype from .huginn/mcp.json", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-proto-"));
      try {
        const huginnDir = join(tempDir, ".huginn");
        mkdirSync(huginnDir, { recursive: true });
        writeFileSync(
          join(huginnDir, "mcp.json"),
          JSON.stringify({
            __proto__: { polluted: true },
            constructor: { evil: true },
            prototype: { evil: true },
            mcpServers: {
              __proto__: { command: "evil-cmd" },
              constructor: { command: "evil-cmd" },
              prototype: { command: "evil-cmd" },
              legit_server: {
                command: "node",
                args: ["./server.js"],
              },
            },
          }),
        );

        const config = loadProjectMcpConfig(tempDir);
        expect(config).not.toBeNull();
        expect(config?.mcpServers?.legit_server).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(config ?? {}, "__proto__")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(config ?? {}, "constructor")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(config ?? {}, "prototype")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(config?.mcpServers ?? {}, "__proto__")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(config?.mcpServers ?? {}, "constructor")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(config?.mcpServers ?? {}, "prototype")).toBe(false);
        expect(({} as any).polluted).toBeUndefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("filters reserved keys from tools list in parseMcpServerEntry", () => {
      const entry = parseMcpServerEntry("safe_server", {
        command: "node",
        tools: [
          "__proto__",
          "constructor",
          "prototype",
          { name: "__proto__", description: "evil" },
          { name: "constructor", description: "evil" },
          { name: "prototype", description: "evil" },
          { name: "valid_tool", description: "normal tool" },
        ],
      });

      expect(entry.toolsCount).toBe(1);
      expect(entry.tools).toEqual([
        { name: "valid_tool", description: "normal tool" },
      ]);
    });

    it("identifies reserved keys correctly via isReservedKey", () => {
      expect(isReservedKey("__proto__")).toBe(true);
      expect(isReservedKey("constructor")).toBe(true);
      expect(isReservedKey("prototype")).toBe(true);
      expect(isReservedKey("valid_server")).toBe(false);
      expect(isReservedKey("tools")).toBe(false);
    });
  });

  describe("ANSI escape sequence sanitization (SEC-001)", () => {
    it("strips ANSI color, style, and control sequences from terminal text", () => {
      const raw = "\u001b[31;1mRed Alert\u001b[0m\u001b[2K\u001b[1GNormal Text";
      expect(sanitizeTerminalText(raw)).toBe("Red AlertNormal Text");
    });

    it("strips non-printable control characters while preserving tab and newline", () => {
      const raw = "Line 1\nLine 2\tTabbed\x00\x08\x0B\x0C\x0E\x1F\x7FEnd";
      expect(sanitizeTerminalText(raw)).toBe("Line 1\nLine 2\tTabbedEnd");
    });

    it("handles non-string inputs safely", () => {
      expect(sanitizeTerminalText(undefined as any)).toBe("");
      expect(sanitizeTerminalText(null as any)).toBe("");
      expect(sanitizeTerminalText(12345 as any)).toBe("");
      expect(sanitizeTerminalText(true as any)).toBe("");
      expect(sanitizeTerminalText({} as any)).toBe("");
    });

    it("sanitizes server name, tool metadata, and error message in parseMcpServerEntry", () => {
      const entry = parseMcpServerEntry("\u001b[31mInjectedServer\u001b[0m", {
        transport: "\u001b[32mstdio\u001b[0m",
        status: "error",
        error: "\u001b[35mCritical Error\x07\u001b[0m",
        tools: [
          {
            name: "\u001b[33mexploitative_tool\u001b[0m",
            description: "A tool with \u001b[2Kescapes\x00 and control chars",
          },
        ],
      });

      expect(entry.name).toBe("InjectedServer");
      expect(entry.id).toBe("InjectedServer");
      expect(entry.transport).toBe("stdio");
      expect(entry.error).toBe("Critical Error");
      expect(entry.tools[0]?.name).toBe("exploitative_tool");
      expect(entry.tools[0]?.description).toBe("A tool with escapes and control chars");
    });
  });

  describe("loadProjectMcpConfig & parseMcpServerEntry edge cases", () => {
    it("throws SyntaxError when .huginn/mcp.json contains malformed JSON", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-malformed-"));
      try {
        const huginnDir = join(tempDir, ".huginn");
        mkdirSync(huginnDir, { recursive: true });
        writeFileSync(join(huginnDir, "mcp.json"), "{ invalid: json");
        expect(() => loadProjectMcpConfig(tempDir)).toThrow(SyntaxError);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("GenericSubprocessRuntimeAdapter creates error server entry when .huginn/mcp.json is malformed", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-badjson-"));
      try {
        const huginnDir = join(tempDir, ".huginn");
        mkdirSync(huginnDir, { recursive: true });
        writeFileSync(join(huginnDir, "mcp.json"), "{ broken json");
        const adapter = new GenericSubprocessRuntimeAdapter({
          id: "claude",
          name: "Claude Code",
          command: "claude",
          projectPath: tempDir,
          homeDir: tempDir,
        });
        const report = await adapter.getMcpStatus();
        expect(report.servers.some((s) => s.status === "error" && s.name === ".huginn/mcp.json")).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("returns null when .huginn/mcp.json parses to an array or primitive", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-primitive-"));
      try {
        const huginnDir = join(tempDir, ".huginn");
        mkdirSync(huginnDir, { recursive: true });
        writeFileSync(join(huginnDir, "mcp.json"), JSON.stringify(["not", "an", "object"]));
        expect(loadProjectMcpConfig(tempDir)).toBeNull();

        writeFileSync(join(huginnDir, "mcp.json"), JSON.stringify("a plain string"));
        expect(loadProjectMcpConfig(tempDir)).toBeNull();

        writeFileSync(join(huginnDir, "mcp.json"), JSON.stringify(12345));
        expect(loadProjectMcpConfig(tempDir)).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("parses alternative sections 'mcp' and 'servers' and preserves top-level metadata", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-alt-"));
      try {
        const huginnDir = join(tempDir, ".huginn");
        mkdirSync(huginnDir, { recursive: true });
        writeFileSync(
          join(huginnDir, "mcp.json"),
          JSON.stringify({
            version: "1.0",
            mcp: {
              serverA: { command: "node", args: ["./a.js"] },
            },
            servers: {
              serverB: { url: "http://localhost:3000/sse" },
            },
          }),
        );
        const config = loadProjectMcpConfig(tempDir);
        expect(config).not.toBeNull();
        expect(config?.version).toBe("1.0");
        expect(config?.mcp?.serverA?.command).toBe("node");
        expect(config?.servers?.serverB?.url).toBe("http://localhost:3000/sse");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("handles null or non-object entry in parseMcpServerEntry", () => {
      const entryNull = parseMcpServerEntry("null_srv", null);
      expect(entryNull.name).toBe("null_srv");
      expect(entryNull.status).toBe("connected");
      expect(entryNull.transport).toBe("stdio");
      expect(entryNull.toolsCount).toBe(0);
      expect(entryNull.tools).toEqual([]);

      const entryStr = parseMcpServerEntry("str_srv", "invalid");
      expect(entryStr.name).toBe("str_srv");
      expect(entryStr.toolsCount).toBe(0);
    });

    it("handles disconnected servers, error servers, and servers with no tools", () => {
      const entryDisconnected = parseMcpServerEntry("offline", {
        status: "disconnected",
        url: "http://localhost:8080/sse",
      });
      expect(entryDisconnected.status).toBe("disconnected");
      expect(entryDisconnected.transport).toBe("sse");
      expect(entryDisconnected.toolsCount).toBe(0);

      const entryError = parseMcpServerEntry("failed", {
        status: "error",
        error: "Subprocess crashed",
      });
      expect(entryError.status).toBe("error");
      expect(entryError.error).toBe("Subprocess crashed");

      const entryNoTools = parseMcpServerEntry("empty", {
        command: "bin",
        tools: [],
      });
      expect(entryNoTools.toolsCount).toBe(0);
      expect(entryNoTools.tools).toEqual([]);
    });

    it("handles tools array with mixed types including primitives", () => {
      const entry = parseMcpServerEntry("mixed_tools", {
        tools: [
          42,
          true,
          { name: "good_tool", description: "desc" },
          { name: "no_desc_tool" },
        ],
      });
      expect(entry.toolsCount).toBe(4);
      expect(entry.tools[0]).toEqual({ name: "42" });
      expect(entry.tools[1]).toEqual({ name: "true" });
      expect(entry.tools[2]).toEqual({ name: "good_tool", description: "desc" });
      expect(entry.tools[3]).toEqual({ name: "no_desc_tool", description: undefined });
    });

    it("detects transport types correctly: stdio, sse, custom", () => {
      const stdioEntry = parseMcpServerEntry("stdio_srv", { command: "node server.js" });
      expect(stdioEntry.transport).toBe("stdio");

      const sseEntry = parseMcpServerEntry("sse_srv", { url: "http://example.com/sse" });
      expect(sseEntry.transport).toBe("sse");

      const customEntry = parseMcpServerEntry("custom_srv", { transport: "websocket" });
      expect(customEntry.transport).toBe("websocket");

      const fallbackEntry = parseMcpServerEntry("fallback_srv", {});
      expect(fallbackEntry.transport).toBe("stdio");
    });
  });
});
