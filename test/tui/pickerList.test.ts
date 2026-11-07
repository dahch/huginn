import React from "react";
import { PassThrough } from "node:stream";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import { render } from "./inkRender";
import { PickerList, type PickerListProps } from "../../src/tui/PickerList";
import {
  clampIndex,
  filterByQuery,
  hiddenAbove,
  hiddenBelow,
  normalizeLimit,
  visibleWindow,
} from "../../src/tui/pickerWindow";

/**
 * The windowed list is the one piece of scrolling math four modals share, and
 * the off-by-one at the end of a list is invisible until a terminal is short.
 * These are the pure bounds, not a rendered snapshot.
 */
describe("visibleWindow", () => {
  it("rides the bottom edge with 'end' alignment (agent/profile pickers)", () => {
    expect(visibleWindow(10, 0, 6, "end")).toMatchObject({ offset: 0, length: 6, end: 6 });
    expect(visibleWindow(10, 5, 6, "end")).toMatchObject({ offset: 0, length: 6, end: 6 });
    // The highlight leaves the window, so it scrolls one row at a time.
    expect(visibleWindow(10, 6, 6, "end")).toMatchObject({ offset: 1, length: 6, end: 7 });
    // ...and never past the last row.
    expect(visibleWindow(10, 9, 6, "end")).toMatchObject({ offset: 4, length: 6, end: 10 });
  });

  it("keeps the selection centred with 'center' alignment (catalogs)", () => {
    expect(visibleWindow(10, 0, 6, "center")).toMatchObject({ offset: 0, length: 6 });
    expect(visibleWindow(10, 5, 6, "center")).toMatchObject({ offset: 2, length: 6 });
    expect(visibleWindow(10, 9, 6, "center")).toMatchObject({ offset: 4, length: 6, end: 10 });
  });

  it("shrinks the window instead of claiming rows that do not exist", () => {
    expect(visibleWindow(3, 2, 6, "end")).toMatchObject({ offset: 0, length: 3, end: 3 });
    expect(visibleWindow(0, 0, 6, "end")).toMatchObject({ offset: 0, length: 0, end: 0 });
    // A selected index outside the list cannot scroll it.
    expect(visibleWindow(5, 99, 2, "center")).toMatchObject({ offset: 3, length: 2 });
  });

  it("normalizes hostile limits and indices instead of producing a negative slice", () => {
    expect(normalizeLimit(0)).toBe(1);
    expect(normalizeLimit(Number.NaN)).toBe(1);
    expect(normalizeLimit(-4)).toBe(1);
    expect(normalizeLimit(2.9)).toBe(2);
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2, 0)).toBe(0);
    expect(visibleWindow(5, -1, 2, "end").offset).toBe(0);
  });

  it("reports the rows hidden on each side, never a negative count", () => {
    const window = visibleWindow(10, 9, 6, "end");
    expect(hiddenAbove(window)).toBe(4);
    expect(hiddenBelow(window)).toBe(0);
    expect(hiddenBelow(visibleWindow(10, 0, 6, "end"))).toBe(4);
  });
});

describe("filterByQuery", () => {
  const items = [
    { id: "anthropic/claude-3", name: "Claude", provider: "Anthropic" },
    { id: "openai/gpt-5", name: "GPT-5", provider: "OpenAI" },
  ];
  const fields = (item: (typeof items)[number]) => [item.id, item.name, item.provider];

  it("matches case-insensitively across every field", () => {
    expect(filterByQuery(items, "CLAUDE", fields)).toEqual([items[0]]);
    expect(filterByQuery(items, " openai ", fields)).toEqual([items[1]]);
    expect(filterByQuery(items, "gpt-5", fields)).toEqual([items[1]]);
  });

  it("returns the same array for a blank query, so a memo does not reallocate", () => {
    expect(filterByQuery(items, "", fields)).toBe(items);
    expect(filterByQuery(items, "   ", fields)).toBe(items);
  });

  it("treats a missing field as empty instead of throwing", () => {
    expect(filterByQuery(items, "claude", () => [undefined])).toEqual([]);
  });
});

describe("PickerList", () => {
  function renderList(selectedIndex: number): string {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const items = Array.from({ length: 10 }, (_, index) => `row ${index}`);
    const instance = render(
      React.createElement(PickerList as React.FC<PickerListProps<string>>, {
        items,
        selectedIndex,
        maxRows: 3,
        renderItem: (item: string, selected: boolean) =>
          React.createElement(Text, { key: item }, `${selected ? "> " : "  "}${item}`),
      }),
      { stdout, stdin: new PassThrough(), patchConsole: false },
    );
    instance.unmount();
    return output;
  }

  it("draws only the window, plus how much is hidden on each side", () => {
    const output = renderList(5);
    expect(output).toContain("▲ 3 more above");
    expect(output).toContain("row 5");
    expect(output).not.toContain("row 0");
    expect(output).toContain("▼ 4 more below");
  });

  it("draws no indicator when the whole list fits", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const instance = render(
      React.createElement(PickerList as React.FC<PickerListProps<string>>, {
        items: ["a", "b"],
        selectedIndex: 0,
        maxRows: 6,
        renderItem: (item: string) => React.createElement(Text, { key: item }, item),
      }),
      { stdout, stdin: new PassThrough(), patchConsole: false },
    );
    instance.unmount();
    expect(output).not.toContain("more above");
    expect(output).not.toContain("more below");
  });
});
