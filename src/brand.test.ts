import { describe, it, expect } from "bun:test";
import {
  RAVEN_MARK,
  RAVEN_MOODS,
  TWO_RAVENS,
  artWidth,
  ravenMark,
  type RavenMood,
} from "./brand";

/** Every grapheme the art is allowed to contain: printable ASCII, no controls. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

describe("Raven moods (REQ-73)", () => {
  it("exposes exactly the three moods the header can draw", () => {
    expect(Object.keys(RAVEN_MOODS).sort()).toEqual(["idle", "sleeping", "thinking"]);
    for (const mood of ["idle", "thinking", "sleeping"] as const) {
      expect(ravenMark(mood), mood).toBe(RAVEN_MOODS[mood]);
    }
  });

  it("keeps every mood on the idle mark's grid", () => {
    const width = artWidth(RAVEN_MARK);
    for (const mood of Object.keys(RAVEN_MOODS) as RavenMood[]) {
      const rows = RAVEN_MOODS[mood];
      expect(rows, mood).toHaveLength(RAVEN_MARK.length);
      expect(artWidth(rows), mood).toBe(width);
      for (const [index, row] of rows.entries()) {
        expect(row, `${mood} row ${index}`).toMatch(PRINTABLE_ASCII);
        expect(row.length, `${mood} row ${index}`).toBe(RAVEN_MARK[index]!.length);
      }
    }
  });

  it("changes only the beak cell, so switching mood never reflows a row", () => {
    const idle = RAVEN_MOODS.idle;
    const changedCells = (mood: RavenMood): string[] => {
      const cells: string[] = [];
      for (const [rowIndex, row] of RAVEN_MOODS[mood].entries()) {
        for (const [columnIndex, glyph] of [...row].entries()) {
          if (glyph !== idle[rowIndex]![columnIndex]) {
            cells.push(`${rowIndex}:${columnIndex}=${glyph}`);
          }
        }
      }
      return cells;
    };
    expect(changedCells("idle")).toEqual([]);
    expect(changedCells("thinking")).toEqual(["1:4=O"]);
    expect(changedCells("sleeping")).toEqual(["1:4=-"]);
  });
});

describe("brand art helpers", () => {
  it("measures the widest row of an art block", () => {
    expect(artWidth([])).toBe(0);
    expect(artWidth(["", "  "])).toBe(2);
    expect(artWidth(["a", "bbbbb", "ccc"])).toBe(5);
    expect(artWidth(RAVEN_MARK)).toBe(Math.max(...RAVEN_MARK.map((row) => row.length)));
  });

  it("ships ASCII-only flag art", () => {
    for (const row of [...RAVEN_MARK, ...TWO_RAVENS]) {
      expect(row).toMatch(PRINTABLE_ASCII);
    }
    expect(TWO_RAVENS).toHaveLength(RAVEN_MARK.length);
  });
});
