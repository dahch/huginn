import React from "react";
import { Box, Text } from "ink";
import { commandUsage, type SlashCommand } from "./commandRegistry.js";
import { sanitizeTerminalText } from "../util/text.js";
import { THEME } from "./theme.js";

/** Content rows (excluding the border) the overlay may occupy. */
export const MAX_SUGGESTION_ROWS = 6;

export type SuggestionRow =
  | { kind: "up"; hidden: number }
  | { kind: "down"; hidden: number }
  | { kind: "command"; command: SlashCommand; index: number; selected: boolean };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Bounded window over the ranked matches: at most `maxRows` content rows, with
 * `▲`/`▼` markers counting against that budget whenever the list is scrolled.
 * The selection is kept visible and the window prefers to show as many commands
 * as still fit.
 */
export function buildSuggestionRows(
  matches: SlashCommand[],
  selectedIndex: number,
  maxRows: number = MAX_SUGGESTION_ROWS,
): SuggestionRow[] {
  const limit = Math.max(1, Math.floor(maxRows));
  const total = matches.length;
  if (total === 0) return [];
  const selected = clamp(Math.floor(selectedIndex) || 0, 0, total - 1);

  if (total <= limit) {
    return matches.map((command, index) => ({ kind: "command", command, index, selected: index === selected }));
  }

  for (let count = limit; count >= 1; count--) {
    const start = clamp(selected - Math.floor((count - 1) / 2), 0, total - count);
    const up = start > 0 ? 1 : 0;
    const down = start + count < total ? 1 : 0;
    if (count + up + down > limit) continue;

    const rows: SuggestionRow[] = [];
    if (up) rows.push({ kind: "up", hidden: start });
    for (let i = start; i < start + count; i++) {
      rows.push({ kind: "command", command: matches[i]!, index: i, selected: i === selected });
    }
    if (down) rows.push({ kind: "down", hidden: total - (start + count) });
    return rows;
  }

  // Only reachable at tiny row budgets (e.g. limit === 1 with several matches):
  // show the selected command alone — the `▲`/`▼` markers would not fit.
  return [{ kind: "command", command: matches[selected]!, index: selected, selected: true }];
}

/** Rows plus the box border — the exact cost the layout budget must reserve. */
export function suggestionOverlayHeight(rows: SuggestionRow[]): number {
  return rows.length === 0 ? 0 : rows.length + 2;
}

export interface CommandSuggestionsProps {
  /** Ranked matches for the current `/<…>` draft (see `matchCommands`). */
  matches: SlashCommand[];
  selectedIndex: number;
  maxRows?: number;
}

/**
 * Inline autocomplete overlay rendered directly beneath the input row while the
 * user types a bare `/<…>` token. Height-bounded (AC-28.4).
 */
export const CommandSuggestions = React.memo(function CommandSuggestions({
  matches,
  selectedIndex,
  maxRows = MAX_SUGGESTION_ROWS,
}: CommandSuggestionsProps) {
  const rows = buildSuggestionRows(matches, selectedIndex, maxRows);
  if (rows.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={THEME.border} paddingX={1}>
      {rows.map((row) => {
        if (row.kind === "up") {
          return (
            <Box key="suggestion-up" height={1}>
              <Text color={THEME.muted} wrap="truncate">
                ▲ {row.hidden} more above
              </Text>
            </Box>
          );
        }
        if (row.kind === "down") {
          return (
            <Box key="suggestion-down" height={1}>
              <Text color={THEME.muted} wrap="truncate">
                ▼ {row.hidden} more below
              </Text>
            </Box>
          );
        }
        return (
          <Box key={row.command.id} height={1}>
            <Text
              wrap="truncate"
              bold={row.selected}
              color={row.selected ? THEME.accentStrong : THEME.accent}
            >
              {row.selected ? "▸ " : "  "}
              {sanitizeTerminalText(commandUsage(row.command))}
              <Text color={THEME.muted} bold={false}>
                {" — "}
                {sanitizeTerminalText(row.command.description)}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
});
