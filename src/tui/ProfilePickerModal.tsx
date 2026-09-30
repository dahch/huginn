import React, { useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { PROFILES, PROFILE_NAMES, type ProfileName } from "../engine/profiles.js";
import { sanitizeTerminalText } from "../util/text.js";
import { THEME } from "./theme.js";

/** Rows the list window may occupy before it scrolls (REQ-54 / AC-54.1). */
export const VISIBLE_PROFILE_ROWS = 6;

/** Where a profile change is kept (AC-54.3). */
export type ProfileScope = "session" | "project" | "global";

export interface ProfileRow {
  id: ProfileName;
  name: string;
  description: string;
}

export interface ProfilePickerModalProps {
  /** The active profile's id, marked and preselected. */
  currentProfileId: string;
  /** `scope` says whether the change is kept for the session, the project or globally. */
  onSelect: (id: ProfileName, scope: ProfileScope) => void;
  onCancel: () => void;
  /** Rows the list window may use; shrinks on short terminals. */
  maxRows?: number;
}

/** Every profile, in registry order, with its display name and one-line intent. */
export function buildProfileRows(): ProfileRow[] {
  return PROFILE_NAMES.map((id) => {
    const spec = PROFILES[id];
    return { id, name: spec.name, description: spec.description };
  });
}

/**
 * Interactive methodology-profile picker (REQ-54 / ADR-53).
 *
 * The five profiles (`huginn`, `sdd`, `odd`, `rdd`, `strict-tdd`) existed but
 * could only be fixed before the run — the console merely displayed the resolved
 * value. This modal makes them selectable like runtimes and models: Enter applies
 * for the session, `p`/`g` also persist it to the project or the user config, and
 * Esc cancels. The footer states the one rule a user must know — the pipeline is
 * chosen when a cycle starts, so a change applies to the next cycle (AC-54.4).
 */
export function ProfilePickerModal({
  currentProfileId,
  onSelect,
  onCancel,
  maxRows = VISIBLE_PROFILE_ROWS,
}: ProfilePickerModalProps): React.ReactElement {
  const rows = useMemo(buildProfileRows, []);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const index = rows.findIndex((row) => row.id === currentProfileId);
    return index >= 0 ? index : 0;
  });

  // Latest props/state for the input handler, so `useInput` never captures a
  // stale closure (the same pattern `AgentPickerModal` uses).
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

    const chosen = cur.rows[cur.selectedIndex];
    if (!chosen) return;
    if (key.return) {
      cur.onSelect(chosen.id, "session");
      return;
    }
    const c = input.toLowerCase();
    if (c === "p") cur.onSelect(chosen.id, "project");
    else if (c === "g") cur.onSelect(chosen.id, "global");
  });

  const limit = Math.max(1, Math.floor(maxRows));
  const offset = Math.min(Math.max(0, selectedIndex - limit + 1), Math.max(0, rows.length - limit));
  const visible = rows.slice(offset, offset + limit);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={THEME.accent} paddingX={1} width="100%">
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color={THEME.accent}>
          SELECT METHODOLOGY PROFILE
        </Text>
        <Text color={THEME.muted}>↑/↓ move · Enter session · p project · g global · Esc cancel</Text>
      </Box>

      <Box flexDirection="column">
        {offset > 0 && <Text color={THEME.muted}>▲ {offset} more above</Text>}
        {visible.map((row, index) => {
          const absolute = offset + index;
          const selected = absolute === selectedIndex;
          const active = row.id === currentProfileId;
          return (
            <Text key={row.id} wrap="truncate">
              <Text color={selected ? THEME.accentStrong : THEME.accent} bold={selected}>
                {selected ? "▸ " : "  "}
                {sanitizeTerminalText(row.name)}
              </Text>
              <Text color={THEME.muted}> ({sanitizeTerminalText(row.id)})</Text>
              {active && <Text color={THEME.executor}> ● active</Text>}
              <Text color={THEME.muted}> — {sanitizeTerminalText(row.description)}</Text>
            </Text>
          );
        })}
        {offset + visible.length < rows.length && (
          <Text color={THEME.muted}>▼ {rows.length - offset - visible.length} more below</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={THEME.muted} wrap="truncate">
          The pipeline is chosen when a cycle starts: a change applies to the next cycle.
        </Text>
      </Box>
    </Box>
  );
}
