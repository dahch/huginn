import type { IAgentRuntime, McpStatusReport } from "./types.js";

/**
 * Safely fetches the MCP status report from an agent runtime bounded by a strict timeout.
 * Guaranteed not to throw or block the render loop.
 */
export async function fetchMcpStatusWithTimeout(
  runtime: IAgentRuntime,
  timeoutMs = 1500,
): Promise<McpStatusReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<McpStatusReport>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        servers: [],
        totalTools: 0,
        healthy: false,
        degraded: true,
        error: `MCP status timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });

  try {
    const reportPromise = Promise.resolve(runtime.getMcpStatus());
    const result = await Promise.race([reportPromise, timeoutPromise]);

    if (result && Array.isArray(result.servers)) {
      const hasError = result.servers.some((s) => s.status === "error");
      if (hasError && result.degraded === undefined) {
        return { ...result, degraded: true };
      }
    }

    return result;
  } catch (err) {
    return {
      servers: [],
      totalTools: 0,
      healthy: false,
      degraded: true,
      error: (err as Error).message || String(err),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function formatMcpBadge(report?: McpStatusReport | null): {
  text: string;
  color: "green" | "yellow" | "gray";
} {
  if (!report) {
    return { text: "MCP: ⚪ 0 active", color: "gray" };
  }

  if (report.degraded || report.error || (!report.healthy && report.servers.some((s) => s.status === "error"))) {
    const isTimeout = report.error && (report.error.includes("timed out") || report.error.includes("timeout"));
    return {
      text: isTimeout ? "MCP: 🟡 timeout" : "MCP: 🟡 degraded",
      color: "yellow",
    };
  }

  const activeCount = report.servers.filter((s) => s.status === "connected").length;
  if (activeCount > 0) {
    return {
      text: `MCP: 🟢 ${activeCount} active (${report.totalTools} tools)`,
      color: "green",
    };
  }

  return { text: "MCP: ⚪ 0 active", color: "gray" };
}
