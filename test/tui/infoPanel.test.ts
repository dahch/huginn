/**
 * `InfoPanel` — the live console's side panel (REQ-12).
 *
 * These are the panel's own tests: the geometry it promises (`sidePanelPlan`),
 * the lines it derives (`panelLines`), the slice that never leaves a dangling
 * divider or a headerless section, and the frame it actually paints — sections,
 * the bottom-anchored tip, and the rows it must *not* invent (NFR-10). The
 * layout numbers shared with the dashboards are asserted here against the
 * `cardChrome` table rather than against literals.
 */

import React from "react";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "./inkRender";
import { cardChrome } from "../../src/tui/Card.js";
import {
  PANEL_LABEL_COLUMNS,
  PANEL_TIP_PREFIX,
  PANEL_TITLE,
  SIDE_PANEL_BORDER_COLUMNS,
  SIDE_PANEL_BORDER_ROWS,
  SIDE_PANEL_GAP_COLUMNS,
  SIDE_PANEL_MIN_CARD_COLUMNS,
  SIDE_PANEL_MIN_COLUMNS,
  SIDE_PANEL_MIN_ROWS,
  SIDE_PANEL_WIDTH,
  InfoPanel,
  panelLines,
  sidePanelPlan,
  slicePanelLines,
  type PanelData,
  type PanelLine,
  type SidePanelPlan,
} from "../../src/tui/InfoPanel.js";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
const CONTENT_WIDTH = SIDE_PANEL_WIDTH - SIDE_PANEL_BORDER_COLUMNS;

/** Every section of the panel filled: the "everything reported" case. */
const fullData: PanelData = {
  stageLabel: "REFINE",
  stageToken: "accent",
  busy: false,
  spinner: "⠋",
  agentName: "opencode",
  mcpText: "MCP: 2 connected · opencode",
  mcpToken: "ok",
  git: { branch: "feature/panel", clean: false, sandbox: true },
  memory: { entitiesCount: 42, observationsCount: 137 },
  context: { turns: 3, chars: 1_450 },
  tip: "type / for commands",
};

/** The text of one panel line, as the row paints it. */
function lineText(line: PanelLine): string {
  if (line.kind === "row") return `${line.label.padEnd(PANEL_LABEL_COLUMNS)}${line.value}`;
  if (line.kind === "section") return line.label;
  if (line.kind === "note") return `${PANEL_TIP_PREFIX}${line.text}`;
  if (line.kind === "badge" || line.kind === "title") return line.text;
  return "─".repeat(CONTENT_WIDTH);
}

/** The final frame, ANSI-stripped, one entry per terminal row. */
function renderPanel(plan: SidePanelPlan, data: PanelData): string[] {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = plan.width + SIDE_PANEL_GAP_COLUMNS + 4;
  stdout.rows = plan.height + 4;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const instance = render(React.createElement(InfoPanel, { plan, data }), {
    stdout,
    patchConsole: false,
  });
  instance.unmount();
  const rows = output.replace(ANSI, "").split("\n").map((row) => row.replace(/\s+$/, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** A row with its border and padding stripped: `│ SESSION   │` → `SESSION`. */
function body(row: string): string {
  return row.replace(/[│┌┐└┘─]/g, "").trim();
}

/** `true` for a body row the panel left empty — a divider is not one. */
function blankRow(row: string): boolean {
  return row.replace(/[│\s]/g, "") === "";
}

describe("side panel geometry (REQ-12)", () => {
  const tallPlan = (columns: number, availableHeight: number, inset = 2): SidePanelPlan =>
    sidePanelPlan({ columns, availableHeight, inset });

  it("keeps its columns and rows adding up at every visible size", () => {
    for (const [columns, availableHeight] of [
      [100, 8],
      [100, 30],
      [120, 20],
      [141, 43],
    ] as const) {
      const plan = tallPlan(columns, availableHeight);
      expect(plan.visible, `${columns}x${availableHeight}`).toBe(true);
      // The panel's width, the gap and the cards' width are the whole content row.
      expect(plan.width + SIDE_PANEL_GAP_COLUMNS + plan.cardsWidth).toBe(columns - 2);
      // The content budget is the box minus its own border and padding.
      expect(plan.contentWidth).toBe(plan.width - SIDE_PANEL_BORDER_COLUMNS);
      expect(plan.contentWidth).toBe(
        SIDE_PANEL_WIDTH - cardChrome("secondary").columns,
      );
      // The panel shares the cards' row instead of claiming one of its own.
      expect(plan.height).toBe(availableHeight);
      expect(plan.columns).toBe(columns);
      expect(plan.availableHeight).toBe(availableHeight);
    }
  });

  it("keeps the conversation a usable column, never a sliver", () => {
    // The threshold is derived: one column narrower and the panel stands down.
    expect(tallPlan(SIDE_PANEL_MIN_COLUMNS, 30).visible).toBe(true);
    expect(tallPlan(SIDE_PANEL_MIN_COLUMNS - 1, 30).visible).toBe(false);
    // A wide terminal whose outer inset already ate the row leaves no 44-column
    // conversation, so the panel hides instead of starving it. One column less
    // spent keeps it: the threshold is the conversation's, not the terminal's.
    const spent = (keepForCards: number): number =>
      140 - (SIDE_PANEL_WIDTH + SIDE_PANEL_GAP_COLUMNS + keepForCards);
    const enough = tallPlan(140, 30, spent(SIDE_PANEL_MIN_CARD_COLUMNS));
    expect(enough.visible).toBe(true);
    expect(enough.cardsWidth).toBe(SIDE_PANEL_MIN_CARD_COLUMNS);
    const starved = tallPlan(140, 30, spent(SIDE_PANEL_MIN_CARD_COLUMNS - 1));
    expect(starved.visible).toBe(false);
    // Standing down hands the conversation the sliver back instead of showing
    // the panel over an unusable column.
    expect(starved.cardsWidth).toBeGreaterThan(enough.cardsWidth);
  });

  it("stands down on a short frame, exactly one row below the minimum", () => {
    expect(tallPlan(140, SIDE_PANEL_MIN_ROWS - 1).visible).toBe(false);
    expect(tallPlan(140, SIDE_PANEL_MIN_ROWS).visible).toBe(true);
  });

  it("zeroes the panel's share whenever it is hidden", () => {
    for (const [columns, availableHeight, inset] of [
      [80, 30, 2],
      [140, 4, 2],
      [140, 30, 120],
    ] as const) {
      const plan = tallPlan(columns, availableHeight, inset);
      expect(plan.visible, `${columns}x${availableHeight}/${inset}`).toBe(false);
      expect(plan.width).toBe(0);
      expect(plan.contentWidth).toBe(0);
      expect(plan.height).toBe(0);
      // The caller keeps the whole content row: exactly the pre-panel layout.
      expect(plan.cardsWidth).toBe(columns - inset);
    }
  });

  it("treats a non-finite frame as a zero-column one instead of leaking NaN", () => {
    for (const broken of [
      { columns: Number.NaN, availableHeight: 30 },
      { columns: Number.POSITIVE_INFINITY, availableHeight: 30 },
      { columns: 120, availableHeight: Number.NaN },
      { columns: 120, availableHeight: 20, inset: Number.NaN },
    ]) {
      const plan = sidePanelPlan(broken as Parameters<typeof sidePanelPlan>[0]);
      // Whatever it decides, the numbers it hands the layout are real.
      for (const value of [plan.width, plan.contentWidth, plan.cardsWidth, plan.height]) {
        expect(Number.isFinite(value), JSON.stringify(broken)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    // A NaN inset falls back to the documented default of two columns.
    expect(sidePanelPlan({ columns: 120, availableHeight: 20, inset: Number.NaN }).cardsWidth).toBe(
      120 - 2 - SIDE_PANEL_WIDTH - SIDE_PANEL_GAP_COLUMNS,
    );
  });

  it("defaults the omitted inset to the shared outer padding", () => {
    const plan = sidePanelPlan({ columns: 120, availableHeight: 20 });
    expect(plan.cardsWidth).toBe(120 - 2 - SIDE_PANEL_WIDTH - SIDE_PANEL_GAP_COLUMNS);
    expect(plan.contentWidth).toBe(CONTENT_WIDTH);
  });
});

describe("panel sections (REQ-12 / NFR-10)", () => {
  it("groups every row under SESSION, REPO and MEMORY, in that order", () => {
    const lines = panelLines(fullData, CONTENT_WIDTH);
    expect(lines.filter((line) => line.kind === "section").map((line) => line.label)).toEqual([
      "SESSION",
      "REPO",
      "MEMORY",
    ]);
    const indexOfRow = (label: string): number =>
      lines.findIndex((line) => line.kind === "row" && line.label === label);
    const indexOfSection = (label: string): number =>
      lines.findIndex((line) => line.kind === "section" && line.label === label);
    // Each group's rows sit between its own header and the next header.
    expect(indexOfSection("SESSION")).toBeLessThan(indexOfRow("stage"));
    expect(indexOfRow("ctx")).toBeLessThan(indexOfSection("REPO"));
    expect(indexOfSection("REPO")).toBeLessThan(indexOfRow("git"));
    expect(indexOfRow("sandbox")).toBeLessThan(indexOfSection("MEMORY"));
    expect(indexOfSection("MEMORY")).toBeLessThan(indexOfRow("muninn"));
  });

  it("never draws a header for a section with no data", () => {
    const lines = panelLines(
      { ...fullData, git: null, memory: null, context: { turns: 0, chars: 0 }, tip: "" },
      CONTENT_WIDTH,
    );
    expect(lines.filter((line) => line.kind === "section").map((line) => line.label)).toEqual([
      "SESSION",
    ]);
    expect(lines.some((line) => line.kind === "row" && line.label === "git")).toBe(false);
    expect(lines.some((line) => line.kind === "row" && line.label === "muninn")).toBe(false);
  });

  it("emits no row for a report the engine never made", () => {
    const labels = panelLines(fullData, CONTENT_WIDTH)
      .filter((line) => line.kind === "row")
      .map((line) => line.label);
    // The panel's whole vocabulary: nothing about iterations, progress or
    // percentages, because `DiagnosticsInfo` exposes none of it.
    expect(labels).toEqual(["stage", "agent", "ctx", "git", "sandbox", "muninn"]);
    expect(labels.some((label) => /iter|progress|percent|pct/.test(label))).toBe(false);
    for (const line of panelLines(fullData, CONTENT_WIDTH)) {
      expect(lineText(line)).not.toMatch(/%|\biteration\b/i);
    }
  });

  it("says a Muninn database is unavailable instead of showing it empty", () => {
    const lines = panelLines(
      { ...fullData, memory: { entitiesCount: 0, observationsCount: 0, error: "locked" } },
      CONTENT_WIDTH,
    );
    expect(lines.find((line) => line.kind === "row" && line.label === "muninn")).toEqual({
      kind: "row",
      label: "muninn",
      value: "unavailable — locked",
      token: "danger",
    });
    expect(JSON.stringify(lines)).not.toContain("0 entities");
  });

  it("hides the sandbox row unless the session really runs in a worktree", () => {
    const plain = panelLines(
      { ...fullData, git: { branch: "main", clean: true, sandbox: false } },
      CONTENT_WIDTH,
    );
    expect(plain.some((line) => line.kind === "row" && line.label === "sandbox")).toBe(false);
    // A clean tree is still reported, with the ok token rather than danger.
    expect(plain.find((line) => line.kind === "row" && line.label === "git")).toMatchObject({
      token: "ok",
    });
  });

  it("clips a hostile value to the columns the box really has", () => {
    const lines = panelLines(
      {
        ...fullData,
        agentName: "a".repeat(200),
        mcpText: "MCP: " + "b".repeat(200),
        git: { branch: "/".repeat(90), clean: false, sandbox: true },
        memory: { entitiesCount: 1, observationsCount: 2, error: "c".repeat(200) },
        tip: "d".repeat(200),
      },
      CONTENT_WIDTH,
    );
    for (const line of lines) {
      expect(lineText(line).length, lineText(line)).toBeLessThanOrEqual(CONTENT_WIDTH);
    }
  });

  it("survives a zero-width or non-finite box without throwing", () => {
    for (const width of [0, Number.NaN, -12]) {
      const lines = panelLines(fullData, width);
      // The labels survive (they are the identity of the row) but no value is
      // allowed to claim columns the box does not have.
      for (const line of lines) {
        if (line.kind === "row") expect(line.value).toBe("");
        if (line.kind === "note") expect(line.text).toBe("");
      }
    }
  });
});

describe("panel slicing (REQ-12)", () => {
  it("keeps a section header only while a row follows it", () => {
    const lines = panelLines(fullData, CONTENT_WIDTH);
    const memoryAt = lines.findIndex((line) => line.kind === "section" && line.label === "MEMORY");
    // Cutting right after the header drops the header with it.
    const headerOnly = slicePanelLines(lines, memoryAt + 1);
    expect(headerOnly[headerOnly.length - 1]?.kind).not.toBe("section");
    // Cutting one row later keeps the header and its row.
    const withRow = slicePanelLines(lines, memoryAt + 2);
    expect(withRow[withRow.length - 1]?.kind).toBe("row");
    expect(withRow[withRow.length - 2]?.kind).toBe("section");
  });

  it("never ends on the divider that introduces the tip", () => {
    const lines = panelLines(fullData, CONTENT_WIDTH);
    const tipAt = lines.length - 2;
    for (let budget = tipAt; budget < lines.length; budget += 1) {
      const sliced = slicePanelLines(lines, budget);
      expect(sliced[sliced.length - 1]?.kind, `budget=${budget}`).not.toBe("divider");
    }
  });

  it("clamps a nonsense budget to no rows instead of slicing from the end", () => {
    const lines = panelLines(fullData, CONTENT_WIDTH);
    expect(slicePanelLines(lines, -5)).toEqual([]);
    expect(slicePanelLines(lines, Number.NaN)).toEqual([]);
    expect(slicePanelLines(lines, 0)).toEqual([]);
    // A budget that only reaches the first section header drops it: a heading
    // with nothing under it reads as a bug, not as a heading.
    expect(slicePanelLines(lines, 2).map((line) => line.kind)).toEqual(["title"]);
    expect(slicePanelLines(lines, 3).map((line) => line.kind)).toEqual([
      "title",
      "section",
      "row",
    ]);
    expect(slicePanelLines(lines, lines.length + 10)).toEqual(lines);
  });
});

describe("the rendered panel (REQ-12)", () => {
  it("paints exactly the rows the plan paid for, and nothing wider", () => {
    const plan = sidePanelPlan({ columns: 120, availableHeight: 20, inset: 2 });
    const rows = renderPanel(plan, fullData);
    expect(rows).toHaveLength(plan.height);
    expect(rows[0]).toContain("┌");
    expect(rows[1]).toContain(PANEL_TITLE);
    expect(rows[rows.length - 1]).toContain("└");
    for (const row of rows) {
      expect(row.length, JSON.stringify(row)).toBeLessThanOrEqual(
        plan.width + SIDE_PANEL_GAP_COLUMNS,
      );
    }
  });

  it("draws each section as one header row carrying nothing but its label", () => {
    const plan = sidePanelPlan({ columns: 120, availableHeight: 20, inset: 2 });
    const rows = renderPanel(plan, fullData);
    const expected = slicePanelLines(
      panelLines(fullData, plan.contentWidth),
      plan.height - cardChrome("secondary").borderRows,
    );
    // One line is one terminal row: a header never shares a row with a value.
    const dataLines = expected.filter((line) => line.kind !== "divider" && line.kind !== "note");
    dataLines.forEach((line, index) => {
      expect(rows[index + 1], line.kind).toContain(lineText(line).trim());
      if (line.kind === "section") expect(body(rows[index + 1]!)).toBe(line.label);
    });
    // The tip block follows the data, not the other way round.
    expect(rows[plan.height - 2]).toContain(PANEL_TIP_PREFIX);
  });

  it("anchors the tip to the bottom of the box with a single flexible spacer", () => {
    const plan = sidePanelPlan({ columns: 120, availableHeight: 16, inset: 2 });
    const interior = renderPanel(plan, fullData).slice(1, plan.height - 1);
    expect(interior).toHaveLength(plan.height - SIDE_PANEL_BORDER_ROWS);
    // The tip block is the last two rows: the divider and the note.
    expect(interior[interior.length - 1]).toContain(`${PANEL_TIP_PREFIX}type / for commands`);
    expect(interior[interior.length - 2]).toContain("─");
    // It no longer floats in the middle: the data rows stay at the top and the
    // flexible spacer is the only blank row between them and the tip.
    const blanks = interior
      .map((row, index) => ({ index, text: body(row), blank: blankRow(row) }))
      .filter((row) => row.blank);
    expect(blanks).toHaveLength(1);
    expect(interior[0]).toContain(PANEL_TITLE);
    expect(blanks[0]!.index).toBe(interior.length - 3);
  });

  it("claims no spacer when the row budget cut the tip away", () => {
    // Eleven data rows fill this box exactly, so the tip (and its divider) are
    // sliced off — and with no tip there is no spacer to push around.
    const plan = sidePanelPlan({ columns: 120, availableHeight: 13, inset: 2 });
    const interior = renderPanel(plan, fullData).slice(1, plan.height - 1);
    expect(interior.some((row) => row.includes(PANEL_TIP_PREFIX))).toBe(false);
    expect(interior.some((row) => row.includes("─"))).toBe(false);
    expect(interior.filter((row) => blankRow(row))).toEqual([]);
    // The last row it could afford is real data, not an empty box.
    expect(body(interior[interior.length - 1]!)).toContain("muninn");
  });

  it("renders nothing at all when the plan says the panel stands down", () => {
    const hidden = sidePanelPlan({ columns: 80, availableHeight: 30, inset: 2 });
    expect(renderPanel(hidden, fullData).filter((row) => row !== "")).toEqual([]);
    expect(InfoPanel({ plan: hidden, data: fullData })).toBeNull();
  });

  it("gives every section header the dim token, not the row token", () => {
    // The colour is chalk-gated by the terminal in this suite (no TTY, so Ink
    // emits no SGR), which is why the header's token is asserted at its source,
    // the same way `card.test.ts` guards the surface→tone map.
    const source = readFileSync(new URL("../../src/tui/InfoPanel.tsx", import.meta.url), "utf8");
    const sectionCase = source.slice(
      source.indexOf('case "section":'),
      source.indexOf('case "divider":'),
    );
    expect(sectionCase).toContain("THEME.muted");
    expect(sectionCase).not.toContain("THEME.accentStrong");
    expect(sectionCase).toContain("height={1}");
    expect(sectionCase).toContain('wrap="truncate"');
  });
});
