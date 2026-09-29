import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { IAgentRuntime, McpStatusReport, McpToolInfo } from "../engine/agent/types.js";
import {
  MCP_STATUS_POLL_TIMEOUT_MS,
  fetchMcpStatusWithTimeout,
  mcpToolTotal,
} from "../engine/agent/mcpStatus.js";
import { events } from "../engine/engineEvents";
import { sanitizeTerminalText } from "../util/text.js";
import { NEXT_STEP, warnFeedback } from "./feedback.js";
import { THEME } from "./theme.js";

const MAX_VISIBLE_TOOLS = 10;

/** Columns the per-server detail may spend in the list column. */
const SERVER_DETAIL_WIDTH = 24;

/** The server that carries Huginn's own memory brain (ADR-20 / REQ-38). */
const MUNINN_SERVER = "muninn";

/**
 * The exact command that registers Muninn for an agent (AC-32.3 / AC-38.2):
 * named explicitly so a missing brain is one copy-paste away from existing.
 */
export function muninnSetupCommand(agentId: string): string {
  const clean = sanitizeTerminalText(agentId).replace(/\s+/g, " ").trim() || "opencode";
  return `huginn setup --agent ${clean}`;
}

/** Clamps a display string to `max` columns (single line, sanitized). */
function clampText(value: string | undefined, max: number): string {
  const clean = sanitizeTerminalText(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export interface McpInspectorModalProps {
  runtime: IAgentRuntime;
  onClose: () => void;
  initialReport?: McpStatusReport;
  initialServerId?: string;
}

export const McpInspectorModal = React.memo(function McpInspectorModal({
  runtime,
  onClose,
  initialReport,
  initialServerId,
}: McpInspectorModalProps) {
  const [report, setReport] = useState<McpStatusReport | null>(initialReport ?? null);
  const [loading, setLoading] = useState(!initialReport);
  const [selectedServerIndex, setSelectedServerIndex] = useState(0);
  const [pendingServerId, setPendingServerId] = useState(initialServerId);
  const [focusView, setFocusView] = useState<"servers" | "tools">("servers");
  const [selectedToolIndex, setSelectedToolIndex] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetchMcpStatusWithTimeout(runtime, MCP_STATUS_POLL_TIMEOUT_MS);
        if (active) {
          setReport(res);
        }
      } catch (err) {
        if (active) {
          setReport({
            servers: [],
            totalTools: 0,
            healthy: false,
            degraded: true,
            error: (err as Error).message,
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [runtime]);

  const servers = report?.servers ?? [];
  const currentServer = servers[selectedServerIndex];
  const currentTools: McpToolInfo[] = currentServer?.tools ?? [];

  useEffect(() => {
    if (selectedServerIndex >= servers.length) {
      setSelectedServerIndex(Math.max(0, servers.length - 1));
    }
  }, [servers.length, selectedServerIndex]);

  // Preselect the server requested via `/mcp <id>` once the report is available.
  // An id that matches nothing is *said*, not silently ignored (AC-31.1).
  useEffect(() => {
    if (!pendingServerId || !report) return;
    const idx = report.servers.findIndex(
      (s) => s.id === pendingServerId || s.name === pendingServerId,
    );
    if (idx >= 0) {
      setSelectedServerIndex(idx);
    } else {
      events.emit("liveChat", {
        role: "system",
        text: warnFeedback(
          `No MCP server named "${sanitizeTerminalText(pendingServerId)}" — showing all ` +
            `${report.servers.length} registered server(s). ${NEXT_STEP.mcp}`,
        ),
      });
    }
    setPendingServerId(undefined);
  }, [report, pendingServerId]);

  useEffect(() => {
    if (selectedToolIndex >= currentTools.length && currentTools.length > 0) {
      setSelectedToolIndex(Math.max(0, currentTools.length - 1));
    }
  }, [currentTools.length, selectedToolIndex]);

  // Window calculation for tool pagination (SEC-002)
  const startIndex = Math.max(
    0,
    Math.min(
      selectedToolIndex - Math.floor(MAX_VISIBLE_TOOLS / 2),
      currentTools.length - MAX_VISIBLE_TOOLS,
    ),
  );
  const endIndex = Math.min(currentTools.length, startIndex + MAX_VISIBLE_TOOLS);
  const visibleTools = currentTools.slice(startIndex, endIndex);
  const moreAbove = startIndex;
  const moreBelow = currentTools.length - endIndex;

  // stateRef bridge pattern ensures freshest state in useInput
  const stateRef = useRef({
    servers,
    selectedServerIndex,
    focusView,
    selectedToolIndex,
    currentTools,
    onClose,
  });
  stateRef.current = {
    servers,
    selectedServerIndex,
    focusView,
    selectedToolIndex,
    currentTools,
    onClose,
  };

  useInput((input, key) => {
    const cur = stateRef.current;

    if (key.escape) {
      cur.onClose();
      return;
    }

    if (key.tab || key.return) {
      setFocusView((f) => (f === "servers" ? "tools" : "servers"));
      return;
    }

    if (cur.focusView === "servers") {
      if (key.upArrow || input === "k") {
        setSelectedServerIndex((i) => Math.max(0, i - 1));
        setSelectedToolIndex(0);
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedServerIndex((i) => Math.min(cur.servers.length - 1, i + 1));
        setSelectedToolIndex(0);
        return;
      }
    } else {
      if (key.upArrow || input === "k") {
        setSelectedToolIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedToolIndex((i) => Math.min(cur.currentTools.length - 1, i + 1));
        return;
      }
    }
  });

  const activeCount = servers.filter((s) => s.status === "connected").length;
  const unverifiedCount = servers.filter((s) => s.status === "unknown").length;
  const totalTools = mcpToolTotal(report);
  const agentLabel = sanitizeTerminalText(runtime.name);
  const agentId = sanitizeTerminalText(runtime.id ?? runtime.name);
  // AC-32.3: whatever is listed belongs to the active agent, and Huginn only
  // observes it — the panel says so instead of implying it owns the config.
  const muninn = servers.find((s) => sanitizeTerminalText(s.name).toLowerCase().includes(MUNINN_SERVER));
  // Header status (REQ-30): a config-discovered server is never "active" — the
  // count is qualified as unverified instead of silently inflating liveness. An
  // error keeps the count too (`2/3 active · error`) so a partial failure is
  // still legible rather than collapsing to a bare "error".
  const hasError = Boolean(report?.degraded || report?.error || servers.some((s) => s.status === "error"));
  const statusSummary =
    activeCount > 0
      ? `${activeCount}/${servers.length} active${hasError ? " · error" : ""}`
      : unverifiedCount > 0
        ? `${unverifiedCount}/${servers.length} unverified${hasError ? " · error" : ""}`
        : hasError
          ? "error"
          : `${activeCount}/${servers.length} active`;
  const statusColor: string | undefined = hasError
    ? THEME.warn
    : unverifiedCount > 0 && activeCount === 0
      ? THEME.muted
      : report?.healthy
        ? THEME.ok
        : THEME.text;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.thinker}
      paddingX={1}
      paddingY={1}
      width="100%"
      minHeight={14}
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text bold color={THEME.thinker}>
            🔌 MCP SERVER INSPECTOR
          </Text>
          <Text color={THEME.muted}> · </Text>
          <Text bold color={statusColor}>
            {statusSummary}
          </Text>
          <Text color={THEME.muted}> · </Text>
          <Text color={THEME.accent}>{totalTools} tools</Text>
        </Box>
        <Box>
          <Text color={THEME.muted}>Runtime: </Text>
          <Text color={THEME.warn}>{agentLabel}</Text>
        </Box>
      </Box>

      {/* Attribution & expectation (AC-32.3) */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={THEME.muted} wrap="truncate">
          Servers come from <Text color={THEME.warn}>{agentLabel}</Text> — add or change them with the
          agent&apos;s own config or CLI; Huginn only observes them.
        </Text>
        <Text color={muninn ? THEME.ok : THEME.warn} wrap="truncate">
          {muninn
            ? `✓ Muninn (the memory brain) is registered for ${agentLabel} as "${sanitizeTerminalText(muninn.name)}" — one project-scoped brain, shared by every agent.`
            : `⚠ Muninn is not registered for ${agentLabel} — run: ${muninnSetupCommand(agentId)}`}
        </Text>
      </Box>

      {/* Main Split Body: Left Server List, Right Detail Panel */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left column: Server list */}
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="single"
          borderColor={focusView === "servers" ? THEME.accent : THEME.border}
          paddingX={1}
          marginRight={1}
        >
          <Box marginBottom={1}>
            <Text bold color={focusView === "servers" ? THEME.accent : THEME.text}>
              Servers ({servers.length})
            </Text>
          </Box>

          {loading ? (
            <Text color={THEME.warn}>Probing MCP servers...</Text>
          ) : servers.length === 0 ? (
            <Box flexDirection="column">
              {/* Attributed empty state (AC-32.3): "nothing found" is a statement
                  about *this agent*, not about the project. */}
              <Text color={THEME.muted}>No MCP servers registered for {agentLabel}</Text>
              {report?.error && (
                <>
                  <Text color={THEME.danger}>Error: {sanitizeTerminalText(report.error)}</Text>
                  {/* AC-31.2: the failing component, then what to do about it. */}
                  <Text color={THEME.muted}>Press Esc, then run /mcp again to retry the probe.</Text>
                </>
              )}
            </Box>
          ) : (
            servers.map((server, idx) => {
              const isSelected = idx === selectedServerIndex;
              const serverStatusColor =
                server.status === "connected"
                  ? THEME.ok
                  : server.status === "error"
                    ? THEME.danger
                    : THEME.muted;
              // `name · transport · status · detail` (AC-32.1/AC-32.5): the
              // agent's own words first, then the detail it exposed. Latency is
              // only shown when a probe actually measured it, so `undefined`
              // can never reach the row (AC-32.4).
              const trailing = [
                typeof server.latencyMs === "number" && Number.isFinite(server.latencyMs)
                  ? `${server.latencyMs}ms`
                  : "",
                clampText(server.detail, SERVER_DETAIL_WIDTH),
              ]
                .filter((part) => part.length > 0)
                .join(" · ");

              return (
                <Box key={server.id || idx} justifyContent="space-between" marginBottom={0}>
                  <Box>
                    <Text color={isSelected ? THEME.accent : THEME.muted}>
                      {isSelected ? "▶ " : "  "}
                    </Text>
                    <Text bold={isSelected} color={THEME.text}>
                      {sanitizeTerminalText(server.name)}
                    </Text>
                  </Box>
                  <Box>
                    <Text color={THEME.accent}>[{sanitizeTerminalText(server.transport)}]</Text>
                    <Text color={serverStatusColor}> · [{sanitizeTerminalText(server.status)}]</Text>
                    {trailing ? <Text color={THEME.warn}> · {trailing}</Text> : null}
                  </Box>
                </Box>
              );
            })
          )}
        </Box>

        {/* Right column: Detail & Tools panel */}
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="single"
          borderColor={focusView === "tools" ? THEME.accent : THEME.border}
          paddingX={1}
        >
          <Box marginBottom={1} justifyContent="space-between">
            <Text bold color={focusView === "tools" ? THEME.accent : THEME.text}>
              {currentServer ? `Tools for ${sanitizeTerminalText(currentServer.name)}` : "Server Detail"}
            </Text>
            {currentServer && (
              <Text color={THEME.muted}>
                {currentTools.length} tool{currentTools.length === 1 ? "" : "s"}
              </Text>
            )}
          </Box>

          {!currentServer ? (
            <Text color={THEME.muted}>Select a server to view tools</Text>
          ) : (
            <Box flexDirection="column">
              {currentServer.error && (
                <Box marginBottom={1}>
                  <Text color={THEME.danger}>Error: {sanitizeTerminalText(currentServer.error)}</Text>
                </Box>
              )}

              {currentServer.detail && (
                <Box marginBottom={1}>
                  <Text color={THEME.muted} wrap="truncate">
                    Detail: <Text color={THEME.accent}>{sanitizeTerminalText(currentServer.detail)}</Text>
                  </Text>
                </Box>
              )}

              {/* AC-32.5: where the agent reports no health, say so instead of
                  implying the server is either up or down. */}
              {currentServer.status === "unknown" && (
                <Box marginBottom={1}>
                  <Text color={THEME.muted} wrap="truncate">
                    Status not reported by {agentLabel} — configured, not probed.
                  </Text>
                </Box>
              )}

              {currentTools.length === 0 ? (
                <Text color={THEME.muted}>No exposed tools reported</Text>
              ) : (
                <Box flexDirection="column">
                  {moreAbove > 0 && (
                    <Box marginBottom={0}>
                      <Text color={THEME.muted}>  ▲ ... {moreAbove} more above</Text>
                    </Box>
                  )}
                  {visibleTools.map((tool, vIdx) => {
                    const actualIndex = startIndex + vIdx;
                    const isToolSelected = focusView === "tools" && actualIndex === selectedToolIndex;
                    return (
                      <Box key={tool.name ? `${tool.name}-${actualIndex}` : actualIndex} flexDirection="column" marginBottom={1}>
                        <Box>
                          <Text color={isToolSelected ? THEME.accentStrong : THEME.muted}>
                            {isToolSelected ? "▶ " : "  "}
                          </Text>
                          <Text bold color={THEME.accentStrong}>
                            {sanitizeTerminalText(tool.name)}
                          </Text>
                        </Box>
                        {tool.description && (
                          <Box paddingLeft={4}>
                            <Text color={THEME.muted}>{sanitizeTerminalText(tool.description)}</Text>
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                  {moreBelow > 0 && (
                    <Box marginTop={0}>
                      <Text color={THEME.muted}>  ▼ ... and {moreBelow} more</Text>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>

      {/* Footer Navigation */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color={THEME.muted}>
          [↑/↓ or k/j] Navigate · [Tab/Enter] View Tools · [Esc] Close
        </Text>
        <Text color={THEME.muted}>
          Focus: <Text color={THEME.accent}>{focusView}</Text>
        </Text>
      </Box>
    </Box>
  );
});
