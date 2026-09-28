import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { AGENT_REGISTRY, AGENT_TARGETS, type AgentTarget } from "../agents/integrator.js";
import { detectAvailableAgents } from "../engine/agent/registry.js";
import { sanitizeTerminalText } from "../util/text.js";

/** Rows the list window may occupy before it scrolls (REQ-33 / AC-33.1). */
export const VISIBLE_AGENT_ROWS = 6;

/** Rows the modal needs beyond the list window (border 2 + header 2 + note 1). */
export const AGENT_PICKER_CHROME_ROWS = 5;

export interface AgentPickerRow {
  id: AgentTarget;
  label: string;
  available: boolean;
  path?: string;
}

export interface AgentPickerModalProps {
  /** The runtime currently driving the session (marked, not selectable-as-new). */
  currentAgentId: string;
  onSelect: (id: AgentTarget) => void;
  onCancel: () => void;
  /**
   * Availability probe. Injected so the component is deterministic under test and
   * the view does not reach into the engine registry directly (REV-304).
   */
  detect?: () => Promise<Array<{ id: AgentTarget; available: boolean; path?: string }>>;
  /** Rows the list window may use; shrinks on short terminals. */
  maxRows?: number;
}

/** Registry order, with availability resolved asynchronously (never blocking render). */
export function buildAgentRows(
  detected: Array<{ id: AgentTarget; available: boolean; path?: string }>,
): AgentPickerRow[] {
  const byId = new Map(detected.map((d) => [d.id, d]));
  return AGENT_TARGETS.map((id) => {
    const found = byId.get(id);
    return {
      id,
      label: AGENT_REGISTRY[id]?.label ?? id,
      available: found?.available ?? false,
      path: found?.path,
    };
  });
}

/**
 * Interactive runtime picker (REQ-33 / ADR-32).
 *
 * `/agent` used to *list* runtimes and tell the user to type an id, so selecting
 * one (e.g. `agy`) meant memorising it. This modal makes runtimes selectable like
 * models: availability is probed, the active runtime is marked, available entries
 * carry a `✔` (and the highlighted one its resolved path), unavailable ones say so,
 * and Enter switches — the caller keeps the modal open when the switch fails so the
 * user can pick another immediately.
 */
export function AgentPickerModal({
  currentAgentId,
  onSelect,
  onCancel,
  detect = detectAvailableAgents,
  maxRows = VISIBLE_AGENT_ROWS,
}: AgentPickerModalProps): React.ReactElement {
  const [rows, setRows] = useState<AgentPickerRow[]>(() =>
    buildAgentRows(AGENT_TARGETS.map((id) => ({ id, available: false }))),
  );
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const detected = await detect();
        if (active) setRows(buildAgentRows(detected));
      } catch {
        // Detection failure is not fatal: every row simply reads unavailable.
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [detect]);

  // Open on the active runtime so Enter is a no-op rather than an accidental switch.
  useEffect(() => {
    const index = rows.findIndex((r) => r.id === currentAgentId);
    if (index >= 0) setSelectedIndex(index);
  }, [rows, currentAgentId]);

  // Keep the highlight in bounds if the row set ever shrinks (REV-305).
  useEffect(() => {
    setSelectedIndex((i) => Math.min(Math.max(i, 0), Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  const limit = Math.max(1, Math.floor(maxRows));
  const window = useMemo(() => {
    const max = Math.max(0, rows.length - limit);
    const offset = Math.min(Math.max(0, selectedIndex - limit + 1), max);
    return { offset, visible: rows.slice(offset, offset + limit) };
  }, [rows, selectedIndex, limit]);

  const stateRef = useRef({ rows, selectedIndex, onSelect, onCancel });
  stateRef.current = { rows, selectedIndex, onSelect, onCancel };

  useInput((input, key) => {
    const cur = stateRef.current;
    if (key.escape) {
      cur.onCancel();
      return;
    }
    if (key.upArrow || input === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((i) => Math.min(Math.max(cur.rows.length - 1, 0), i + 1));
      return;
    }
    if (key.return) {
      const chosen = cur.rows[cur.selectedIndex];
      if (chosen) cur.onSelect(chosen.id);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width="100%">
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          🐦 SELECT AGENT RUNTIME
        </Text>
        <Text color="gray">↑/↓ move · Enter switch · Esc cancel</Text>
      </Box>

      {loading ? (
        <Text color="yellow">Detecting installed agent CLIs…</Text>
      ) : (
        <Box flexDirection="column">
          {window.offset > 0 && <Text dimColor>▲ {window.offset} more above</Text>}
          {window.visible.map((row, index) => {
            const absolute = window.offset + index;
            const selected = absolute === selectedIndex;
            const isActive = row.id === currentAgentId;
            return (
              <Box key={row.id} flexDirection="column">
                <Text wrap="truncate">
                  <Text color={selected ? "cyanBright" : "cyan"} bold={selected}>
                    {selected ? "▸ " : "  "}
                    {sanitizeTerminalText(row.label)}
                  </Text>
                  <Text dimColor> ({sanitizeTerminalText(row.id)})</Text>
                  {isActive && <Text color="green"> ● active</Text>}
                  {row.available ? (
                    <Text color="green"> ✔</Text>
                  ) : (
                    <Text color="yellow"> — not installed</Text>
                  )}
                </Text>
                {selected && row.path && (
                  <Text dimColor wrap="truncate">
                    {"      "}
                    {sanitizeTerminalText(row.path)}
                  </Text>
                )}
              </Box>
            );
          })}
          {window.offset + window.visible.length < rows.length && (
            <Text dimColor>▼ {rows.length - window.offset - window.visible.length} more below</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate">
          Switching changes which agent runs your prompts; Muninn memory is project-scoped and unaffected.
        </Text>
      </Box>
    </Box>
  );
}
