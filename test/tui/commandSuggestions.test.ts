import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import {
  CommandSuggestions,
  MAX_SUGGESTION_ROWS,
  buildSuggestionRows,
  suggestionOverlayHeight,
} from "../../src/tui/CommandSuggestions";
import { matchCommands, type SlashCommand } from "../../src/tui/commandRegistry";

function createMockStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as unknown as PassThrough & {
    isTTY: boolean;
    setRawMode: () => PassThrough;
    ref: () => PassThrough;
    unref: () => PassThrough;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function createMockStdout(columns = 120, rows = 40): PassThrough & { columns: number; rows: number } {
  const stdout = new PassThrough() as unknown as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  return stdout;
}

async function renderSuggestions(
  matches: SlashCommand[],
  selectedIndex: number,
): Promise<string> {
  const stdout = createMockStdout();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(
    React.createElement(CommandSuggestions, { matches, selectedIndex }),
    { stdout, stdin: createMockStdin(), patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 50));
  instance.unmount();
  return output;
}

describe("CommandSuggestions (AC-28.2, AC-28.4)", () => {
  it("renders every match, highlighting the selection, when they fit", async () => {
    const matches = matchCommands("/mo");
    const output = await renderSuggestions(matches, 0);

    expect(output).toContain("▸ /model <thinker> [executor]");
    expect(output).toContain("Open the model picker");
    expect(output).not.toContain("more below");
    expect(output).not.toContain("more above");
  });

  it("renders nothing when no command matches", async () => {
    const output = await renderSuggestions(matchCommands("/nope"), 0);
    expect(output).not.toContain("/model");
    expect(output.trim()).toBe("");
  });

  it("highlights the row at selectedIndex", async () => {
    const matches = matchCommands("/");
    const output = await renderSuggestions(matches, 1);
    expect(output).toContain("▸ /agent [id]");
    expect(output).toContain("  /help");
  });

  it("bounds the list to MAX_SUGGESTION_ROWS content rows and marks the overflow", async () => {
    const matches = matchCommands("/");
    expect(matches.length).toBeGreaterThan(MAX_SUGGESTION_ROWS);

    const output = await renderSuggestions(matches, 0);
    expect(output).toContain(`▼ ${matches.length - MAX_SUGGESTION_ROWS + 1} more below`);
    expect(output).not.toContain("/status");
    expect(suggestionOverlayHeight(buildSuggestionRows(matches, 0))).toBe(MAX_SUGGESTION_ROWS + 2);
  });
});

describe("buildSuggestionRows windowing", () => {
  it("returns no rows for no matches", () => {
    expect(buildSuggestionRows([], 0)).toEqual([]);
    expect(suggestionOverlayHeight([])).toBe(0);
  });

  it("shows every match when the list fits", () => {
    const matches = matchCommands("/mo");
    const rows = buildSuggestionRows(matches, 0);
    expect(rows.map((row) => row.kind)).toEqual(["command"]);
    expect(rows.every((row) => row.kind === "command" && row.selected)).toBe(true);
  });

  it("adds ▲/▼ scroll markers that count against the row budget", () => {
    const matches = matchCommands("/");
    const middle = buildSuggestionRows(matches, 4);
    expect(middle.length).toBe(MAX_SUGGESTION_ROWS);
    expect(middle[0]).toEqual({ kind: "up", hidden: 3 });
    // The window shows commands 3–6 (up marker + 4 rows + ▼ marker), so the rows
    // below it are everything after index 6, minus the ▼ marker's own row.
    expect(middle[middle.length - 1]).toEqual({
      kind: "down",
      hidden: matches.length - 7,
    });
    expect(middle.filter((row) => row.kind === "command").length).toBe(4);
  });

  it("never exceeds the row budget and always keeps the selection visible", () => {
    const matches = matchCommands("/");
    for (const selected of [0, 1, 4, matches.length - 1]) {
      const rows = buildSuggestionRows(matches, selected, MAX_SUGGESTION_ROWS);
      expect(rows.length).toBeLessThanOrEqual(MAX_SUGGESTION_ROWS);
      const highlighted = rows.filter((row) => row.kind === "command" && row.selected);
      expect(highlighted.length).toBe(1);
      expect(highlighted[0]?.kind === "command" && highlighted[0].index).toBe(selected);
    }
  });

  it("honours a smaller row cap on short terminals", () => {
    const matches = matchCommands("/");
    const rows = buildSuggestionRows(matches, 0, 3);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows[rows.length - 1]?.kind).toBe("down");
    expect(suggestionOverlayHeight(rows)).toBeLessThanOrEqual(5);
  });

  it("clamps an out-of-range selection", () => {
    const matches = matchCommands("/");
    const rows = buildSuggestionRows(matches, 99);
    const highlighted = rows.filter((row) => row.kind === "command" && row.selected);
    expect(highlighted.length).toBe(1);
    expect(rows.some((row) => row.kind === "up")).toBe(true);
  });
});
