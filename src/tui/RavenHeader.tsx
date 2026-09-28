import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { HUGINN_WORDMARK, RAVEN_MARK, artWidth } from "../brand.js";
import { sanitizeTerminalText } from "../util/text.js";
import { useTerminalSize, type TerminalSize } from "./useTerminalSize.js";

/**
 * Shared TUI brand header (REQ-29 / ADR-29).
 *
 * One component renders the ASCII raven mark next to the `HUGINN` wordmark for
 * both dashboards, so the two headers cannot diverge (AC-29.2), and it degrades
 * gracefully on narrow and short terminals instead of squeezing the viewport
 * (AC-29.3). The long-lived glyphs are ASCII only — no eagle emoji anywhere
 * (AC-29.1) — and every dynamic value rendered by the callers' rows is
 * sanitized and width-clamped, so the header can never wrap into extra rows.
 */

/** Rows the rounded border adds to a header box (top + bottom). */
export const HEADER_BORDER_ROWS = 2;
/** Rows the plain-text fallback spends on the brand itself (`HUGINN LIVE`). */
export const HEADER_TEXT_BRAND_ROWS = 1;
/** Horizontal chrome a header box spends: 1-column border + 1 column of padding per side. */
export const HEADER_HORIZONTAL_CHROME = 4;
/** Blank columns between the raven mark and the wordmark. */
export const RAVEN_ART_GAP = 2;
/**
 * Full treatment (mark + wordmark) is only shown from this width up: below it the
 * wordmark alone reads better than a mark squeezed against it.
 */
export const RAVEN_FULL_MIN_COLUMNS = 72;

export const RAVEN_MARK_ROWS = RAVEN_MARK.length;
export const RAVEN_MARK_WIDTH = artWidth(RAVEN_MARK);
export const WORDMARK_ROWS = HUGINN_WORDMARK.length;
export const WORDMARK_WIDTH = artWidth(HUGINN_WORDMARK);
/** The art block is as tall as the wordmark; the mark is centred inside it. */
export const RAVEN_ART_ROWS = WORDMARK_ROWS;
/** Visible width of the composed mark + wordmark art. */
export const RAVEN_ART_WIDTH = RAVEN_MARK_WIDTH + RAVEN_ART_GAP + WORDMARK_WIDTH;

/**
 * Rows the surrounding layout keeps for itself before the header may spend any
 * on art: the two 4-row card floors, the input row, the footer, the tallest
 * command palette (6 content rows + border) and the palette's own border — i.e.
 * the budget AC-28.4 depends on. Callers pass their own figure; this is the
 * live-view default used by {@link RavenHeader}.
 */
export const RAVEN_VIEWPORT_RESERVED_ROWS = 19;

/** Rows of vertical offset applied to the mark inside the wordmark block. */
const MARK_TOP_OFFSET = Math.floor((RAVEN_ART_ROWS - RAVEN_MARK_ROWS) / 2);

export type RavenHeaderVariant = "full" | "wordmark" | "text";

export interface RavenHeaderSizing {
  /** Terminal width in columns. */
  columns: number;
  /** Terminal height in rows. */
  rows: number;
  /** Context rows the caller renders under (or beside) the brand. */
  contextRows: number;
  /** Rows the caller's layout must keep outside the header (defaults to the live figure). */
  reservedRows?: number;
  /** Columns the caller's container already spends (e.g. its own `paddingX`). */
  outerInset?: number;
}

export interface RavenHeaderPlan {
  variant: RavenHeaderVariant;
  /** Rows occupied by the ASCII art (0 for the plain-text fallback). */
  artRows: number;
  /** Context rows the caller promised to render. */
  contextRows: number;
  /** Rows the whole header box consumes, border included. */
  height: number;
  /** Visible width of the art block (`0` for the plain-text fallback). */
  artWidth: number;
  /** Columns available inside the header box — the budget for every context row. */
  contentWidth: number;
  columns: number;
  rows: number;
  reservedRows: number;
}

export interface RavenArtRow {
  /** Left column: the raven mark (blank-padded, `""` for wordmark-only). */
  mark: string;
  /** Right column: one `HUGINN` wordmark row. */
  wordmark: string;
}

/** One row of the composed art block, ready to render as two adjacent `Text`s. */
export function buildRavenArtRows(variant: Exclude<RavenHeaderVariant, "text">): RavenArtRow[] {
  const rows: RavenArtRow[] = [];
  for (let index = 0; index < RAVEN_ART_ROWS; index += 1) {
    const wordmark = HUGINN_WORDMARK[index] ?? "";
    if (variant === "wordmark") {
      rows.push({ mark: "", wordmark });
      continue;
    }
    const markIndex = index - MARK_TOP_OFFSET;
    const markRow = markIndex >= 0 && markIndex < RAVEN_MARK_ROWS ? RAVEN_MARK[markIndex] ?? "" : "";
    rows.push({ mark: markRow.padEnd(RAVEN_MARK_WIDTH) + " ".repeat(RAVEN_ART_GAP), wordmark });
  }
  return rows;
}

/**
 * Derive the header's variant and exact row cost for a terminal size.
 *
 * Degradation is width-first — mark + wordmark → wordmark only → plain
 * `HUGINN` — and the art is additionally dropped when the terminal is too short
 * to afford it without eating into `reservedRows` (the viewport floor), which is
 * what keeps AC-28.4 true on an 80×24 terminal.
 */
export function ravenHeaderPlan(sizing: RavenHeaderSizing): RavenHeaderPlan {
  const columns = Math.max(0, Math.floor(sizing.columns));
  const rows = Math.max(0, Math.floor(sizing.rows));
  const contextRows = Math.max(0, Math.floor(sizing.contextRows));
  const reservedRows = Math.max(
    0,
    Math.floor(sizing.reservedRows ?? RAVEN_VIEWPORT_RESERVED_ROWS),
  );
  const outerInset = Math.max(0, Math.floor(sizing.outerInset ?? 0));
  const contentWidth = Math.max(0, columns - outerInset - HEADER_HORIZONTAL_CHROME);
  const artFitsRows =
    rows >= reservedRows + HEADER_BORDER_ROWS + RAVEN_ART_ROWS + contextRows;

  let variant: RavenHeaderVariant = "text";
  if (artFitsRows && columns >= RAVEN_FULL_MIN_COLUMNS && contentWidth >= RAVEN_ART_WIDTH) {
    variant = "full";
  } else if (artFitsRows && contentWidth >= WORDMARK_WIDTH) {
    variant = "wordmark";
  }

  const artRows = variant === "text" ? 0 : RAVEN_ART_ROWS;
  return {
    variant,
    artRows,
    contextRows,
    height:
      HEADER_BORDER_ROWS + artRows + contextRows + (variant === "text" ? HEADER_TEXT_BRAND_ROWS : 0),
    artWidth: variant === "full" ? RAVEN_ART_WIDTH : variant === "wordmark" ? WORDMARK_WIDTH : 0,
    contentWidth,
    columns,
    rows,
    reservedRows,
  };
}

/**
 * The plan for the current terminal. Callers feed `.height` into their layout
 * budget so the rows the header claims are always the rows it actually draws.
 */
export function useRavenHeaderPlan(
  contextRows: number,
  reservedRows: number = RAVEN_VIEWPORT_RESERVED_ROWS,
  size?: TerminalSize,
  outerInset = 0,
): RavenHeaderPlan {
  const measured = useTerminalSize();
  const { columns, rows } = size ?? measured;
  return useMemo(
    () => ravenHeaderPlan({ columns, rows, contextRows, reservedRows, outerInset }),
    [columns, rows, contextRows, reservedRows, outerInset],
  );
}

/**
 * Sanitize and width-clamp a dynamic header value (runtime name, project path,
 * model ids…) so it can never widen a header row past the terminal (AC-29.3).
 * Also normalizes tabs/newlines, which would otherwise forge extra rows.
 */
export function headerValue(value: string | null | undefined, maxWidth: number): string {
  const clean = sanitizeTerminalText(value ?? "").replace(/\s+/g, " ").trim();
  return clean.slice(0, Math.max(0, Math.floor(maxWidth)));
}

export interface RavenHeaderProps {
  /** Layout plan from {@link ravenHeaderPlan} / {@link useRavenHeaderPlan}. */
  plan: RavenHeaderPlan;
  /**
   * Brand suffix shown by the plain-text fallback (`HUGINN LIVE`). The ASCII
   * wordmark already spells the brand in the art variants, so the suffix is a
   * fallback-only affordance.
   */
  suffix?: string;
  /**
   * Live context rows. Each row is a list of one or two cells: the header lays
   * them out `space-between` on a single clipped line, so a caller cannot
   * accidentally add rows the budget did not reserve.
   */
  rows: React.ReactNode[][];
}

/**
 * The raven header box. Rendering it never emits more rows than `plan.height`,
 * and never a line wider than the terminal: the art is width-checked by
 * {@link ravenHeaderPlan}, `plan.contentWidth` is the budget every row is
 * clamped to, and each row is clipped to one line.
 */
export function RavenHeader({ plan, suffix = "", rows }: RavenHeaderProps): React.ReactElement {
  const brand = suffix ? `HUGINN ${suffix}` : "HUGINN";
  const artRows = plan.artRows > 0 ? buildRavenArtRows(plan.variant === "wordmark" ? "wordmark" : "full") : [];

  return (
    // flexShrink={0}: the header's row cost is exactly what the caller budgeted
    // for, so a crowded frame must shrink the flexible cards, never the brand.
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} flexShrink={0}>
      {artRows.length > 0 ? (
        <Box flexDirection="column">
          {artRows.map((row, index) => (
            <Box key={`art-${index}`} height={1} flexDirection="row">
              {row.mark.length > 0 && (
                <Text bold color="cyanBright" wrap="truncate">
                  {row.mark}
                </Text>
              )}
              <Text bold color="cyan" wrap="truncate">
                {row.wordmark}
              </Text>
            </Box>
          ))}
        </Box>
      ) : (
        // Narrow/short terminal: plain brand text, no art (AC-29.1 fallback).
        <Box height={HEADER_TEXT_BRAND_ROWS} overflow="hidden">
          <Text bold color="cyan" wrap="truncate">
            {brand}
          </Text>
        </Box>
      )}

      {rows.map((cells, rowIndex) => (
        <Box
          key={`row-${rowIndex}`}
          height={1}
          overflow="hidden"
          flexDirection="row"
          justifyContent="space-between"
        >
          {cells.map((cell, cellIndex) => (
            <Box key={`cell-${cellIndex}`} flexDirection="row" flexShrink={1}>
              {cell}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
