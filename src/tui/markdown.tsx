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
}

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
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), color: defaultColor });
    }
    const raw = match[0];
    if (raw.startsWith("`") && raw.endsWith("`") && raw.length >= 2) {
      segments.push({ text: raw.slice(1, -1), color: THEME.accentStrong });
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

/**
 * The styled runs of one markdown line, *including* its block prefix (heading
 * marker, bullet, quote bar) so the prefix keeps its column in the width math.
 * {@link MarkdownLine} renders this; the live console pre-wraps it.
 */
export function markdownSegments(
  text: string,
  defaultColor: string | undefined = THEME.text,
): MdSegment[] {
  // Code fence
  if (/^```/.test(text)) {
    const lang = text.slice(3).trim();
    return [{ text: `─── ${lang ? `[${lang}]` : "code"} ──────────────────────────────`, dim: true }];
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
    return [{ text: "────────────────────────────────────────", dim: true }];
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
}: {
  text: string;
  defaultColor?: string | undefined;
  wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";
}) {
  return (
    <Text wrap={wrap}>
      {renderSegments(markdownSegments(text, defaultColor))}
    </Text>
  );
}
