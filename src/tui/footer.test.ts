import { describe, expect, it } from "bun:test";
import { PALETTE_FOOTER_HINT, footerHints } from "./footer.js";

const base = {
  focus: "composer" as const,
  paletteOpen: false,
  busy: false,
  maximized: null,
  usage: undefined,
  stage: undefined,
};

describe("footerHints — the footer speaks for the focused surface (H-13)", () => {
  it("gives the composer its history and submission keys", () => {
    const hints = footerHints({ ...base, focus: "composer" });
    expect(hints.left).toContain("[Tab] Focus: input");
    expect(hints.left).toContain("History");
    expect(hints.left).toContain("[Enter] Send");
    expect(hints.left).not.toContain("[y] Copy");
  });

  it("gives the conversation its scroll, search and copy keys", () => {
    const hints = footerHints({ ...base, focus: "chat" });
    expect(hints.left).toContain("[Tab] Focus: chat");
    expect(hints.left).toContain("Scroll");
    expect(hints.left).toContain("[Ctrl+F] Search");
    expect(hints.left).toContain("[y] Copy");
    expect(hints.left).not.toContain("History");
  });

  it("never advertises copy on the agent stream, which has no message to copy", () => {
    const hints = footerHints({ ...base, focus: "stream" });
    expect(hints.left).toContain("[Ctrl+F] Search");
    expect(hints.left).not.toContain("[y] Copy");
  });

  it("hands the keys to the palette while it is open", () => {
    expect(footerHints({ ...base, paletteOpen: true }).left).toBe(PALETTE_FOOTER_HINT);
  });

  it("announces restore instead of maximize for the maximized card", () => {
    const hints = footerHints({ ...base, focus: "chat", maximized: "chat" });
    expect(hints.left).toContain("[z] Restore");
    expect(footerHints({ ...base, focus: "chat", maximized: "stream" }).left).toContain(
      "[z] Maximize",
    );
  });

  it("advertises the hidden log count and the abort key while busy", () => {
    const hints = footerHints({ ...base, focus: "chat", hiddenLogs: 4, busy: true });
    expect(hints.left).toContain("[L] logs · 4");
    expect(hints.left).toContain("[Esc] Abort");
  });

  it("keeps usage and the stage badge on the right, as before", () => {
    expect(footerHints({ ...base, usage: "1.2k/8k", stage: "REFINE" }).right).toBe(
      "1.2k/8k · stage: REFINE",
    );
    expect(footerHints({ ...base, stage: "EXECUTE" }).right).toBe("stage: EXECUTE");
  });

  it("uses the run keys and names a decision that owns the keyboard", () => {
    const running = footerHints({ focus: "run", paused: false, verbose: true });
    expect(running.left).toContain("[Space] Pause");
    expect(running.left).toContain("[q/Esc] Abort");
    expect(running.left).toContain("(ON)");
    expect(footerHints({ focus: "run", paused: true }).left).toContain("[Space] Resume");
    expect(footerHints({ focus: "run", hasDecision: true }).right).toContain(
      "Interactive decision input active",
    );
  });

  it("never exceeds the terminal width at 100 columns", () => {
    const hints = footerHints({
      ...base,
      focus: "chat",
      usage: "123k/200k tokens",
      stage: "EXECUTE",
      hiddenLogs: 3,
      busy: true,
      columns: 100,
    });
    expect(hints.right).toBe("123k/200k tokens · stage: EXECUTE");
    expect(hints.left.length + hints.right.length).toBeLessThanOrEqual(100);
    // The card's keys are clamped, not silently dropped in favour of the badge.
    expect(hints.left.startsWith("[L] logs · 3")).toBe(true);
  });
});

describe("footerHints — search owns the footer while it is open", () => {
  it("names the find prompt, the match count and the cancel key", () => {
    const hints = footerHints({ ...base, focus: "chat", search: true, searchMatches: 3 });
    expect(hints.left).toContain("find ❯ ");
    expect(hints.left).toContain("[↑/↓] 3 matches");
    expect(hints.left).toContain("[Enter] Jump");
    expect(hints.left).toContain("[Esc] Cancel");
  });

  it("numbers a single hit singularly, so `1 matches` never reaches the screen", () => {
    expect(footerHints({ ...base, search: true, searchMatches: 1 }).left).toContain("1 match ·");
    expect(footerHints({ ...base, search: true, searchMatches: 1 }).left).not.toContain(
      "1 matches",
    );
    expect(footerHints({ ...base, search: true, searchMatches: 0 }).left).toContain("0 matches");
  });

  it("appends the `3/12` label only when there is a hit to number", () => {
    const labelled = footerHints({
      ...base,
      search: true,
      searchMatches: 4,
      searchMatchText: "2/4",
    });
    expect(labelled.left).toContain("[Enter] Jump 2/4");
    expect(footerHints({ ...base, search: true, searchMatches: 4 }).left).not.toContain(
      "Jump  ",
    );
  });

  it("replaces the focus keys, so `[y] Copy` is not advertised mid-search", () => {
    const hints = footerHints({ ...base, focus: "chat", search: true, searchMatches: 2 });
    expect(hints.left).not.toContain("[y] Copy");
    expect(hints.left).not.toContain("History");
  });

  it("never floors a negative or fractional hit count below zero", () => {
    expect(footerHints({ ...base, search: true, searchMatches: -5 }).left).toContain(
      "[↑/↓] 0 matches",
    );
    expect(footerHints({ ...base, search: true, searchMatches: 2.7 }).left).toContain(
      "[↑/↓] 2 matches",
    );
  });

  it("still yields to the palette, which is a modal overlay over the search", () => {
    const hints = footerHints({ ...base, paletteOpen: true, search: true, searchMatches: 1 });
    expect(hints.left).toBe(PALETTE_FOOTER_HINT);
  });
});

describe("footerHints — the log tail prefix", () => {
  it("advertises nothing when no entry is hidden", () => {
    for (const hiddenLogs of [0, -3, undefined]) {
      expect(footerHints({ ...base, focus: "chat", hiddenLogs }).left).not.toContain("[L] logs");
    }
  });

  it("counts exactly the entries the collapsed tail would restore", () => {
    expect(footerHints({ ...base, focus: "stream", hiddenLogs: 1 }).left).toContain(
      "[L] logs · 1 (card focus)",
    );
  });
});

describe("footerHints — clamping is hired only when a width is known", () => {
  const wide = {
    ...base,
    focus: "chat" as const,
    usage: "1.2k/8k tokens",
    stage: "EXECUTE",
    busy: true,
  };

  it("returns the full strings when no usable width is given", () => {
    const unclamped = footerHints(wide);
    for (const columns of [undefined, Number.NaN, 0, -10, Number.POSITIVE_INFINITY]) {
      expect(footerHints({ ...wide, columns })).toEqual(unclamped);
    }
  });

  it("clamps the right cell first, because the stage badge must survive", () => {
    const hints = footerHints({ ...wide, columns: 40 });
    const full = footerHints(wide);
    expect(hints.right).toBe("1.2k/8k tokens · stage: EXECUTE");
    // The badge is intact and the left cell is the head of its own hint, not a
    // string cut in favour of History/Send — with the `…` that says it was cut.
    expect(hints.left.endsWith("…")).toBe(true);
    expect(full.left.startsWith(hints.left.slice(0, -1))).toBe(true);
    expect(hints.left.length).toBe(40 - hints.right.length - 1);
  });

  it("gives the left cell the whole width when the right cell is empty", () => {
    const hints = footerHints({
      ...base,
      focus: "composer",
      usage: undefined,
      stage: undefined,
      columns: 20,
    });
    expect(hints.right).toBe("");
    expect(hints.left.length).toBeLessThanOrEqual(20);
    expect(hints.left.length).toBeGreaterThan(0);
  });

  it("spends no separator column it does not draw", () => {
    // 27 right columns exactly: the left cell inherits `columns - right` only.
    const hints = footerHints({ focus: "chat", usage: "u", columns: 30 });
    expect(hints.right).toBe("u");
    expect(hints.left.length).toBeLessThanOrEqual(30 - 1 - 1);
  });

  it("never returns a negative budget when the right cell fills the terminal", () => {
    const hints = footerHints({ focus: "chat", usage: "x".repeat(80), columns: 12 });
    // The right cell keeps every column it was given, and its cut is announced.
    expect(hints.right).toBe(`${"x".repeat(11)}…`);
    expect(hints.right.length).toBe(12);
    expect(hints.left).toBe("");
  });

  it("floors a fractional width instead of slicing at a fraction", () => {
    const hints = footerHints({ focus: "chat", columns: 40.9 });
    expect(hints.left.length).toBeLessThanOrEqual(40);
  });

  it("never exceeds the width for any focus at the narrowest frames", () => {
    const focuses = ["composer", "chat", "stream", "run"] as const;
    for (const columns of [20, 40, 60, 80, 100, 120]) {
      for (const focus of focuses) {
        const hints = footerHints({
          ...wide,
          focus,
          hiddenLogs: 12,
          maximized: "chat",
          search: false,
          columns,
        });
        expect(
          hints.left.length + hints.right.length,
          `${focus} at ${columns} columns`,
        ).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe("footerHints — purity", () => {
  it("is deterministic and never mutates its input", () => {
    const input = {
      ...base,
      focus: "chat" as const,
      hiddenLogs: 2,
      usage: "1k/2k",
      stage: "REVIEW",
      columns: 90,
    };
    const snapshot = { ...input };
    expect(footerHints(input)).toEqual(footerHints(input));
    expect(input).toEqual(snapshot);
  });

  it("always answers with both cells, so a caller never has to guard a field", () => {
    const hints = footerHints({ focus: "run" });
    expect(Object.keys(hints).sort()).toEqual(["left", "right"]);
    expect(typeof hints.left).toBe("string");
    expect(typeof hints.right).toBe("string");
  });

  it("names every palette key in the shared constant", () => {
    for (const key of ["[↑/↓] Select", "[Tab] Accept", "[Enter] Run", "[Esc] Dismiss"]) {
      expect(PALETTE_FOOTER_HINT).toContain(key);
    }
  });

  it("is the same implementation behind both import paths", async () => {
    const alias = await import("./footerHints.js");
    expect(alias.footerHints).toBe(footerHints);
    expect(alias.PALETTE_FOOTER_HINT).toBe(PALETTE_FOOTER_HINT);
  });
});
