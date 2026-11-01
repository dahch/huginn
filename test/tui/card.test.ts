import React from "react";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Text } from "ink";
import { render } from "./inkRender";
import { CARD_CHROME, Card, cardChrome, type CardTone } from "../../src/tui/Card";
import { LogsCard, StreamCard } from "../../src/tui/Dashboard";
import { InfoPanel, sidePanelPlan, type PanelData } from "../../src/tui/InfoPanel";

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

/** The source of one named function/method, up to the next top-level one. */
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} is declared`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export )?function /);
  return source.slice(start, next === -1 ? undefined : start + 1 + next);
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
    for (const tone of ["primary", "secondary"] as const) {
      const output = renderNode(
        React.createElement(
          Card,
          { tone, title: "Conversation", height: 8, width: 30 },
          React.createElement(Text, null, "first body row"),
        ),
      );
      const lines = visibleLines(output);
      expect(lines, tone).toHaveLength(8);
      // The border is the first and last row; the title is exactly one row in.
      expect(lines[0], tone).toMatch(tone === "primary" ? /^╭─+╮$/ : /^┌─+┐$/);
      expect(lines[1], tone).toContain("Conversation");
      expect(lines[7], tone).toMatch(tone === "primary" ? /^╰─+╯$/ : /^└─+┘$/);
    }
  });

  it("spends one title row and no border on the tertiary card", () => {
    const output = renderNode(
      React.createElement(
        Card,
        { tone: "tertiary", title: "SYSTEM LOGS" },
        React.createElement(Text, null, "first"),
        React.createElement(Text, null, "second"),
      ),
    );
    const lines = visibleLines(output);
    expect(lines).toHaveLength(cardChrome("tertiary").titleRows + 2);
    expect(lines[0]).toContain("SYSTEM LOGS");
    expect(lines[1]).toContain("first");
    expect(lines[2]).toContain("second");
  });

  it("never lets a long title or titleRight wrap into a row it did not reserve", () => {
    const output = renderNode(
      React.createElement(
        Card,
        {
          tone: "primary",
          title: "T".repeat(80),
          titleRight: React.createElement(Text, null, "R".repeat(80)),
          height: 6,
          width: 24,
        },
        React.createElement(Text, null, "body"),
      ),
    );
    const lines = visibleLines(output);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(24);
    }
    // The title row is clipped, never wrapped onto a second row.
    expect(lines[1]).toContain("…");
    expect(lines[2]).not.toContain("T");
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

  it("renders no LogsCard at all when there is nothing to log", () => {
    const output = renderNode(React.createElement(LogsCard, { logs: [] }));
    expect(visibleLines(output)).toHaveLength(0);
  });

  it("costs one row per extra log entry, not one per entry plus chrome", () => {
    const logs = Array.from({ length: 5 }, (_, index) => ({
      level: "info" as const,
      message: `entry ${index}`,
      timestamp: `10:00:0${index}`,
    }));
    const output = renderNode(React.createElement(LogsCard, { logs }));
    const lines = visibleLines(output);
    expect(lines).toHaveLength(logs.length + cardChrome("tertiary").rows);
    expect(lines[0]).toContain("SYSTEM LOGS");
    expect(lines[5]).toContain("entry 4");
  });

  it("draws StreamCard as a secondary single box", () => {
    const output = renderNode(
      React.createElement(StreamCard, {
        lines: ["line one"],
        chars: 8,
        spinner: "⠋",
        verbose: false,
        height: 8,
      }),
    );
    const lines = visibleLines(output);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[7]).toMatch(/^└─+┘$/);
    expect(output).not.toContain("╭");
  });

  it("draws InfoPanel as a secondary single box of exactly its planned height", () => {
    const plan = sidePanelPlan({ columns: 120, availableHeight: 20, inset: 2 });
    const data: PanelData = {
      stageLabel: "REFINE",
      stageToken: "accent",
      busy: false,
      spinner: "⠋",
      agentName: "opencode",
      mcpText: "MCP: 2 connected · opencode",
      mcpToken: "ok",
      git: { branch: "feature/card", clean: true, sandbox: false },
      memory: { entitiesCount: 1, observationsCount: 2 },
      context: { turns: 1, chars: 10 },
      tip: "type / for commands",
    };
    const output = renderNode(React.createElement(InfoPanel, { plan, data }));
    const lines = visibleLines(output);
    expect(lines).toHaveLength(plan.height);
    expect(lines[0]!.trimStart()).toMatch(/^┌─+┐$/);
    expect(lines[plan.height - 1]!.trimStart()).toMatch(/^└─+┘$/);
    expect(output).not.toContain("╭");
  });

  it("anchors the panel's tip to the bottom of the box", () => {
    const plan = sidePanelPlan({ columns: 120, availableHeight: 20, inset: 2 });
    const data: PanelData = {
      stageLabel: "REFINE",
      stageToken: "accent",
      busy: false,
      spinner: "⠋",
      agentName: "opencode",
      mcpText: "MCP: 2 connected · opencode",
      mcpToken: "ok",
      git: { branch: "feature/card", clean: true, sandbox: false },
      memory: { entitiesCount: 1, observationsCount: 2 },
      context: { turns: 1, chars: 10 },
      tip: "type / for commands",
    };
    const lines = visibleLines(renderNode(React.createElement(InfoPanel, { plan, data })));
    // The bottom border is last; the anchored tip is the body row just above it.
    expect(lines[plan.height - 2]).toContain("TIP");
  });

  it("maps every promised surface to its tone", () => {
    const read = (file: string): string =>
      readFileSync(new URL(`../../src/tui/${file}`, import.meta.url), "utf8");
    const surfaces: Array<[string, string, CardTone]> = [
      ["LiveDashboard.tsx", "ScrollableChatCard", "primary"],
      ["LiveDashboard.tsx", "ScrollableStreamCard", "secondary"],
      ["Dashboard.tsx", "PipelineCard", "secondary"],
      ["Dashboard.tsx", "StreamCard", "secondary"],
      ["Dashboard.tsx", "LogsCard", "tertiary"],
      ["InfoPanel.tsx", "InfoPanel", "secondary"],
    ];
    for (const [file, name, tone] of surfaces) {
      const body = functionSource(read(file), name);
      const tones = [...body.matchAll(/tone="(primary|secondary|tertiary)"/g)].map((hit) => hit[1]);
      expect(tones, `${file}:${name}`).toEqual([tone]);
    }
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
      // The log tail's budget is entries + the table's tertiary cost, never a literal.
      expect(source, file).toMatch(/visibleLogs\.length\s*\+\s*cardChrome\("tertiary"\)\.rows/);
    }
  });
});
