import { describe, expect, it } from "bun:test";
import { findMatches, matchLabel } from "./search";

const messages = [
  { role: "system", text: "Search ready" },
  { role: "user", text: "Where is the parser?" },
  { role: "assistant", text: "The PARSER lives in src/plan." },
  { role: "assistant", text: "No hits here." },
];

describe("findMatches", () => {
  it("returns message indexes, case-insensitively", () => {
    expect(findMatches(messages, "parser")).toEqual([1, 2]);
    expect(findMatches(messages, "PARSER")).toEqual([1, 2]);
    expect(findMatches(messages, "search")).toEqual([0]);
  });

  it("searches system messages too, in ascending message order", () => {
    expect(findMatches(messages, "e")).toEqual([0, 1, 2, 3]);
  });

  it("matches nothing for an empty or whitespace-only query", () => {
    expect(findMatches(messages, "")).toEqual([]);
    expect(findMatches(messages, "   ")).toEqual([]);
  });

  it("returns no match when the text does not contain the query", () => {
    expect(findMatches(messages, "muninn")).toEqual([]);
  });

  it("is pure: it does not mutate the messages", () => {
    const snapshot = JSON.stringify(messages);
    findMatches(messages, "parser");
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});

describe("findMatches — defensive input", () => {
  it("returns no match for a non-string query", () => {
    expect(findMatches(messages, undefined as unknown as string)).toEqual([]);
    expect(findMatches(messages, null as unknown as string)).toEqual([]);
    expect(findMatches(messages, 42 as unknown as string)).toEqual([]);
  });

  it("returns no match for an empty conversation", () => {
    expect(findMatches([], "anything")).toEqual([]);
  });

  it("skips messages whose text is missing or not a string instead of throwing", () => {
    const ragged = [
      { role: "user", text: "needle" },
      { role: "assistant" },
      null,
      { role: "assistant", text: 42 },
      { role: "assistant", text: "another needle" },
    ] as unknown as ReadonlyArray<{ role: string; text: string }>;
    expect(findMatches(ragged, "needle")).toEqual([0, 4]);
  });

  it("matches substrings literally, never as a regular expression", () => {
    expect(findMatches(messages, "ars")).toEqual([1, 2]);
    // `.` would match any character under a regex engine; here it matches nothing.
    expect(findMatches(messages, "P.RSER")).toEqual([]);
    expect(findMatches(messages, "src/plan.")).toEqual([2]);
  });

  it("is deterministic across repeated calls", () => {
    expect(findMatches(messages, "pArSeR")).toEqual(findMatches(messages, "pArSeR"));
  });

  it("returns the index of every message when the query matches all of them", () => {
    const all = [
      { role: "user", text: "aa" },
      { role: "user", text: "ab" },
    ];
    expect(findMatches(all, "a")).toEqual([0, 1]);
  });

  it("trims the query before matching, so a padded query still hits", () => {
    expect(findMatches(messages, "  parser  ")).toEqual([1, 2]);
  });
});

describe("matchLabel — defensive input", () => {
  it("returns an empty label for a non-finite or non-positive total", () => {
    expect(matchLabel(0, Number.NaN)).toBe("");
    expect(matchLabel(0, Number.POSITIVE_INFINITY)).toBe("");
    expect(matchLabel(0, -3)).toBe("");
    // A fractional total floors to zero, so there is no match to number.
    expect(matchLabel(0, 0.5)).toBe("");
  });

  it("treats a non-finite index as the first match instead of printing NaN", () => {
    expect(matchLabel(Number.NaN, 4)).toBe("1/4");
    expect(matchLabel(Number.NEGATIVE_INFINITY, 4)).toBe("1/4");
  });

  it("floors fractional values so the label never names a match that does not exist", () => {
    expect(matchLabel(2.9, 12)).toBe("3/12");
    expect(matchLabel(0.9, 12.9)).toBe("1/12");
  });

  it("numbers a single match as 1/1 whatever the stale index was", () => {
    expect(matchLabel(0, 1)).toBe("1/1");
    expect(matchLabel(7, 1)).toBe("1/1");
  });

  it("is pure: the same arguments always produce the same label", () => {
    expect(matchLabel(2, 12)).toBe(matchLabel(2, 12));
  });
});

describe("matchLabel", () => {
  it("numbers the selected match one-based", () => {
    expect(matchLabel(0, 12)).toBe("1/12");
    expect(matchLabel(2, 12)).toBe("3/12");
    expect(matchLabel(11, 12)).toBe("12/12");
  });

  it("returns an empty label when there is no query/match", () => {
    expect(matchLabel(0, 0)).toBe("");
    expect(matchLabel(3, 0)).toBe("");
  });

  it("clamps an index that a shrinking result set left behind", () => {
    expect(matchLabel(9, 3)).toBe("3/3");
    expect(matchLabel(-1, 3)).toBe("1/3");
  });
});
