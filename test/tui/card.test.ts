import React from "react";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Text } from "ink";
import { render } from "./inkRender";
import { CARD_CHROME, Card, cardChrome, type CardTone } from "../../src/tui/Card";
import { LogsCard } from "../../src/tui/Dashboard";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** The visible rows of the last frame, trailing blanks dropped. */
function visibleLines(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function renderNode(node: React.ReactElement, columns = 40, rows = 24): string {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const instance = render(node, { stdout, patchConsole: false });
  instance.unmount();
  return output;
}

describe("the one chrome-cost table (REQ-70)", () => {
  it("declares the exact cost of every tone", () => {
    expect(CARD_CHROME.primary).toEqual({
      tone: "primary",
      borderStyle: "round",
      borderRows: 2,
      titleRows: 1,
      rows: 3,
      columns: 4,
    });
    expect(CARD_CHROME.secondary).toEqual({
      tone: "secondary",
      borderStyle: "single",
      borderRows: 2,
      titleRows: 1,
      rows: 3,
      columns: 4,
    });
    expect(CARD_CHROME.tertiary).toEqual({
      tone: "tertiary",
      borderStyle: undefined,
      borderRows: 0,
      titleRows: 1,
      rows: 1,
      columns: 2,
    });
  });

  it("resolves every tone through cardChrome()", () => {
    for (const tone of Object.keys(CARD_CHROME) as CardTone[]) {
      expect(cardChrome(tone)).toBe(CARD_CHROME[tone]);
    }
  });

  it("draws the border style each tone declares", () => {
    const primary = renderNode(
      React.createElement(
        Card,
        { tone: "primary", title: "Primary", height: 6, width: 20 },
        React.createElement(Text, null, "body"),
      ),
    );
    expect(primary).toContain("╭");
    expect(primary).toContain("╰");

    const secondary = renderNode(
      React.createElement(
        Card,
        { tone: "secondary", title: "Secondary", height: 6, width: 20 },
        React.createElement(Text, null, "body"),
      ),
    );
    expect(secondary).toContain("┌");
    expect(secondary).toContain("└");

    const tertiary = renderNode(
      React.createElement(Card, { tone: "tertiary", title: "SYSTEM LOGS" }, React.createElement(Text, null, "entry")),
    );
    expect(tertiary).toContain("SYSTEM LOGS");
    expect(tertiary).toContain("entry");
    // No box at all: not one border glyph from either boxed tone.
    expect(tertiary).not.toMatch(/[╭╮╰╯┌┐└┘─│├┤┬┴┼]/);
  });

  it("spends exactly the rows the caller paid for", () => {
    const output = renderNode(
      React.createElement(
        Card,
        { tone: "primary", title: "Conversation", height: 8, width: 30 },
        React.createElement(Text, null, "first body row"),
      ),
    );
    expect(visibleLines(output)).toHaveLength(8);
  });

  it("keeps LogsCard tertiary: title + one row per entry, never a box", () => {
    const output = renderNode(
      React.createElement(LogsCard, {
        logs: [
          { level: "info", message: "first", timestamp: "10:00:00" },
          { level: "warn", message: "second", timestamp: "10:00:01" },
        ],
      }),
    );
    const lines = visibleLines(output);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("SYSTEM LOGS");
    expect(lines[1]).toContain("│ ");
    expect(lines[2]).toContain("│ ");
    // The `│ ` rule is the only box-drawing glyph the tertiary card owns.
    expect(lines.join("\n")).not.toMatch(/[╭╮╰╯┌┐└┘─├┤┬┴┼]/);
  });

  it("keeps both dashboards on the table instead of a duplicated literal", () => {
    const read = (file: string): string =>
      readFileSync(new URL(`../../src/tui/${file}`, import.meta.url), "utf8");

    for (const file of ["Dashboard.tsx", "LiveDashboard.tsx"]) {
      const source = read(file);
      // The old per-dashboard constants are gone: their costs live in Card.tsx.
      expect(source, file).not.toMatch(/CARD_(BORDER|PADDING|HORIZONTAL|TITLE)_/);
      expect(source, file).toContain('cardChrome("tertiary").rows');
      expect(source, file).not.toMatch(/visibleLogs\.length\s*\+\s*3/);
    }
  });
});
