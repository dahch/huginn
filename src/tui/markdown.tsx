import type React from "react";
import { Text } from "ink";
import stringWidth from "string-width";
import { THEME } from "./theme.js";

/**
 * One styled run of text: the unit both the Ink renderer and the width-aware
 * wrapper work on. Keeping the parse separate from the rendering is what makes
 * pre-wrapping possible — a line can be split at a column boundary *without*
 * breaking a `**bold**` or a `` `code` `` span, because the split happens
 * between (or inside) segments, never inside the markup.
 */
export interface MdSegment {
  text: string;
  color?: string | undefined;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  /** Links keep their label readable even when the URL is dimmed beside it. */
  underline?: boolean;
}

/** The terminal width a rule falls back to when the caller does not know it. */
const DEFAULT_MARKDOWN_WIDTH = 80;
/** Columns a table spends between two cells: `" │ "`. */
const TABLE_GAP = " │ ";
const TABLE_GAP_WIDTH = stringWidth(TABLE_GAP);

/**
 * Parses inline markdown tokens (`code`, **bold**, __bold__, *italic*, _italic_)
 * into styled segments. `defaultColor` is the body colour the caller has chosen
 * — usually `THEME.text` (`undefined`, i.e. the terminal's own foreground) — so
 * plain text is never forced to a colour that could vanish on the wrong
 * background (Phase 7A / REQ-12).
 */
export function inlineSegments(
  text: string,
  defaultColor: string | undefined = THEME.text,
): MdSegment[] {
  const segments: MdSegment[] = [];
  // A link is matched before the emphasis tokens so its label can be underlined
  // and its URL kept as one dim run instead of being parsed as body text.
  const regex = /(`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), color: defaultColor });
    }
    const raw = match[0];
    const link = raw.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (raw.startsWith("`") && raw.endsWith("`") && raw.length >= 2) {
      segments.push({ text: raw.slice(1, -1), color: THEME.accentStrong });
    } else if (link && link[1] !== undefined && link[2] !== undefined) {
      segments.push({ text: link[1], color: defaultColor, underline: true });
      segments.push({ text: ` ‹${link[2]}›`, color: defaultColor, dim: true });
    } else if (
      ((raw.startsWith("**") && raw.endsWith("**")) || (raw.startsWith("__") && raw.endsWith("__"))) &&
      raw.length >= 4
    ) {
      segments.push({ text: raw.slice(2, -2), color: defaultColor, bold: true });
    } else if (
      ((raw.startsWith("*") && raw.endsWith("*")) || (raw.startsWith("_") && raw.endsWith("_"))) &&
      raw.length >= 2
    ) {
      segments.push({ text: raw.slice(1, -1), color: defaultColor, italic: true });
    } else {
      segments.push({ text: raw, color: defaultColor });
    }
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), color: defaultColor });
  }

  return segments.length > 0 ? segments : [{ text, color: defaultColor }];
}

/** Ink nodes for a parsed run, preserving each segment's own style. */
export function renderSegments(segments: readonly MdSegment[], keyPrefix = "s"): React.ReactNode[] {
  return segments.map((segment, index) => (
    <Text
      key={`${keyPrefix}-${index}`}
      color={segment.color}
      bold={segment.bold}
      italic={segment.italic}
      underline={segment.underline === true}
      dimColor={THEME.colorEnabled && segment.dim === true}
    >
      {segment.text}
    </Text>
  ));
}

/**
 * Parses inline markdown tokens into styled Ink <Text> elements. Kept as the
 * node-shaped façade of {@link inlineSegments} for callers that render a whole
 * line and let Ink wrap it.
 */
export function renderInlineSpans(
  text: string,
  defaultColor: string | undefined = THEME.text,
): React.ReactNode[] {
  return renderSegments(inlineSegments(text, defaultColor));
}

/** The display width a rule should occupy, with a bounded fallback. */
function ruleColumns(width: number | undefined): number {
  const requested = width === undefined || !Number.isFinite(width) ? DEFAULT_MARKDOWN_WIDTH : width;
  return Math.max(1, Math.floor(requested));
}

/** A code-fence header exactly as wide as the card that will draw it. */
function codeFenceHeader(lang: string, width: number): MdSegment[] {
  const label = lang ? `[${lang}]` : "code";
  const prefix = `─── ${label} `;
  if (stringWidth(prefix) > width) return [{ text: "─".repeat(width), dim: true }];
  return [{ text: `${prefix}${"─".repeat(width - stringWidth(prefix))}`, dim: true }];
}

/**
 * The styled runs of one markdown line, *including* its block prefix (heading
 * marker, bullet, quote bar) so the prefix keeps its column in the width math.
 * {@link MarkdownLine} renders this; the live console pre-wraps it.
 */
export function markdownSegments(
  text: string,
  defaultColor: string | undefined = THEME.text,
  width?: number,
): MdSegment[] {
  const columns = ruleColumns(width);

  // Code fence
  if (/^```/.test(text)) {
    const lang = text.slice(3).trim();
    return codeFenceHeader(lang, columns);
  }

  const heading = (prefix: string, color: string | undefined, body: string): MdSegment[] => [
    { text: prefix, color, bold: true },
    ...inlineSegments(body, color).map((segment) => ({ ...segment, bold: true })),
  ];

  // Heading 1
  const h1 = text.match(/^#\s+(.+)$/);
  if (h1 && h1[1]) return heading("# ", THEME.accentStrong, h1[1]);

  // Heading 2
  const h2 = text.match(/^##\s+(.+)$/);
  if (h2 && h2[1]) return heading("## ", THEME.thinker, h2[1]);

  // Heading 3+
  const h3 = text.match(/^###+\s+(.+)$/);
  if (h3 && h3[1]) return heading("### ", THEME.info, h3[1]);

  // Unordered list / bullet (- item, * item)
  const bullet = text.match(/^(\s*)([-*+])\s+(.+)$/);
  if (bullet && bullet[1] !== undefined && bullet[3] !== undefined) {
    return [
      ...(bullet[1] ? [{ text: bullet[1], color: defaultColor }] : []),
      { text: "• ", color: THEME.accentStrong },
      ...inlineSegments(bullet[3], defaultColor),
    ];
  }

  // Ordered list (1. item, 2. item)
  const numList = text.match(/^(\s*)(\d+\.)\s+(.+)$/);
  if (numList && numList[1] !== undefined && numList[2] !== undefined && numList[3] !== undefined) {
    return [
      ...(numList[1] ? [{ text: numList[1], color: defaultColor }] : []),
      { text: `${numList[2]} `, color: THEME.warn, bold: true },
      ...inlineSegments(numList[3], defaultColor),
    ];
  }

  // Blockquote (> text)
  const quote = text.match(/^>\s*(.+)$/);
  if (quote && quote[1]) {
    return [{ text: "│ ", color: THEME.accent }, ...inlineSegments(quote[1], THEME.muted)];
  }

  // Horizontal rule (---, ***, ___)
  if (/^(\*\*\*|---|___)$/.test(text.trim())) {
    return [{ text: "─".repeat(columns), dim: true }];
  }

  return inlineSegments(text, defaultColor);
}

/** Display columns a run of segments occupies (double-width glyphs count twice). */
export function segmentsWidth(segments: readonly MdSegment[]): number {
  return segments.reduce((total, segment) => total + stringWidth(segment.text), 0);
}

/**
 * Splits one throwaway token at exactly `limit` display columns.
 * Returns `["", token]` when not even one glyph fits, so callers can stop.
 */
function splitAtWidth(text: string, limit: number): [string, string] {
  let head = "";
  let width = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (width + charWidth > limit) break;
    head += char;
    width += charWidth;
  }
  return [head, text.slice(head.length)];
}

/** A table row as raw markdown text or as already-split cells. */
export type TableRowInput = string | readonly string[];

function parseTableRow(row: TableRowInput): string[] {
  if (typeof row !== "string") return row.map((cell) => cell.trim());
  const trimmed = row.trim();
  if (trimmed === "") return [];
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isSeparatorCells(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function isTableSeparatorRow(line: string): boolean {
  return line.includes("|") && isSeparatorCells(parseTableRow(line));
}

/**
 * True when `lines[index]` is the header of a contiguous markdown table: the
 * next line must be a `|---|` separator. The block itself — not a single row —
 * is what gets aligned, because column widths cannot be known before the whole
 * table has been read.
 */
export function isTableHeader(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  if (header === undefined || separator === undefined) return false;
  if (!header.includes("|")) return false;
  return isTableSeparatorRow(separator);
}

/** Index just past the contiguous table block that starts at `index`. */
export function tableBlockEnd(lines: readonly string[], index: number): number {
  let end = index + 2;
  while (end < lines.length) {
    const line = lines[end];
    if (line === undefined || line.trim() === "" || !line.includes("|")) break;
    end += 1;
  }
  return end;
}

/** Append blanks until `text` occupies exactly `width` display columns. */
function padToWidth(text: string, width: number): string {
  const missing = width - stringWidth(text);
  return missing > 0 ? `${text}${" ".repeat(missing)}` : text;
}

/** Cut a cell to `width` columns, keeping the ellipsis inside the budget. */
function truncateCell(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  if (width === 1) return "…";
  const [head] = splitAtWidth(text, width - 1);
  return `${head}…`;
}

/** Keep at most `width` display columns, splitting a styled run only if needed. */
function clipSegments(segments: readonly MdSegment[], width: number): MdSegment[] {
  const clipped: MdSegment[] = [];
  let remaining = width;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const segmentWidth = stringWidth(segment.text);
    if (segmentWidth <= remaining) {
      clipped.push(segment);
      remaining -= segmentWidth;
      continue;
    }
    const [head] = splitAtWidth(segment.text, remaining);
    if (head !== "") clipped.push({ ...segment, text: head });
    break;
  }
  while (clipped.length > 0 && clipped[clipped.length - 1]!.text.trim() === "") clipped.pop();
  const last = clipped[clipped.length - 1];
  if (last !== undefined) {
    const trimmed = last.text.replace(/\s+$/, "");
    if (trimmed !== last.text) clipped[clipped.length - 1] = { ...last, text: trimmed };
  }
  return clipped;
}

/**
 * Formats a contiguous markdown table block for a terminal of `width` columns.
 *
 * Pure and block-shaped on purpose: every input row produces exactly one output
 * row, the columns are padded to the widest cell they contain, the column
 * separators are dim, and a row that cannot fit is truncated with `…` instead of
 * being wrapped into a second row (which would corrupt the card's row budget).
 * The function returns styled segments so the `│` separators can be dimmed
 * without leaking ANSI codes into the width math.
 */
export function tableBlock(rows: readonly TableRowInput[], width: number): MdSegment[][] {
  if (rows.length === 0) return [];
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const parsed = rows.map(parseTableRow);
  const separatorFlags = parsed.map((cells) => isSeparatorCells(cells));
  const contentRows = parsed.filter((_row, index) => !separatorFlags[index]);
  const columns = Math.max(1, ...parsed.map((row) => row.length));

  const natural = Array.from({ length: columns }, (_unused, column) => {
    let widest = 1;
    for (const row of contentRows) {
      widest = Math.max(widest, stringWidth(row[column] ?? ""));
    }
    return widest;
  });

  const gaps = TABLE_GAP_WIDTH * Math.max(0, columns - 1);
  const available = Math.max(0, limit - gaps);
  const widths = [...natural];
  let excess = widths.reduce((total, cell) => total + cell, 0) - available;
  while (excess > 0) {
    let widest = -1;
    for (let column = 0; column < widths.length; column++) {
      if (widths[column]! <= 1) continue;
      if (widest < 0 || widths[column]! > widths[widest]!) widest = column;
    }
    if (widest < 0) break;
    widths[widest] = widths[widest]! - 1;
    excess -= 1;
  }
  if (excess > 0) widths.fill(0);

  return parsed.map((cells, rowIndex) => {
    const isSeparator = separatorFlags[rowIndex] === true;
    const segments: MdSegment[] = [];
    for (let column = 0; column < columns; column++) {
      if (column > 0) segments.push({ text: TABLE_GAP, dim: true });
      const cellWidth = widths[column] ?? 0;
      if (isSeparator) {
        segments.push({ text: "─".repeat(cellWidth), dim: true });
      } else {
        const text = padToWidth(truncateCell(cells[column] ?? "", cellWidth), cellWidth);
        segments.push({ text, ...(rowIndex === 0 ? { bold: true } : {}) });
      }
    }
    return clipSegments(segments, limit);
  });
}

/**
 * Greedy, display-width-aware wrap of styled segments into terminal rows.
 *
 * Ink's own `wrap="wrap"` is unusable inside a fixed-height card: Yoga shrinks
 * the text node to the row it was allotted and the extra wrapped rows paint
 * over the following siblings (the conversation looked corrupted). Every row
 * returned here is at most `width` columns, so one row is exactly one terminal
 * row and the layout budget stays honest.
 */
export function wrapSegments(segments: readonly MdSegment[], width: number): MdSegment[][] {
  const limit = Math.max(1, width);
  const rows: MdSegment[][] = [];
  let row: MdSegment[] = [];
  /** Columns already spent on `row`, so the loop stays linear in the line length. */
  let used = 0;

  const pushRow = (): void => {
    // A wrapped row never keeps its trailing blanks: the border would be pushed
    // by padding that draws nothing.
    while (row.length > 0 && row[row.length - 1]!.text.trim() === "") row.pop();
    if (row.length > 0) {
      const last = row[row.length - 1]!;
      const trimmed = last.text.replace(/\s+$/, "");
      if (trimmed !== last.text) row[row.length - 1] = { ...last, text: trimmed };
    }
    rows.push(row);
    row = [];
    used = 0;
  };

  for (const segment of segments) {
    if (segment.text === "") continue;
    const parts = segment.text.split(/(\s+)/).filter((part) => part !== "");
    for (const part of parts) {
      const partWidth = stringWidth(part);
      if (/^\s+$/.test(part)) {
        // Whitespace that does not fit ends the row; whitespace that starts a
        // row is swallowed (a wrap already produced the break).
        if (used + partWidth > limit) {
          if (row.length > 0) pushRow();
        } else if (row.length > 0) {
          row.push({ ...segment, text: part });
          used += partWidth;
        }
        continue;
      }

      if (used + partWidth > limit && row.length > 0) pushRow();

      let rest = part;
      let restWidth = partWidth;
      while (restWidth > limit) {
        const [head, tail] = splitAtWidth(rest, limit);
        if (head === "") break;
        row.push({ ...segment, text: head });
        pushRow();
        rest = tail;
        restWidth = stringWidth(rest);
      }
      if (rest !== "") {
        row.push({ ...segment, text: rest });
        used += restWidth;
      }
    }
  }

  if (row.length > 0 || rows.length === 0) pushRow();
  // A line of pure whitespace still owns one row.
  return rows.length > 0 ? rows : [[]];
}

/**
 * Formats a single line of markdown with heading, bullet, list, quote, code fence,
 * and inline styles for Ink terminal rendering. All colours come from the theme
 * (Phase 7A / REQ-12) so a heading or a code span keeps its contrast on both
 * light and dark terminals.
 */
export function MarkdownLine({
  text,
  defaultColor = THEME.text,
  wrap = "wrap",
  width,
}: {
  text: string;
  defaultColor?: string | undefined;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
  /** Display columns of the container; rules are drawn exactly this wide. */
  width?: number;
}) {
  return (
    <Text wrap={wrap}>
      {renderSegments(markdownSegments(text, defaultColor, width))}
    </Text>
  );
}

/**
 * Formats a whole markdown block into **terminal rows**: one `MdSegment[]`
 * entry per row the card will draw. Tables are expanded block-by-block (their
 * column widths need every row in hand) and every other line is wrapped with
 * {@link wrapSegments}. This is the single formatting route shared by the run
 * panel, the live stream and the conversation, so the three surfaces cannot
 * disagree about how many rows a piece of text occupies.
 */
export function markdownBlockRows(
  lines: readonly string[],
  width: number,
  colorFor: (line: string, index: number) => string | undefined = () => THEME.text,
): MdSegment[][] {
  const columns = ruleColumns(width);
  const rows: MdSegment[][] = [];
  for (let index = 0; index < lines.length; index++) {
    if (isTableHeader(lines, index)) {
      const end = tableBlockEnd(lines, index);
      rows.push(...tableBlock(lines.slice(index, end), columns));
      index = end - 1;
      continue;
    }
    const text = lines[index] ?? "";
    rows.push(...wrapSegments(markdownSegments(text, colorFor(text, index), columns), columns));
  }
  return rows;
}

/**
 * Renders a whole markdown block (a report, a stream buffer or a message body)
 * at a known width. Every row comes from {@link markdownBlockRows}, so the text
 * is already wrapped and each rendered node is exactly one terminal row. The
 * `maxRows` tail keeps the last N rows when the caller budgets a report.
 */
export function MarkdownBlock({
  lines,
  width,
  colorFor = () => THEME.text,
  wrap = "truncate",
  maxRows,
}: {
  lines: readonly string[];
  width: number;
  colorFor?: (line: string, index: number) => string | undefined;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
  maxRows?: number;
}): React.ReactElement {
  const rows = markdownBlockRows(lines, width, colorFor);
  const limit = maxRows === undefined ? rows.length : Math.max(0, Math.floor(maxRows));
  const visible = maxRows === undefined ? rows : limit === 0 ? [] : rows.slice(-limit);
  return (
    <>
      {visible.map((segments, index) => (
        <Text key={`r-${index}`} wrap={wrap}>
          {segments.length === 0 ? " " : renderSegments(segments, `r-${index}`)}
        </Text>
      ))}
    </>
  );
}
