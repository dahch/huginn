import { describe, it, expect } from "bun:test";
import {
  RAVEN_MARK,
  RAVEN_MOODS,
  TWO_RAVENS,
  RAVEN_BLINK_TICKS,
  artWidth,
  ravenBlink,
  ravenMark,
  ravenMood,
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

  it("blinks only while thinking, on the idle mark's exact grid", () => {
    for (const mood of Object.keys(RAVEN_MOODS) as RavenMood[]) {
      const open = ravenMark(mood);
      const blinked = ravenMark(mood, { blink: true });
      expect(blinked, mood).toHaveLength(open.length);
      expect(artWidth(blinked), mood).toBe(artWidth(open));
      for (const [index, row] of blinked.entries()) {
        expect(row.length, `${mood} blink row ${index}`).toBe(open[index]!.length);
        expect(row, `${mood} blink row ${index}`).toMatch(PRINTABLE_ASCII);
      }
    }
    // Blink is the thinking cycle's closed-eye frame: the idle open-eye mark.
    expect(ravenMark("thinking", { blink: true })).toBe(ravenMark("idle"));
    expect(ravenMark("idle", { blink: true })).toBe(ravenMark("idle"));
    expect(ravenMark("sleeping", { blink: true })).toBe(ravenMark("sleeping"));
    // The beak still alternates the two documented glyphs, no new ones.
    expect(ravenMark("thinking")[1]).toContain("O");
    expect(ravenMark("thinking", { blink: true })[1]).toContain("o");
  });

  it("resolves the mood with busy > degraded > idle precedence", () => {
    expect(ravenMood({ busy: true, degraded: true })).toBe("thinking");
    expect(ravenMood({ busy: true, degraded: false })).toBe("thinking");
    expect(ravenMood({ busy: false, degraded: true })).toBe("sleeping");
    expect(ravenMood({ busy: false, degraded: false })).toBe("idle");
    expect(ravenMood({})).toBe("idle");
  });

  it("derives the blink phase from the existing 80 ms spinner tick", () => {
    expect(RAVEN_BLINK_TICKS).toBe(6);
    for (const tick of [0, 1, 5, 6, 11, 12, 18, 24]) {
      expect(ravenBlink(tick), String(tick)).toBe(Math.floor(tick / 6) % 2 === 1);
    }
    // Nonsense frames cannot throw or flip the phase unpredictably.
    expect(ravenBlink(-1)).toBe(false);
    expect(ravenBlink(Number.NaN)).toBe(false);
    // Non-finite values collapse to frame 0 instead of producing `NaN`.
    expect(ravenBlink(Number.POSITIVE_INFINITY)).toBe(false);
    expect(ravenBlink(Number.NEGATIVE_INFINITY)).toBe(false);
    // Fractional ticks floor to their frame, and a negative fraction clamps to 0.
    expect(ravenBlink(5.9)).toBe(false);
    expect(ravenBlink(6.9)).toBe(true);
    expect(ravenBlink(-0.5)).toBe(false);
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
