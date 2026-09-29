/**
 * Phase 6 / REQ-6 — the composer's editing model.
 *
 * The caret, the in-place edits and the visual wrapping are pure, so they are
 * pinned down here directly: the render tests that follow only have to prove the
 * component wires them up.
 */
import { describe, expect, it } from "vitest";
import {
  CURSOR_GLYPH,
  MAX_INPUT_ROWS,
  caretRowEnd,
  caretRowStart,
  composeCursorLine,
  composerRowBudget,
  composerScroll,
  cursorIndexAtRow,
  cursorLineParts,
  deleteAt,
  deleteBefore,
  deleteWordAfter,
  deleteWordBefore,
  insertAt,
  layoutComposer,
  moveCursorLeft,
  moveCursorRight,
  sanitizeComposerInput,
} from "../../src/tui/composer.js";

describe("composer caret movement (REQ-6)", () => {
  it("moves one character at a time and clamps to the ends", () => {
    expect(moveCursorLeft("abc", 2)).toBe(1);
    expect(moveCursorLeft("abc", 0)).toBe(0);
    expect(moveCursorRight("abc", 1)).toBe(2);
    expect(moveCursorRight("abc", 3)).toBe(3);
    // Out-of-range carets are clamped before they move.
    expect(moveCursorLeft("abc", 99)).toBe(2);
    expect(moveCursorRight("abc", -5)).toBe(1);
  });

  it("moves whole words for a Ctrl/⌥ arrow", () => {
    const text = "foo bar baz";
    expect(moveCursorRight(text, 0, true)).toBe(4);
    expect(moveCursorRight(text, 4, true)).toBe(8);
    expect(moveCursorRight(text, 8, true)).toBe(11);
    expect(moveCursorLeft(text, 11, true)).toBe(8);
    expect(moveCursorLeft(text, 7, true)).toBe(4);
    expect(moveCursorLeft(text, 0, true)).toBe(0);
  });

  it("steps over runs of spaces without stalling", () => {
    // "a    b" — from just after the `a`, a word jump lands on the `b`.
    expect(moveCursorRight("a    b", 1, true)).toBe(5);
    // From the end, a word jump lands on the start of the current word…
    expect(moveCursorLeft("a    b", 6, true)).toBe(5);
    // …and from there, on the start of the previous one.
    expect(moveCursorLeft("a    b", 5, true)).toBe(0);
  });
});

describe("composer in-place editing (REQ-6)", () => {
  it("inserts at the caret, not at the end", () => {
    expect(insertAt("ac", 1, "b")).toEqual({ text: "abc", cursor: 2 });
    expect(insertAt("abc", 3, "!")).toEqual({ text: "abc!", cursor: 4 });
    expect(insertAt("abc", 0, ">")).toEqual({ text: ">abc", cursor: 1 });
    // An empty payload is a no-op that still reports a valid caret.
    expect(insertAt("abc", 1, "")).toEqual({ text: "abc", cursor: 1 });
  });

  it("backspaces the character before the caret", () => {
    expect(deleteBefore("abc", 2)).toEqual({ text: "ac", cursor: 1 });
    expect(deleteBefore("abc", 0)).toEqual({ text: "abc", cursor: 0 });
    expect(deleteBefore("abc", 3)).toEqual({ text: "ab", cursor: 2 });
  });

  it("deletes the character at the caret, keeping it in place", () => {
    expect(deleteAt("abc", 1)).toEqual({ text: "ac", cursor: 1 });
    expect(deleteAt("abc", 0)).toEqual({ text: "bc", cursor: 0 });
    // Past the end there is nothing to delete.
    expect(deleteAt("abc", 3)).toEqual({ text: "abc", cursor: 3 });
  });

  it("clamps a stale caret so an edit can never split the wrong character", () => {
    expect(insertAt("abc", 99, "x")).toEqual({ text: "abcx", cursor: 4 });
    expect(deleteBefore("abc", 99)).toEqual({ text: "ab", cursor: 2 });
    expect(deleteAt("abc", -3)).toEqual({ text: "bc", cursor: 0 });
  });

  it("deletes whole words backwards for Ctrl/⌥+Backspace (REV-6006)", () => {
    expect(deleteWordBefore("foo bar baz", 11)).toEqual({ text: "foo bar ", cursor: 8 });
    expect(deleteWordBefore("foo bar baz", 7)).toEqual({ text: "foo  baz", cursor: 4 });
    // Mid-word, it deletes up to the start of that word, like a word jump back.
    expect(deleteWordBefore("foo bar", 5)).toEqual({ text: "foo ar", cursor: 4 });
    // The blanks before a word go with it.
    expect(deleteWordBefore("a    b", 6)).toEqual({ text: "a    ", cursor: 5 });
    // Nothing left to delete keeps the draft and the caret untouched.
    expect(deleteWordBefore("abc", 0)).toEqual({ text: "abc", cursor: 0 });
  });

  it("deletes whole words forwards for Ctrl/⌥+Delete (REV-6006)", () => {
    expect(deleteWordAfter("foo bar baz", 0)).toEqual({ text: "bar baz", cursor: 0 });
    expect(deleteWordAfter("foo bar baz", 4)).toEqual({ text: "foo baz", cursor: 4 });
    expect(deleteWordAfter("a    b", 1)).toEqual({ text: "ab", cursor: 1 });
    // Past the end there is nothing to delete.
    expect(deleteWordAfter("abc", 3)).toEqual({ text: "abc", cursor: 3 });
    expect(deleteWordAfter("abc", 99)).toEqual({ text: "abc", cursor: 3 });
  });
});

describe("composer wrapping & caret layout (REQ-6)", () => {
  it("keeps an empty draft on a single row", () => {
    expect(layoutComposer("", 0, 10)).toEqual({
      rows: [""],
      rowStarts: [0],
      cursorRow: 0,
      cursorCol: 0,
    });
  });

  it("hard-wraps a long draft at the width and places the caret on its row", () => {
    const layout = layoutComposer("abcdefghij", 7, 5);
    expect(layout.rows).toEqual(["abcde", "fghij"]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(2);
  });

  it("grows a row the moment the caret reaches the soft-wrap edge", () => {
    const layout = layoutComposer("abcdefghij", 10, 5);
    // The caret sits one past the last column, so it belongs to a fresh row.
    expect(layout.rows).toEqual(["abcde", "fghij", ""]);
    expect(layout.cursorRow).toBe(2);
    expect(layout.cursorCol).toBe(0);
  });

  it("starts a new row on an explicit newline", () => {
    const layout = layoutComposer("ab\ncd", 4, 10);
    expect(layout.rows).toEqual(["ab", "cd"]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(1);
  });

  it("maps a (row, column) back to a caret index, clamping the column", () => {
    const layout = layoutComposer("abcdefghij", 0, 5);
    expect(cursorIndexAtRow(layout, 1, 2)).toBe(7);
    expect(cursorIndexAtRow(layout, 1, 99)).toBe(10);
    expect(cursorIndexAtRow(layout, 0, 0)).toBe(0);
    // Out-of-range rows clamp to the last one.
    expect(cursorIndexAtRow(layout, 9, 0)).toBe(5);
  });

  it("finds the start and end of the caret's own visual row (REV-6004)", () => {
    // "abcdefghij" wraps at 5: row 0 = "abcde", row 1 = "fghij".
    const layout = layoutComposer("abcdefghij", 7, 5);
    expect(layout.cursorRow).toBe(1);
    expect(caretRowStart(layout)).toBe(5);
    expect(caretRowEnd(layout)).toBe(10);

    const first = layoutComposer("abcdefghij", 2, 5);
    expect(caretRowStart(first)).toBe(0);
    expect(caretRowEnd(first)).toBe(5);

    // An explicit newline ends the row even when it is not full.
    const explicit = layoutComposer("ab\ncdefg", 8, 10);
    expect(explicit.cursorRow).toBe(1);
    expect(caretRowStart(explicit)).toBe(3);
    expect(caretRowEnd(explicit)).toBe(8);
  });
});

describe("composer row budget (REQ-6, REV-6001)", () => {
  it("grows with the draft while the shell can afford it", () => {
    expect(composerRowBudget(40, 15, 3)).toBe(3);
    expect(composerRowBudget(40, 15, 99)).toBe(MAX_INPUT_ROWS);
  });

  it("never claims rows the rest of the frame needs", () => {
    // 22 rows, 17 of them needed elsewhere: only 5 content rows are left.
    expect(composerRowBudget(22, 17, 6)).toBe(5);
    // Even fewer … and when nothing is left the composer keeps its floor.
    expect(composerRowBudget(20, 17, 6)).toBe(3);
    expect(composerRowBudget(20, 40, 6)).toBe(1);
    expect(composerRowBudget(4, 40, 6)).toBe(1);
  });

  it("keeps the composer visible and inside the frame at every height", () => {
    // `shell` counts the composer's own chrome too, exactly as the view passes it.
    const shell = 16;
    for (let rows = 17; rows <= 40; rows += 1) {
      const budget = composerRowBudget(rows, shell, 6);
      expect(budget, `${rows} rows`).toBeGreaterThanOrEqual(1);
      expect(budget, `${rows} rows`).toBeLessThanOrEqual(MAX_INPUT_ROWS);
      expect(budget + shell, `${rows} rows`).toBeLessThanOrEqual(rows);
    }
    // Below the irreducible minimum the composer still keeps its floor — the
    // input row and the footer are never the rows that vanish first.
    expect(composerRowBudget(9, shell, 6)).toBe(1);
    expect(composerRowBudget(30, shell, 6)).toBe(MAX_INPUT_ROWS);
  });
});

describe("composer scroll window (REQ-6)", () => {
  it("does not scroll while the caret fits", () => {
    expect(composerScroll(0, 3, 1)).toBe(0);
    expect(composerScroll(5, 8, 6)).toBe(0);
  });

  it("scrolls just enough to bring the caret's row to the bottom edge", () => {
    expect(composerScroll(7, 8, 6)).toBe(2);
    expect(composerScroll(6, 7, 6)).toBe(1);
  });

  it("never scrolls past the last page, whatever the caret row", () => {
    expect(composerScroll(99, 8, 6)).toBe(2);
    expect(composerScroll(99, 6, 6)).toBe(0);
  });

  it("always keeps the caret's row inside the visible window", () => {
    for (let total = 1; total <= 12; total += 1) {
      for (let cursorRow = 0; cursorRow < total; cursorRow += 1) {
        const scroll = composerScroll(cursorRow, total, MAX_INPUT_ROWS);
        expect(cursorRow, `row ${cursorRow}/${total}`).toBeGreaterThanOrEqual(scroll);
        expect(cursorRow).toBeLessThan(scroll + MAX_INPUT_ROWS);
      }
    }
  });
});

describe("composeCursorLine (REQ-6)", () => {
  it("paints the caret between the characters it sits between", () => {
    // The caret at index 1 is between `a` and `b`, and neither is hidden.
    expect(composeCursorLine("abc", 1, 10)).toBe(`a${CURSOR_GLYPH}bc`);
  });

  it("appends the caret at the end of the row", () => {
    expect(composeCursorLine("abc", 3, 10)).toBe(`abc${CURSOR_GLYPH}`);
  });

  it("keeps the caret glyph while the row still has a free column", () => {
    expect(composeCursorLine("abcde", 3, 6)).toBe(`abc${CURSOR_GLYPH}de`);
    expect(composeCursorLine("abcde", 5, 6)).toBe(`abcde${CURSOR_GLYPH}`);
  });

  it("paints the caret over the character it sits on when the row is full (REV-6002)", () => {
    // `caret === width - 1` on a row that fills every column: the caret has no
    // free column, so it must not push the last character off the row.
    const parts = cursorLineParts("abcdef", 5, 6);
    expect(parts).toEqual({ before: "abcde", caret: "f", tail: "" });
    expect(composeCursorLine("abcdef", 5, 6)).toBe("abcdef");
    expect(composeCursorLine("abcdef", 5, 6)).not.toContain(CURSOR_GLYPH);
  });

  it("never hides a character, wherever the caret is on a full row", () => {
    // A full row has no free column for the glyph at *any* caret position, so
    // every one of them has to overlay the character instead of clipping it.
    for (let col = 0; col <= 6; col += 1) {
      const rendered = composeCursorLine("abcdef", col, 6);
      expect(rendered.length, `col ${col}: ${JSON.stringify(rendered)}`).toBeLessThanOrEqual(6);
      expect(rendered, `col ${col}: ${JSON.stringify(rendered)}`).toBe("abcdef");
    }
  });

  it("never renders wider than the column budget, and drops nothing", () => {
    for (const line of ["", "a", "abcde", "abcdef", "abcdefg"]) {
      for (let col = 0; col <= line.length + 1; col += 1) {
        for (let width = 1; width <= 6; width += 1) {
          const rendered = composeCursorLine(line, col, width);
          const label = `${JSON.stringify(line)} @${col} w${width}: ${JSON.stringify(rendered)}`;
          expect(rendered.length, label).toBeLessThanOrEqual(width);
          // Stripping the caret cell gives the visible row back, character for
          // character: the caret never costs the terminal any content.
          expect(rendered.split(CURSOR_GLYPH).join(""), label).toBe(line.slice(0, width));
        }
      }
    }
  });

  it("returns nothing at all when there is no column to draw in (REV-6003)", () => {
    for (const width of [0, -1, -40]) {
      expect(composeCursorLine("abc", 1, width), `width ${width}`).toBe("");
      expect(composeCursorLine("", 0, width), `width ${width}`).toBe("");
      expect(cursorLineParts("abc", 1, width)).toEqual({ before: "", caret: "", tail: "" });
      expect(composeCursorLine("abc", 1, width).length).toBeLessThanOrEqual(Math.max(0, width));
    }
  });
});

describe("sanitizeComposerInput (REQ-6, SEC-001)", () => {
  it("drops control characters, including the newline Enter must never insert", () => {
    expect(sanitizeComposerInput("a\nb")).toBe("ab");
    expect(sanitizeComposerInput("a\tb")).toBe("ab");
    expect(sanitizeComposerInput("a\rb")).toBe("ab");
    expect(sanitizeComposerInput("a\u001b[31mb\u0007")).toBe("ab");
  });

  it("keeps legitimate non-ASCII text untouched", () => {
    expect(sanitizeComposerInput("café 😀 中文")).toBe("café 😀 中文");
  });
});
