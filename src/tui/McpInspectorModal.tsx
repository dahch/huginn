import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { IAgentRuntime, McpStatusReport, McpToolInfo } from "../engine/agent/types.js";
import { fetchMcpStatusWithTimeout } from "../engine/agent/mcpStatus.js";
import { sanitizeTerminalText } from "../util/text.js";

const MAX_VISIBLE_TOOLS = 10;

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
        const res = await fetchMcpStatusWithTimeout(runtime, 1500);
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
  useEffect(() => {
    if (!pendingServerId || !report) return;
    const idx = report.servers.findIndex(
      (s) => s.id === pendingServerId || s.name === pendingServerId,
    );
    if (idx >= 0) setSelectedServerIndex(idx);
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
  const totalTools = report?.totalTools ?? servers.reduce((sum, s) => sum + s.toolsCount, 0);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      paddingY={1}
      width="100%"
      minHeight={14}
    >
      {/* Header */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Box>
          <Text bold color="magenta">
            🔌 MCP SERVER INSPECTOR
          </Text>
          <Text dimColor> · </Text>
          <Text bold color={report?.healthy ? "green" : report?.degraded ? "yellow" : "white"}>
            {activeCount}/{servers.length} active
          </Text>
          <Text dimColor> · </Text>
          <Text color="cyan">{totalTools} tools</Text>
        </Box>
        <Box>
          <Text dimColor>Runtime: </Text>
          <Text color="yellow">{sanitizeTerminalText(runtime.name)}</Text>
        </Box>
      </Box>

      {/* Main Split Body: Left Server List, Right Detail Panel */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Left column: Server list */}
        <Box
          flexDirection="column"
          width="50%"
          borderStyle="single"
          borderColor={focusView === "servers" ? "cyan" : "gray"}
          paddingX={1}
          marginRight={1}
        >
          <Box marginBottom={1}>
            <Text bold color={focusView === "servers" ? "cyan" : "white"}>
              Servers ({servers.length})
            </Text>
          </Box>

          {loading ? (
            <Text color="yellow">Probing MCP servers...</Text>
          ) : servers.length === 0 ? (
            <Box flexDirection="column">
              <Text dimColor>No MCP servers registered</Text>
              {report?.error && (
                <Text color="red">Error: {sanitizeTerminalText(report.error)}</Text>
              )}
            </Box>
          ) : (
            servers.map((server, idx) => {
              const isSelected = idx === selectedServerIndex;
              const statusColor =
                server.status === "connected"
                  ? "green"
                  : server.status === "error"
                    ? "red"
                    : "gray";

              return (
                <Box key={server.id || idx} justifyContent="space-between" marginBottom={0}>
                  <Box>
                    <Text color={isSelected ? "cyan" : "dim"}>
                      {isSelected ? "▶ " : "  "}
                    </Text>
                    <Text bold={isSelected} color={isSelected ? "white" : undefined}>
                      {sanitizeTerminalText(server.name)}
                    </Text>
                  </Box>
                  <Box>
                    <Text color={statusColor}>[{sanitizeTerminalText(server.status)}] </Text>
                    <Text color="cyan">[{sanitizeTerminalText(server.transport)}]</Text>
                    {typeof server.latencyMs === "number" && (
                      <Text color="yellow"> {server.latencyMs}ms</Text>
                    )}
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
          borderColor={focusView === "tools" ? "cyan" : "gray"}
          paddingX={1}
        >
          <Box marginBottom={1} justifyContent="space-between">
            <Text bold color={focusView === "tools" ? "cyan" : "white"}>
              {currentServer ? `Tools for ${sanitizeTerminalText(currentServer.name)}` : "Server Detail"}
            </Text>
            {currentServer && (
              <Text dimColor>
                {currentTools.length} tool{currentTools.length === 1 ? "" : "s"}
              </Text>
            )}
          </Box>

          {!currentServer ? (
            <Text dimColor>Select a server to view tools</Text>
          ) : (
            <Box flexDirection="column">
              {currentServer.error && (
                <Box marginBottom={1}>
                  <Text color="red">Error: {sanitizeTerminalText(currentServer.error)}</Text>
                </Box>
              )}

              {currentTools.length === 0 ? (
                <Text dimColor>No exposed tools reported</Text>
              ) : (
                <Box flexDirection="column">
                  {moreAbove > 0 && (
                    <Box marginBottom={0}>
                      <Text dimColor>  ▲ ... {moreAbove} more above</Text>
                    </Box>
                  )}
                  {visibleTools.map((tool, vIdx) => {
                    const actualIndex = startIndex + vIdx;
                    const isToolSelected = focusView === "tools" && actualIndex === selectedToolIndex;
                    return (
                      <Box key={tool.name ? `${tool.name}-${actualIndex}` : actualIndex} flexDirection="column" marginBottom={1}>
                        <Box>
                          <Text color={isToolSelected ? "cyanBright" : "dim"}>
                            {isToolSelected ? "▶ " : "  "}
                          </Text>
                          <Text bold color="cyanBright">
                            {sanitizeTerminalText(tool.name)}
                          </Text>
                        </Box>
                        {tool.description && (
                          <Box paddingLeft={4}>
                            <Text dimColor>{sanitizeTerminalText(tool.description)}</Text>
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                  {moreBelow > 0 && (
                    <Box marginTop={0}>
                      <Text dimColor>  ▼ ... and {moreBelow} more</Text>
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
        <Text dimColor>
          [↑/↓ or k/j] Navigate · [Tab/Enter] View Tools · [Esc] Close
        </Text>
        <Text dimColor>
          Focus: <Text color="cyan">{focusView}</Text>
        </Text>
      </Box>
    </Box>
  );
});
