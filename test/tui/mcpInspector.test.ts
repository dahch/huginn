import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { McpInspectorModal, sanitizeTerminalText } from "../../src/tui/McpInspectorModal";
import type { IAgentRuntime, McpStatusReport } from "../../src/engine/agent/types.js";

function createMockStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function createMockStdout(): PassThrough & { columns: number; rows: number } {
  const stdout = new PassThrough() as any;
  stdout.columns = 120;
  stdout.rows = 30;
  return stdout;
}

const SAMPLE_REPORT: McpStatusReport = {
  servers: [
    {
      id: "muninn",
      name: "muninn",
      status: "connected",
      transport: "stdio",
      toolsCount: 2,
      latencyMs: 8,
      tools: [
        { name: "memory_search", description: "Search long-term memory graph" },
        { name: "memory_save", description: "Save durable observation" },
      ],
    },
    {
      id: "github",
      name: "github",
      status: "connected",
      transport: "stdio",
      toolsCount: 1,
      latencyMs: 45,
      tools: [
        { name: "create_pull_request", description: "Open a GitHub pull request" },
      ],
    },
    {
      id: "postgres",
      name: "postgres",
      status: "error",
      transport: "sse",
      toolsCount: 0,
      error: "ECONNREFUSED 127.0.0.1:5432",
    },
  ],
  totalTools: 3,
  healthy: false,
  degraded: true,
};

function createMockRuntime(report: McpStatusReport = SAMPLE_REPORT): IAgentRuntime {
  return {
    id: "opencode",
    name: "OpenCode Engine",
    isAvailable: async () => true,
    getAvailableModels: async () => [],
    getMcpStatus: async () => report,
    createSession: async () => ({} as any),
  };
}

describe("McpInspectorModal Component (AC-24.2, ADR-24)", () => {
  it("renders header, server list, badges, and tools for the default server", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: SAMPLE_REPORT,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    // Check Header
    expect(output).toContain("MCP SERVER INSPECTOR");
    expect(output).toContain("2/3 active");
    expect(output).toContain("3 tools");
    expect(output).toContain("OpenCode Engine");

    // Check Servers
    expect(output).toContain("muninn");
    expect(output).toContain("github");
    expect(output).toContain("postgres");
    expect(output).toContain("[connected]");
    expect(output).toContain("[error]");
    expect(output).toContain("[stdio]");
    expect(output).toContain("[sse]");
    expect(output).toContain("8ms");

    // Check Initial Selected Server Tools (muninn)
    expect(output).toContain("Tools for muninn");
    expect(output).toContain("memory_search");
    expect(output).toContain("Search long-term memory graph");
    expect(output).toContain("memory_save");
  });

  it("navigates servers using down/up arrow keys (or j/k) and updates detail panel", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: SAMPLE_REPORT,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Press 'j' to navigate to second server (github)
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("Tools for github");
    expect(output).toContain("create_pull_request");
  });

  it("navigates to error server and displays error message in detail panel", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: SAMPLE_REPORT,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Press down arrow or 'j' twice to navigate to third server (postgres)
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 40));
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("Tools for postgres");
    expect(output).toContain("ECONNREFUSED 127.0.0.1:5432");
  });

  it("switches focus between servers and tools using Tab / Enter", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: SAMPLE_REPORT,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Press Tab to switch focus to tools
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("Focus: tools");
  });

  it("calls onClose when Escape key is pressed", async () => {
    const stdout = createMockStdout();
    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: SAMPLE_REPORT,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Press Escape
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("handles empty MCP servers gracefully", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime({ servers: [], totalTools: 0, healthy: true });
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: { servers: [], totalTools: 0, healthy: true },
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("0/0 active");
    expect(output).toContain("No MCP servers registered");
    expect(output).toContain("Select a server to view tools");
  });

  it("sanitizes ANSI escapes and control characters in rendered output (SEC-001)", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const maliciousReport: McpStatusReport = {
      servers: [
        {
          id: "evil-server",
          name: "\u001b[31;1mEvilServer\u001b[0m",
          status: "error",
          transport: "stdio",
          toolsCount: 1,
          error: "\u001b[2JCrash\x00\x07Detail",
          tools: [
            {
              name: "\u001b[32mExploitTool\u001b[0m",
              description: "\u001b[1MEvil Description\x1F",
            },
          ],
        },
      ],
      totalTools: 1,
      healthy: false,
      degraded: true,
    };

    const runtime = createMockRuntime(maliciousReport);
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: maliciousReport,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    // Verify sanitized visible text appears
    expect(output).toContain("EvilServer");
    expect(output).toContain("Tools for EvilServer");
    expect(output).toContain("ExploitTool");
    expect(output).toContain("Evil Description");
    expect(output).toContain("CrashDetail");

    // Verify raw ANSI escape patterns were stripped from output
    expect(output).not.toContain("EvilServer\u001b[0m");
    expect(output).not.toContain("\u001b[2JCrash");
  });

  it("bounds and paginates tool list rendering when server has many tools (SEC-002)", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const manyTools = Array.from({ length: 30 }, (_, i) => ({
      name: `tool_index_${i.toString().padStart(2, "0")}`,
      description: `Description for tool ${i}`,
    }));

    const bigReport: McpStatusReport = {
      servers: [
        {
          id: "huge-server",
          name: "huge-server",
          status: "connected",
          transport: "stdio",
          toolsCount: 30,
          tools: manyTools,
        },
      ],
      totalTools: 30,
      healthy: true,
    };

    const runtime = createMockRuntime(bigReport);
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: bigReport,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 80));
    instance.unmount();

    // First page should show first 10 tools and "... and 20 more"
    expect(output).toContain("tool_index_00");
    expect(output).toContain("tool_index_09");
    expect(output).toContain("... and 20 more");
    // Tool 25 should NOT be rendered in initial window
    expect(output).not.toContain("tool_index_25");
  });

  it("scrolls tool list when navigating down into tools (SEC-002)", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const manyTools = Array.from({ length: 25 }, (_, i) => ({
      name: `tool_index_${i.toString().padStart(2, "0")}`,
      description: `Description for tool ${i}`,
    }));

    const bigReport: McpStatusReport = {
      servers: [
        {
          id: "huge-server",
          name: "huge-server",
          status: "connected",
          transport: "stdio",
          toolsCount: 25,
          tools: manyTools,
        },
      ],
      totalTools: 25,
      healthy: true,
    };

    const runtime = createMockRuntime(bigReport);
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: bigReport,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Tab to tools
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 30));

    // Press down arrow or 'j' 15 times
    for (let i = 0; i < 15; i++) {
      stdin.write("j");
      await new Promise((r) => setTimeout(r, 10));
    }

    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("more above");
    expect(output).toContain("tool_index_15");
  });

  it("sanitizeTerminalText utility cleans escape sequences and control characters", () => {
    expect(sanitizeTerminalText("\u001b[34mBlueText\u001b[0m")).toBe("BlueText");
    expect(sanitizeTerminalText("Line\x00\x01\x1F\x7FEnd")).toBe("LineEnd");
    expect(sanitizeTerminalText("Tab\tNewline\nKept")).toBe("Tab\tNewline\nKept");
    expect(sanitizeTerminalText(undefined as any)).toBe("");
  });

  it("shows loading state when probing MCP servers", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      ...createMockRuntime(SAMPLE_REPORT),
      getMcpStatus: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return SAMPLE_REPORT;
      },
    };
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 30));
    instance.unmount();

    expect(output).toContain("Probing MCP servers...");
  });

  it("loads status asynchronously when initialReport is omitted", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime(SAMPLE_REPORT);
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 80));
    instance.unmount();

    expect(output).toContain("muninn");
    expect(output).toContain("2/3 active");
  });

  it("handles runtime error when initialReport is omitted", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime: IAgentRuntime = {
      id: "failing",
      name: "Failing Runtime",
      isAvailable: async () => true,
      getAvailableModels: async () => [],
      getMcpStatus: async () => {
        throw new Error("Fatal runtime communication failure");
      },
      createSession: async () => ({} as any),
    };
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 100));
    instance.unmount();

    expect(output).toContain("No MCP servers registered");
    expect(output).toContain("Fatal runtime communication failure");
  });

  it("renders servers with no tools and disconnected servers properly", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const report: McpStatusReport = {
      servers: [
        {
          id: "empty-tools-server",
          name: "empty-tools-server",
          status: "connected",
          transport: "stdio",
          toolsCount: 0,
          tools: [],
        },
        {
          id: "offline-server",
          name: "offline-server",
          status: "disconnected",
          transport: "stdio",
          toolsCount: 0,
        },
      ],
      totalTools: 0,
      healthy: false,
    };

    const stdin = createMockStdin();
    const runtime = createMockRuntime(report);
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: report,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Navigate to offline-server
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 60));
    instance.unmount();

    expect(output).toContain("empty-tools-server");
    expect(output).toContain("No exposed tools reported");
    expect(output).toContain("offline-server");
    expect(output).toContain("[disconnected]");
    expect(output).toContain("Tools for offline-server");
  });

  it("cycles focus between servers and tools using Tab / Enter, and closes on Escape in tools view", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: SAMPLE_REPORT,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 60));

    // Press Tab -> focus switches to tools
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 40));

    // Press Tab again -> focus switches back to servers
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 40));

    // Press Enter (\r) -> focus switches to tools
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 40));

    // Press Escape while in tools focus -> closes modal
    stdin.write("\u001B");
    await new Promise((r) => setTimeout(r, 40));
    instance.unmount();

    const cleanOutput = sanitizeTerminalText(output);
    expect(cleanOutput).toContain("Focus: tools");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates up and down with arrow keys and k/j in both server and tool views", async () => {
    const stdout = createMockStdout();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const runtime = createMockRuntime();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(McpInspectorModal, {
        runtime,
        onClose,
        initialReport: SAMPLE_REPORT,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));

    // In servers view: down ('j'), then up ('k'), then up arrow
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("k");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\u001B[A"); // up arrow
    await new Promise((r) => setTimeout(r, 30));

    // Tab to tools view
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 30));

    // In tools view: down ('j'), then up ('k'), then down arrow, then up arrow
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("k");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\u001B[B"); // down arrow
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\u001B[A"); // up arrow
    await new Promise((r) => setTimeout(r, 30));

    instance.unmount();
    expect(output).toContain("Tools for muninn");
  });
});
