import React from "react";
import { Box, Text } from "ink";
import {
  hiddenAbove,
  hiddenBelow,
  visibleWindow,
  type PickerWindowAlign,
} from "./pickerWindow.js";
import { THEME } from "./theme.js";

export interface PickerListProps<T> {
  items: readonly T[];
  selectedIndex: number;
  /** Rows the window may occupy; the caller's terminal budget decides it. */
  maxRows: number;
  /** `end` (pickers) or `center` (long catalogs). */
  align?: PickerWindowAlign;
  /** One row, drawn by the surface that knows what its items mean. */
  renderItem: (item: T, selected: boolean, absoluteIndex: number) => React.ReactNode;
  /** The `▲/▼ N more` indicators. On by default; a surface with its own footer turns it off. */
  indicators?: boolean;
}

/**
 * The one windowed list the console's pickers share.
 *
 * It owns nothing but the window: the row content stays with the surface
 * (`AgentPickerModal` marks the active runtime, `ProfilePickerModal` prints the
 * description, the model catalog draws provider and name in columns), so the
 * shared part is the arithmetic and the two "more above/below" lines that were
 * copy-pasted between modals.
 */
export function PickerList<T>({
  items,
  selectedIndex,
  maxRows,
  align = "end",
  renderItem,
  indicators = true,
}: PickerListProps<T>): React.ReactElement {
  const window = visibleWindow(items.length, selectedIndex, maxRows, align);
  const visible = items.slice(window.offset, window.end);
  return (
    <Box flexDirection="column">
      {indicators && hiddenAbove(window) > 0 && (
        <Text color={THEME.muted}>▲ {hiddenAbove(window)} more above</Text>
      )}
      {visible.map((item, index) => renderItem(item, window.offset + index === selectedIndex, window.offset + index))}
      {indicators && hiddenBelow(window) > 0 && (
        <Text color={THEME.muted}>▼ {hiddenBelow(window)} more below</Text>
      )}
    </Box>
  );
}
