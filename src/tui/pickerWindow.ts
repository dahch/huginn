/**
 * The scroll window every list-shaped console surface uses.
 *
 * Four modals (`AgentPickerModal`, `ProfilePickerModal`, `ModelPickerModal`,
 * `McpInspectorModal`) each re-derived "which rows are visible" with their own
 * clamp expression, and two of them used different alignments with the same
 * name. Off-by-one bugs in that arithmetic are invisible until a terminal is
 * short, so the math lives here once, is pure, and is pinned by tests.
 */

/** Where the selected row sits inside its window. */
export type PickerWindowAlign =
  /** Scroll only when the highlight would leave: it rides the bottom edge. */
  | "end"
  /** Keep the highlight near the middle (long, unreadable catalogs). */
  | "center";

export interface PickerWindow {
  /** Index of the first visible row. */
  offset: number;
  /** How many rows are visible (never more than `limit`, never more than remain). */
  length: number;
  /** Exclusive end index (`offset + length`). */
  end: number;
  /** Total rows the window was computed over. */
  total: number;
}

/** A usable row count: at least one, whole numbers only. */
export function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.floor(limit));
}

/** Keep an index inside `[0, total - 1]`, and `0` for an empty list. */
export function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.floor(index)), total - 1);
}

/**
 * The visible slice around `selectedIndex`.
 *
 * `end` alignment matches the pickers' original behaviour (the highlight only
 * moves the window when it would otherwise scroll off); `center` matches the
 * model catalog and the MCP inspector, where a catalog of thousands reads
 * better with the selection in the middle. Both clamp to the same bounds, so a
 * short terminal can never scroll past the last row.
 */
export function visibleWindow(
  total: number,
  selectedIndex: number,
  limit: number,
  align: PickerWindowAlign = "end",
): PickerWindow {
  const rows = Math.max(0, Math.floor(total));
  const size = normalizeLimit(limit);
  const selected = clampIndex(selectedIndex, rows);
  const maxOffset = Math.max(0, rows - size);
  const lead = align === "center" ? Math.floor(size / 2) : size - 1;
  const offset = Math.min(Math.max(0, selected - lead), maxOffset);
  const length = Math.max(0, Math.min(size, rows - offset));
  return { offset, length, end: offset + length, total: rows };
}

/** Rows hidden above the window (for the `▲ N more above` line). */
export function hiddenAbove(window: PickerWindow): number {
  return window.offset;
}

/** Rows hidden below the window (for the `▼ N more below` line). */
export function hiddenBelow(window: PickerWindow): number {
  return Math.max(0, window.total - window.end);
}

/**
 * Case-insensitive substring filter over one or more fields.
 *
 * A blank query returns the input array unchanged (same reference), so a
 * `useMemo` keyed on the query does not allocate on every keystroke that clears
 * the filter.
 */
export function filterByQuery<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => Array<string | undefined>,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter((item) =>
    fields(item).some((field) => (field ?? "").toLowerCase().includes(needle)),
  );
}
