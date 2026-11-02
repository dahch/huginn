import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Box } from "ink";
import stringWidth from "string-width";
import { render } from "./inkRender";
import { Card, cardChrome } from "../../src/tui/Card";
import { Dashboard, StreamCard } from "../../src/tui/Dashboard";
import { events } from "../../src/engine/engineEvents";
import type { CycleEngine } from "../../src/engine/cycle";
import type { RunConfig } from "../../src/config";
import {
  MarkdownBlock,
  MarkdownLine,
  isTableHeader,
  markdownSegments,
  segmentsWidth,
  tableBlock,
  tableBlockEnd,
  type MdSegment,
  type TableRowInput,
} from "../../src/tui/markdown";

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** The visible rows of the last frame, trailing blanks dropped. */
function visibleLines(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function renderNode(node: React.ReactElement, columns = 80, rows = 40): string[] {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const instance = render(node, { stdout, patchConsole: false });
  instance.unmount();
  return visibleLines(output);
}

/** One rendered table row as plain text. */
function rowText(row: readonly MdSegment[]): string {
  return row.map((segment) => segment.text).join("");
}

function rowTexts(rows: readonly (readonly MdSegment[])[]): string[] {
  return rows.map(rowText);
}

/**
 * The *display* column the first `│` lands on. `indexOf` would lie for a row
 * with double-width glyphs (`名` is one char but two columns), and alignment is
 * a display-column promise.
 */
function separatorColumn(row: readonly MdSegment[]): number {
  let column = 0;
  for (const segment of row) {
    const at = segment.text.indexOf("│");
    if (at !== -1) return column + stringWidth(segment.text.slice(0, at));
    column += stringWidth(segment.text);
  }
  return -1;
}

const TABLE: readonly string[] = [
  "| Fase | Resultado |",
  "| --- | --- |",
  "| EXECUTE | ok |",
  "| VALIDATE_STEP | a cell that is much too long for a narrow table |",
];

describe("table detection: isTableHeader", () => {
  it("recognises a header only when a separator row follows it", () => {
    expect(isTableHeader(TABLE, 0)).toBe(true);
    expect(isTableHeader(["| A | B |", "| --- | --- |"], 0)).toBe(true);
  });

  it("rejects a header whose next line is blank, prose or missing", () => {
    expect(isTableHeader(["| A | B |", "", "| --- | --- |"], 0)).toBe(false);
    expect(isTableHeader(["| A | B |", "some prose"], 0)).toBe(false);
    expect(isTableHeader(["| A | B |"], 0)).toBe(false);
    expect(isTableHeader([], 0)).toBe(false);
  });

  it("rejects a line without a pipe, however table-like its neighbours are", () => {
    expect(isTableHeader(["no pipes here", "| --- | --- |"], 0)).toBe(false);
  });

  it("accepts alignment colons and rows without outer pipes", () => {
    expect(isTableHeader(["Fase | Resultado", "--- | ---:"], 0)).toBe(true);
    expect(isTableHeader(["| a | b |", "|:--:|--:|"], 0)).toBe(true);
  });

  it("does not mistake bullet lists or prose containing a pipe for a table", () => {
    expect(isTableHeader(["- a | b", "- c | d"], 0)).toBe(false);
    expect(isTableHeader(["use the a|b operator", "and keep going"], 0)).toBe(false);
  });
});

describe("table detection: tableBlockEnd", () => {
  const lines = [...TABLE.map(String), "", "after the table"];

  it("spans the header, the separator and every contiguous row", () => {
    expect(tableBlockEnd(lines, 0)).toBe(TABLE.length);
  });

  it("stops at the first blank line, non-table line or end of input", () => {
    expect(tableBlockEnd(["| a | b |", "|---|---|", "| 1 | 2 |"], 0)).toBe(3);
    expect(tableBlockEnd(["| a | b |", "|---|---|", "not a row"], 0)).toBe(2);
    expect(tableBlockEnd(["| a | b |", "|---|---|", "| 1 | 2 |", ""], 0)).toBe(3);
  });
});

describe("tableBlock: pure, one row in for one row out", () => {
  it("returns nothing for an empty block", () => {
    expect(tableBlock([], 40)).toEqual([]);
  });

  it("emits exactly one row per input row at every width", () => {
    for (const width of [0, 1, 5, 12, 30, 44, 120]) {
      expect(tableBlock(TABLE, width), `width=${width}`).toHaveLength(TABLE.length);
    }
  });

  it("truncates instead of wrapping, so no row ever spends two terminal rows", () => {
    const output = tableBlock(TABLE, 30);
    for (const row of output) {
      expect(segmentsWidth(row)).toBeLessThanOrEqual(30);
    }
    const last = rowText(output[output.length - 1]!);
    expect(last).toContain("…");
    expect(last).not.toContain("much too long for a narrow table");
    // One ellipsis per truncated cell, never a hard cut without a marker.
    expect(last.match(/…/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("pads every cell to its column width so the separators line up", () => {
    const output = tableBlock(TABLE, 44);
    const separatorColumns = output.map(separatorColumn);
    expect(separatorColumns.every((column) => column === separatorColumns[0])).toBe(true);
    expect(separatorColumns[0]).toBeGreaterThan(0);
  });

  it("derives the column widths from every content row, not only the header", () => {
    const rows = ["| a | b |", "|---|---|", "| a much wider cell | b |"];
    const output = rowTexts(tableBlock(rows, 40));
    // The header is padded to the widest cell of its column.
    expect(output[0]).toBe("a                 │ b");
    expect(output[2]).toBe("a much wider cell │ b");
  });

  it("marks the header bold and the separators dim, without leaking raw pipes", () => {
    const output = tableBlock(TABLE, 44);
    expect(output[0]!.find((segment) => segment.text.includes("│"))?.dim).toBe(true);
    expect(output[0]![0]?.bold).toBe(true);
    expect(output[2]![0]?.bold).toBeUndefined();

    const separator = rowText(output[1]!);
    expect(separator).toContain("─");
    expect(separator).not.toContain("---");
    expect(rowTexts(output).join("\n")).not.toContain("|");
  });

  it("accepts rows already split into cells and yields the same table", () => {
    const cells: readonly TableRowInput[] = [
      ["Fase", "Resultado"],
      ["---", "---"],
      ["EXECUTE", "ok"],
    ];
    expect(rowTexts(tableBlock(cells, 44))).toEqual(
      rowTexts(tableBlock(["| Fase | Resultado |", "| --- | --- |", "| EXECUTE | ok |"], 44)),
    );
  });

  it("counts double-width glyphs when padding and truncating", () => {
    const rows = ["| 名 | b |", "|---|---|", "| 日本語 | c |", "| 日本語日本語日本語 | c |"];
    const output = tableBlock(rows, 20);
    for (const row of output) expect(segmentsWidth(row)).toBeLessThanOrEqual(20);
    const separatorColumns = output.map(separatorColumn);
    expect(new Set(separatorColumns).size).toBe(1);
    expect(rowText(output[output.length - 1]!)).toContain("…");
  });

  it("keeps a single-column table on one row per entry without a column gap", () => {
    // The row's trailing padding is trimmed (a row never ends in drawn blanks).
    const output = rowTexts(tableBlock(["| only |", "|---|", "| value |"], 20));
    expect(output).toEqual(["only", "─────", "value"]);
  });

  it("degrades to blank rows, never an overflow, when the width cannot hold the gaps", () => {
    const output = tableBlock(TABLE, 1);
    expect(output).toHaveLength(TABLE.length);
    for (const row of output) expect(segmentsWidth(row)).toBeLessThanOrEqual(1);
  });

  it("does not throw on a non-finite width and still returns one row per input row", () => {
    expect(() => tableBlock(TABLE, Number.NaN)).not.toThrow();
    expect(tableBlock(TABLE, Number.POSITIVE_INFINITY)).toHaveLength(TABLE.length);
  });

  it("keeps ragged rows aligned by padding the missing cells", () => {
    const rows = ["| A | B | C |", "| --- | --- | --- |", "| 1 |", "| 2 | 3 | 4 |"];
    const output = tableBlock(rows, 40);
    const separatorColumns = output.map(separatorColumn);
    expect(new Set(separatorColumns).size).toBe(1);
    expect(output).toHaveLength(rows.length);
  });

  it("is referentially transparent for the same input", () => {
    expect(tableBlock(TABLE, 40)).toEqual(tableBlock(TABLE, 40));
  });

  // Iteration 5: a cell's inline markup is parsed into styled segments while
  // the column width is measured on the visible text, so the table stays
  // aligned and `**bold**` / `` `code` `` reach the terminal as styles.
  it("renders inline markup (bold, code) inside table cells without breaking alignment", () => {
    const rows = [
      "| Fase | Resultado |",
      "| --- | --- |",
      "| SECURE_CHECK | **Robustez** |",
      "| TEST_MODULE | `npm audit` |",
    ];
    const output = tableBlock(rows, 44);
    const text = rowTexts(output).join("\n");

    // No raw markup survives the parse.
    expect(text).not.toContain("**");
    expect(text).not.toContain("`");
    // The header is still bold and the body's emphasis is carried by segments.
    expect(
      output[0]!
        .filter((segment) => segment.text.trim() !== "" && segment.dim !== true)
        .every((segment) => segment.bold === true),
    ).toBe(true);
    const bold = output[2]!.find((segment) => segment.text === "Robustez");
    expect(bold?.bold).toBe(true);
    const code = output[3]!.find((segment) => segment.text === "npm audit");
    expect(code?.color).toBeDefined();

    // Column widths came from the visible text, so the separators still line up.
    const separatorColumns = output.map(separatorColumn);
    expect(new Set(separatorColumns).size).toBe(1);
    expect(separatorColumns[0]).toBeGreaterThan(0);
    for (const row of output) expect(segmentsWidth(row)).toBeLessThanOrEqual(44);
  });

  it("measures a styled cell on its visible text, not on its raw markup", () => {
    const marked = ["| **Robustez** | ok |", "| --- | --- |", "| x | y |"];
    const plain = ["| Robustez | ok |", "| --- | --- |", "| x | y |"];
    const markedRows = rowTexts(tableBlock(marked, 40));

    // A raw-markup width would reserve four extra columns for `**` and push the
    // second cell right; the visible width keeps both tables identical.
    expect(markedRows).toEqual(rowTexts(tableBlock(plain, 40)));
    expect(markedRows[0]).toBe("Robustez │ ok");
    expect(markedRows[2]).toBe(`${"x".padEnd("Robustez".length)} │ y`);
    expect(markedRows[2]).not.toBe(`${"x".padEnd("**Robustez**".length)} │ y`);
  });

  it("never leaks a cut cell's style into its ellipsis", () => {
    const rows = [
      "| Fase | Resultado |",
      "| --- | --- |",
      "| **a bold value far too long for the cell** | ok |",
    ];
    const output = tableBlock(rows, 16);
    const last = output[output.length - 1]!;

    expect(rowText(last)).toContain("…");
    const marker = last.find((segment) => segment.text.includes("…"));
    expect(marker?.text).toBe("…");
    expect(marker?.bold).toBeUndefined();
    expect(marker?.italic).toBeUndefined();
    expect(marker?.color).toBeUndefined();
  });

  it("truncates a styled cell on one row and drops the style past the cut", () => {
    const rows = [
      "| Fase | Resultado |",
      "| --- | --- |",
      "| EXECUTE | **a bold value far too long for the cell** |",
    ];
    const output = tableBlock(rows, 20);
    expect(output).toHaveLength(rows.length);
    const last = output[output.length - 1]!;
    expect(rowText(last)).toContain("…");
    expect(rowText(last)).not.toContain("far too long for the cell");
    expect(segmentsWidth(last)).toBeLessThanOrEqual(20);
    expect(output.map(separatorColumn).every((column) => column === separatorColumn(output[0]!))).toBe(
      true,
    );
  });

  it("spends the same rows for a marked-up table as for its plain-text twin", () => {
    const plain = [
      "| Fase | Resultado | Robustez |",
      "| --- | --- | --- |",
      "| EXECUTE | ok | npm audit |",
      "| VALIDATE_STEP | a cell that is much too long for a narrow table | fine |",
    ];
    const marked = [
      "| **Fase** | Resultado | Robustez |",
      "| --- | --- | --- |",
      "| EXECUTE | `ok` | `npm audit` |",
      "| VALIDATE_STEP | **a cell that is much too long for a narrow table** | fine |",
    ];
    const rendered = (rows: readonly string[], width: number): number =>
      renderNode(React.createElement(MarkdownBlock, { lines: rows, width }), 100, 30).length;
    expect(rendered(marked, 96)).toBe(rendered(plain, 96));
    expect(tableBlock(marked, 96)).toHaveLength(tableBlock(plain, 96).length);
    // At the real dashboard width the table still spends one row per source row.
    expect(rendered(marked, 96)).toBe(marked.length);

    // ...and the 100×30 frame keeps the marked-up table aligned: every row
    // meets at the same display column and no markup reaches the terminal.
    const painted = renderNode(React.createElement(MarkdownBlock, { lines: marked, width: 96 }), 100, 30);
    const separatorColumns = painted.map((line) => stringWidth(line.slice(0, line.indexOf("│"))));
    expect(new Set(separatorColumns).size).toBe(1);
    expect(separatorColumns[0]).toBeGreaterThan(0);
    expect(painted.join("\n")).not.toContain("**");
    expect(painted.join("\n")).not.toContain("`");
  });
});

describe("MarkdownBlock: contiguous tables in a report", () => {
  const lines = ["before", ...TABLE.slice(0, 3).map(String), "| EXECUTE | ok |", "after"];

  it("renders one terminal row per markdown line, table rows included", () => {
    const rendered = renderNode(React.createElement(MarkdownBlock, { lines, width: 40 }));
    expect(rendered).toHaveLength(lines.length);
    expect(rendered[0]).toBe("before");
    expect(rendered[rendered.length - 1]).toBe("after");
  });

  it("aligns every row of the rendered table on the same separator column", () => {
    const rendered = renderNode(React.createElement(MarkdownBlock, { lines, width: 40 }));
    const tableRows = rendered.slice(1, -1);
    expect(tableRows).toHaveLength(4);
    const separatorColumns = tableRows.map((line) => line.indexOf("│"));
    expect(new Set(separatorColumns).size).toBe(1);
    expect(tableRows[1]).toContain("─");
  });

  it("keeps the last maxRows rows so a clipped report still ends at its tail", () => {
    const rendered = renderNode(
      React.createElement(MarkdownBlock, { lines, width: 40, maxRows: 3 }),
    );
    expect(rendered).toHaveLength(3);
    expect(rendered[rendered.length - 1]).toBe("after");
    expect(rendered).not.toContain("before");
  });

  it("renders nothing when maxRows is zero", () => {
    const rendered = renderNode(
      React.createElement(MarkdownBlock, { lines, width: 40, maxRows: 0 }),
    );
    expect(rendered).toEqual([]);
  });

  it("asks colorFor for every non-table line with its original index", () => {
    const colorFor = vi.fn(() => undefined);
    renderNode(React.createElement(MarkdownBlock, { lines, width: 40, colorFor }));
    expect(colorFor).toHaveBeenCalledTimes(2);
    expect(colorFor).toHaveBeenNthCalledWith(1, "before", 0);
    expect(colorFor).toHaveBeenNthCalledWith(2, "after", 5);
  });

  it("keeps a blank line as exactly one row", () => {
    const rendered = renderNode(
      React.createElement(MarkdownBlock, { lines: ["a", "", "b"], width: 20 }),
    );
    expect(rendered).toEqual(["a", "", "b"]);
  });
});

describe("width propagation (H-06 regression)", () => {
  const cardWidth = 44;
  const bodyWidth = cardWidth - cardChrome("primary").columns;

  it("draws the rule at the width MarkdownLine was given, inside a 44-column card", () => {
    const lines = renderNode(
      React.createElement(
        Card,
        { tone: "primary", width: cardWidth },
        React.createElement(MarkdownLine, { text: "---", width: bodyWidth }),
      ),
    );
    // Top border, one body row, bottom border — a 44-column card is 44 wide.
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.length === cardWidth)).toBe(true);
    expect(lines[1]).toBe(`│ ${"─".repeat(bodyWidth)} │`);
  });

  it("keeps a horizontal rule on exactly one row inside a 44-column card", () => {
    const lines = renderNode(
      React.createElement(
        Card,
        { tone: "primary", width: cardWidth },
        React.createElement(MarkdownLine, { text: "---", width: bodyWidth }),
      ),
    );
    // The card's own border rows are drawn with `─` too; only the body rows
    // (which start with the side border) are the rule under test.
    const ruleRows = lines.filter(
      (line) => line.startsWith("│") && line.includes("─".repeat(10)),
    );
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]).toBe(`│ ${"─".repeat(bodyWidth)} │`);
  });

  it("falls back to a bounded default when the width is unknown or nonsense", () => {
    const defaultRule = rowText(markdownSegments("---", undefined));
    expect(defaultRule).toBe("─".repeat(80));
    expect(rowText(markdownSegments("---", undefined, Number.NaN))).toBe("─".repeat(80));
    expect(rowText(markdownSegments("---", undefined, Number.POSITIVE_INFINITY))).toBe(
      "─".repeat(80),
    );
    // Never `repeat(0)`/`repeat(-n)`: a rule still owns one column and cannot throw.
    expect(rowText(markdownSegments("---", undefined, 0))).toBe("─");
    expect(rowText(markdownSegments("---", undefined, -12))).toBe("─");
  });

  it("draws the code-fence header at the width it is given", () => {
    expect(segmentsWidth(markdownSegments("```ts", undefined, 30))).toBe(30);
    expect(segmentsWidth(markdownSegments("```", undefined, 12))).toBe(12);
    // Narrower than the label: the header degrades to a plain full-width rule.
    expect(rowText(markdownSegments("```typescript", undefined, 6))).toBe("──────");
  });

  it("fits the rule StreamCard draws inside the 44-column card it is given", () => {
    const width = 44;
    const body = width - cardChrome("secondary").columns;
    const lines = renderNode(
      React.createElement(
        Box,
        { width },
        React.createElement(StreamCard, {
          lines: ["---"],
          chars: 3,
          spinner: "x",
          verbose: false,
          height: 8,
          width,
        }),
      ),
    );
    expect(lines[0]!.length).toBe(width);
    const rule = lines.find((line) => line.startsWith("│ ─"));
    expect(rule).toBe(`│ ${"─".repeat(body)} │`);
    expect(lines.filter((line) => line.startsWith("│ ─")).length).toBe(1);
  });
});

/**
 * The dashboard is the caller that has to hand the *real* column budget down:
 * it derives the stream column from the terminal width and the 42/58 split
 * (Dashboard.tsx). This mounts the real `Dashboard` and checks the rule that
 * reaches the frame, so an off-by-one in that arithmetic cannot hide behind the
 * component-level test above.
 */
describe("Dashboard hands the stream column its real width", () => {
  const dashboardFrame = async (columns: number, rows: number): Promise<string[]> => {
    // `useTerminalSize()` reads `process.stdout`, not the stream Ink writes to.
    // Without this stub the dashboard lays itself out for the 80-column default
    // and the stream column would not be the one this test computes.
    const originalColumns = process.stdout.columns;
    const originalRows = process.stdout.rows;
    Object.defineProperty(process.stdout, "columns", {
      value: columns,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true, writable: true });
    const engine = {
      getState: () => ({ currentIteration: 1, currentPhase: "EXECUTE" }),
      runtime: {
        id: "commandcode",
        getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
      },
      resolveDecision: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      requestAbort: vi.fn(),
    } as unknown as CycleEngine;
    const cfg = {
      projectPath: "/tmp/p",
      thinker: "a/b",
      executor: "c/d",
      mode: "auto",
      profile: "huginn",
    } as unknown as RunConfig;
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode: () => unknown;
      ref: () => unknown;
      unref: () => unknown;
    };
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    events.clear();
    const lines = await new Promise<string[]>((resolve) => {
      const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
      stdout.columns = columns;
      stdout.rows = rows;
      let output = "";
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const instance = render(
        React.createElement(Dashboard, { engine, cfg, autoExit: false }),
        { stdout, stdin, patchConsole: false },
      );
      setTimeout(() => {
        events.emit("phaseStream", { text: "---\n" });
        setTimeout(() => {
          instance.unmount();
          Object.defineProperty(process.stdout, "columns", {
            value: originalColumns,
            configurable: true,
            writable: true,
          });
          Object.defineProperty(process.stdout, "rows", {
            value: originalRows,
            configurable: true,
            writable: true,
          });
          resolve(visibleLines(output));
        }, 120);
      }, 60);
    });
    return lines;
  };

  it("draws the stream rule exactly as wide as the stream column it computed", async () => {
    const columns = 100;
    const lines = await dashboardFrame(columns, 30);
    const contentColumns = columns - 2; // the dashboard's own `paddingX={1}`
    const streamWidth = Math.floor(contentColumns * 0.58);
    const body = streamWidth - cardChrome("secondary").columns;

    // The stream card shares its rows with the pipeline card, so the rule is
    // matched as a body row of the right-hand card, not as a whole line.
    const runs = lines.flatMap((line) => [...line.matchAll(/│ (─{10,}) │/g)].map((m) => m[1]!));
    expect(runs).toHaveLength(1);
    // One row, and one row only: the run is exactly the card's body width.
    expect(runs[0]).toBe("─".repeat(body));
    expect(stringWidth(runs[0]!)).toBe(streamWidth - cardChrome("secondary").columns);
    // The rule did not push the frame past the terminal it was laid out for.
    const ruleLine = lines.find((line) => line.includes(runs[0]!))!;
    expect(stringWidth(ruleLine)).toBeLessThanOrEqual(columns);
    // Nothing in the frame overflows the terminal it was laid out for.
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
  });
});
