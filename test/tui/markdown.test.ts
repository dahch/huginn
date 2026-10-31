import { describe, expect, it } from "vitest";
import { markdownSegments, segmentsWidth, wrapSegments } from "../../src/tui/markdown";

describe("markdown segments", () => {
  it("keeps inline styling as segments and drops the markup", () => {
    const segments = markdownSegments("hola **mundo** y `codigo`", undefined);
    expect(segments.map((segment) => segment.text).join("")).toBe("hola mundo y codigo");
    expect(segments.find((segment) => segment.text === "mundo")?.bold).toBe(true);
    expect(segments.find((segment) => segment.text === "codigo")?.color).toBeDefined();
  });

  it("carries the block prefix so the width math sees it", () => {
    expect(markdownSegments("- item", undefined).map((segment) => segment.text).join("")).toBe("• item");
    expect(markdownSegments("## Titulo", undefined)[0]?.text).toBe("## ");
    expect(markdownSegments("> cita", undefined)[0]?.text).toBe("│ ");
    expect(markdownSegments("1. paso", undefined).map((segment) => segment.text).join("")).toBe("1. paso");
  });
});

describe("wrapSegments", () => {
  const sentence = "El correo se guarda unicamente en el navegador de quien se apunta";

  it("never exceeds the requested width and loses no content", () => {
    for (const width of [8, 12, 20, 40]) {
      const rows = wrapSegments(markdownSegments(sentence, undefined), width);
      for (const row of rows) {
        expect(segmentsWidth(row), `width=${width}`).toBeLessThanOrEqual(width);
      }
      const rejoined = rows.map((row) => row.map((segment) => segment.text).join("")).join(" ");
      // A word wider than the row is hard-split, so compare with blanks ignored.
      expect(rejoined.replace(/\s+/g, ""), `width=${width}`).toBe(sentence.replace(/\s+/g, ""));
    }
  });

  it("hard-splits a token wider than the row instead of overflowing", () => {
    const rows = wrapSegments([{ text: "x".repeat(25) }], 10);
    expect(rows.every((row) => segmentsWidth(row) <= 10)).toBe(true);
    expect(rows.map((row) => row[0]?.text ?? "").join("")).toBe("x".repeat(25));
  });

  it("counts double-width glyphs and keeps each row inside the width", () => {
    const rows = wrapSegments([{ text: "日本語 日本語" }], 7);
    expect(rows.map((row) => row.map((segment) => segment.text).join(""))).toEqual(["日本語", "日本語"]);
  });

  it("keeps a blank line as exactly one empty row", () => {
    expect(wrapSegments([], 20)).toEqual([[]]);
    expect(wrapSegments([{ text: "   " }], 20)).toEqual([[]]);
  });

  it("breaks between styled segments without splitting their markup", () => {
    const rows = wrapSegments(markdownSegments("uno dos **tres cuatro**", undefined), 10);
    for (const row of rows) expect(segmentsWidth(row)).toBeLessThanOrEqual(10);
    const bold = rows.flat().filter((segment) => segment.bold).map((segment) => segment.text).join(" ");
    expect(bold.trim()).toBe("tres cuatro");
  });
});
