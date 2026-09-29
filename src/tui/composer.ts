/**
 * Composer input model (Phase 6 / REQ-6).
 *
 * The live composer is a real text editor: a caret that can be moved with the
 * arrows (and Home/End, and Ctrl/⌥+←/→ by word), in-place insertion, backspace
 * and delete, and a draft that soft-wraps onto several visual rows and grows —
 * scrolling internally once it reaches {@link MAX_INPUT_ROWS}.
 *
 * Every rule of that model lives here as a pure function so the cursor
 * semantics can be pinned down without mounting Ink, and so the component and
 * its tests can never disagree about where the caret is.
 */
import { sanitizeTerminalText } from "../util/text.js";

/** Content rows the composer may grow to before it starts scrolling internally. */
export const MAX_INPUT_ROWS = 6;

/**
 * The caret block: drawn between two characters (or at the end of the draft)
 * while a column is free for it, and drawn over the character it sits on when
 * the row is already full, so the caret never hides content (REV-6002).
 */
export const CURSOR_GLYPH = "▏";

export interface ComposerLayout {
  /** The wrapped visual rows of the draft, each at most `width` wide. */
  rows: string[];
  /** Index in the draft of the first character on each row. */
  rowStarts: number[];
  /** The row the caret sits on. */
  cursorRow: number;
  /** The column the caret sits at within {@link cursorRow}. */
  cursorCol: number;
}

/** Both halves of an edit, so the draft and the caret always move together. */
export interface ComposerEdit {
  text: string;
  cursor: number;
}

/** One rendered row, split around the caret cell. */
export interface CursorLineParts {
  /** The row's text before the caret cell. */
  before: string;
  /**
   * The single column the caret occupies, painted in reverse video: the caret
   * glyph when the row still had a free column for it, the character it covers
   * when the row was already full (so nothing is pushed off the row —
   * REV-6002), or `""` when there is no column to draw in at all (REV-6003).
   */
  caret: string;
  /** The row's text after the caret cell. */
  tail: string;
}

/**
 * Split one rendered row into the three cells the composer paints it with.
 *
 * `before` + `caret` + `tail` is never wider than `width`, wherever the caret
 * sits — which is what lets the composer stay inside the terminal (REV-3201) —
 * and it always spells out the whole visible row, character for character: the
 * caret is drawn *between* characters only when a column is actually free for
 * {@link CURSOR_GLYPH}, and drawn *on* the character otherwise, never dropping
 * content to make room for itself (REV-6002). With no column at all
 * (`width <= 0`) every cell is empty, so the result is `""` (REV-6003).
 */
export function cursorLineParts(line: string, cursor: number, width: number): CursorLineParts {
  const room = Math.max(0, Math.floor(width));
  if (room === 0) return { before: "", caret: "", tail: "" };
  const visible = line.slice(0, room);
  const col = Math.max(0, Math.min(Math.floor(cursor), visible.length, room - 1));
  const before = visible.slice(0, col);
  const rest = visible.slice(col);
  // A free column is one the row does not already fill at this point.
  if (rest.length === 0 || before.length + 1 + rest.length <= room) {
    return { before, caret: CURSOR_GLYPH, tail: rest };
  }
  return { before, caret: rest.slice(0, 1), tail: rest.slice(1) };
}

/**
 * The row as it reads on screen: the caret cell sits between `before` and
 * `tail`, and is the character it covers whenever the row has no free column
 * for the caret glyph itself. Never wider than `width`.
 */
export function composeCursorLine(line: string, cursor: number, width: number): string {
  const { before, caret, tail } = cursorLineParts(line, cursor, width);
  return `${before}${caret}${tail}`;
}

/** Clamp a caret index into `[0, text.length]`. */
export function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(Math.floor(cursor), text.length));
}

/**
 * Wrap `text` into the visual rows a `width`-wide box shows and locate the
 * caret in them. Wrapping is hard (character based), exactly like a terminal's
 * own soft wrap, and an explicit `\n` starts a new row of its own.
 *
 * A caret landing precisely on a wrap boundary (`column === width`) is placed on
 * the *next* row: the composer grows the moment the edge is reached instead of
 * painting the caret past the last column.
 */
export function layoutComposer(text: string, cursor: number, width: number): ComposerLayout {
  const w = Math.max(1, Math.floor(width));
  const target = clampCursor(text, cursor);

  const rows: string[] = [];
  const rowStarts: number[] = [];
  let index = 0;
  for (;;) {
    const newline = text.indexOf("\n", index);
    const end = newline === -1 ? text.length : newline;
    const length = end - index;
    const chunks = Math.max(1, Math.ceil(length / w));
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const start = index + chunk * w;
      rows.push(text.slice(start, Math.min(start + w, end)));
      rowStarts.push(start);
    }
    if (newline === -1) break;
    index = newline + 1;
  }

  // The caret's row is the last one that starts at or before it.
  let cursorRow = 0;
  for (let row = 0; row < rowStarts.length; row += 1) {
    if (rowStarts[row]! <= target) cursorRow = row;
    else break;
  }
  let cursorCol = target - rowStarts[cursorRow]!;
  if (cursorCol >= w) {
    cursorRow += 1;
    cursorCol = 0;
  }
  // The boundary row may not exist yet — the caret is one past the last chunk.
  while (rows.length <= cursorRow) {
    rows.push("");
    rowStarts.push(text.length);
  }

  return { rows, rowStarts, cursorRow, cursorCol };
}

/** Map a `(row, column)` back to a caret index, clamping the column to the row. */
export function cursorIndexAtRow(layout: ComposerLayout, row: number, col: number): number {
  const r = Math.max(0, Math.min(row, layout.rows.length - 1));
  const start = layout.rowStarts[r] ?? 0;
  const length = layout.rows[r]?.length ?? 0;
  return start + Math.max(0, Math.min(Math.floor(col), length));
}

/** Caret index of the first column of the caret's own visual row (Home, REV-6004). */
export function caretRowStart(layout: ComposerLayout): number {
  return layout.rowStarts[layout.cursorRow] ?? 0;
}

/** Caret index just past the caret's own visual row (End, REV-6004). */
export function caretRowEnd(layout: ComposerLayout): number {
  const start = layout.rowStarts[layout.cursorRow] ?? 0;
  return start + (layout.rows[layout.cursorRow]?.length ?? 0);
}

/**
 * Content rows the composer may claim on a `rows`-tall terminal, once
 * `shellRows` — the header, the footer, the log tail, a pending decision, the
 * open palette, the composer's own chrome and the conversation card's floor —
 * are paid for (REV-6001).
 *
 * The composer grows last: it never takes a row the rest of the frame needs, so
 * the input row and the footer always stay on screen. When nothing is left it
 * keeps its one-row floor rather than pushing the frame off the terminal, and it
 * never exceeds {@link MAX_INPUT_ROWS} — past that it scrolls internally.
 */
export function composerRowBudget(rows: number, shellRows: number, draftRows: number): number {
  const total = Number.isFinite(rows) ? Math.floor(rows) : 0;
  const shell = Number.isFinite(shellRows) ? Math.max(0, Math.floor(shellRows)) : 0;
  const draft = Number.isFinite(draftRows) ? Math.max(1, Math.floor(draftRows)) : 1;
  return Math.max(1, Math.min(MAX_INPUT_ROWS, draft, total - shell));
}

/**
 * First visible row so the caret's row stays on screen: `0` while it fits, and
 * otherwise just enough scroll to bring it to the bottom edge.
 */
export function composerScroll(cursorRow: number, totalRows: number, visibleRows: number): number {
  const visible = Math.max(1, Math.floor(visibleRows));
  const maxScroll = Math.max(0, totalRows - visible);
  return Math.max(0, Math.min(cursorRow - visible + 1, maxScroll));
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && char !== "" && !/\s/.test(char);
}

/** Move the caret one character left, or to the start of the previous word. */
export function moveCursorLeft(text: string, cursor: number, byWord = false): number {
  const c = clampCursor(text, cursor);
  if (c === 0) return 0;
  if (!byWord) return c - 1;
  let i = c;
  while (i > 0 && !isWordChar(text[i - 1])) i -= 1;
  while (i > 0 && isWordChar(text[i - 1])) i -= 1;
  return i;
}

/** Move the caret one character right, or past the end of the next word. */
export function moveCursorRight(text: string, cursor: number, byWord = false): number {
  const c = clampCursor(text, cursor);
  if (c >= text.length) return text.length;
  if (!byWord) return c + 1;
  let i = c;
  while (i < text.length && isWordChar(text[i])) i += 1;
  while (i < text.length && !isWordChar(text[i])) i += 1;
  return i;
}

/** Insert `insert` at the caret, leaving the caret after the inserted text. */
export function insertAt(text: string, cursor: number, insert: string): ComposerEdit {
  const c = clampCursor(text, cursor);
  if (!insert) return { text, cursor: c };
  return { text: text.slice(0, c) + insert + text.slice(c), cursor: c + insert.length };
}

/** Backspace: delete the character *before* the caret. */
export function deleteBefore(text: string, cursor: number): ComposerEdit {
  const c = clampCursor(text, cursor);
  if (c === 0) return { text, cursor: 0 };
  return { text: text.slice(0, c - 1) + text.slice(c), cursor: c - 1 };
}

/** Delete: remove the character *at* the caret, keeping the caret in place. */
export function deleteAt(text: string, cursor: number): ComposerEdit {
  const c = clampCursor(text, cursor);
  if (c >= text.length) return { text, cursor: c };
  return { text: text.slice(0, c) + text.slice(c + 1), cursor: c };
}

/**
 * Ctrl/⌥+Backspace: delete back to the start of the word the caret ends
 * (REV-6006). Same word boundaries as {@link moveCursorLeft} by word, so the
 * caret always lands exactly where a word jump would put it.
 */
export function deleteWordBefore(text: string, cursor: number): ComposerEdit {
  const c = clampCursor(text, cursor);
  if (c === 0) return { text, cursor: 0 };
  const from = moveCursorLeft(text, c, true);
  return { text: text.slice(0, from) + text.slice(c), cursor: from };
}

/** Ctrl/⌥+Delete: delete forward to the end of the next word (REV-6006). */
export function deleteWordAfter(text: string, cursor: number): ComposerEdit {
  const c = clampCursor(text, cursor);
  if (c >= text.length) return { text, cursor: c };
  const to = moveCursorRight(text, c, true);
  return { text: text.slice(0, c) + text.slice(to), cursor: c };
}

/**
 * Sanitize a keypress payload before it enters the draft. Beyond the escape and
 * control stripping the rest of the TUI already does, the composer also drops
 * tabs and newlines: Enter *sends*, it never inserts a line break, and a pasted
 * block becomes a single (soft-wrapped) line.
 */
export function sanitizeComposerInput(input: string): string {
  return sanitizeTerminalText(input).replace(/[\t\n\r]/g, "");
}
