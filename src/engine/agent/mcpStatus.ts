import { sanitizeTerminalText } from "../../util/text.js";
import type { IAgentRuntime, McpServerStatus, McpStatusReport } from "./types.js";

/** Columns the reason is clamped to in the header badge (the header clamps again). */
export const MCP_BADGE_REASON_WIDTH = 40;

/** True when every reported server was verified reachable by a real probe. */
function verifiedConnected(servers: McpServerStatus[]): McpServerStatus[] {
  return servers.filter((s) => s.status === "connected");
}

/**
 * True when the report carries an honestly-unknown state: either an explicit
 * `unverified` flag or servers that were discovered but never probed (AC-30.1).
 */
function hasUnverified(report: McpStatusReport): boolean {
  if (report.unverified) return true;
  return report.servers.some((s) => s.status === "unknown");
}

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
    // The deadline must never hold the process (or an Ink test runner) open.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
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

/**
 * Maps a status report to a concise, *truthful* header badge (REQ-30).
 *
 * The five states are deliberately distinguishable (AC-30.1 / AC-30.2):
 *
 * - `MCP: 🟡 timeout`   — the probe exceeded its deadline
 * - `MCP: 🟡 error: …`  — a probe threw or a server reported a failure
 * - `MCP: 🟢 n active (m tools)` — n servers verified reachable by a probe
 * - `MCP: ⚪ n unverified` — n servers found in config, never probed
 * - `MCP: ⚪ 0 active`   — nothing configured / nothing reported
 */
export function formatMcpBadge(report?: McpStatusReport | null): {
  text: string;
  color: "green" | "yellow" | "gray";
} {
  if (!report) {
    return { text: "MCP: ⚪ 0 active", color: "gray" };
  }

  const failed = report.servers.some((s) => s.status === "error");
  if (report.degraded || report.error || failed) {
    const lower = report.error?.toLowerCase() ?? "";
    const isTimeout = lower.includes("timed out") || lower.includes("timeout");
    if (isTimeout) {
      return { text: "MCP: 🟡 timeout", color: "yellow" };
    }
    const reason = report.error ? badgeReason(report.error) : "";
    return {
      text: reason ? `MCP: 🟡 error — ${reason}` : "MCP: 🟡 error",
      color: "yellow",
    };
  }

  const active = verifiedConnected(report.servers);
  if (active.length > 0) {
    return {
      text: `MCP: 🟢 ${active.length} active (${report.totalTools} tools)`,
      color: "green",
    };
  }

  if (hasUnverified(report)) {
    const count = report.servers.filter((s) => s.status === "unknown").length;
    return { text: `MCP: ⚪ ${count} unverified`, color: "gray" };
  }

  return { text: "MCP: ⚪ 0 active", color: "gray" };
}

/** Sanitizes and clamps an error reason so a badge never injects control codes or floods a row. */
function badgeReason(reason: string): string {
  const clean = sanitizeTerminalText(reason).replace(/\s+/g, " ").trim();
  if (clean.length <= MCP_BADGE_REASON_WIDTH) return clean;
  return `${clean.slice(0, MCP_BADGE_REASON_WIDTH - 1)}…`;
}
