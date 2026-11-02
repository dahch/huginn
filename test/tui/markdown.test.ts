import React from "react";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Card, cardChrome } from "../../src/tui/Card";
import {
  MarkdownLine,
  inlineSegments,
  isTableHeader,
  markdownSegments,
  renderInlineSpans,
  segmentsWidth,
  tableBlock,
  tableBlockEnd,
  wrapSegments,
} from "../../src/tui/markdown";
import { render } from "./inkRender";

describe("markdown segments", () => {
  it("keeps inline styling as segments and drops the markup", () => {
    const segments = markdownSegments("hola **mundo** y `codigo`", undefined);
    expect(segments.map((segment) => segment.text).join("")).toBe("hola mundo y codigo");
    expect(segments.find((segment) => segment.text === "mundo")?.bold).toBe(true);
    // Assert the token, not its colour: under `NO_COLOR` every theme token is
    // `undefined`, so "the code segment exists" is the invariant that holds.
    expect(segments.find((segment) => segment.text === "codigo")).toBeDefined();
  });

  it("carries the block prefix so the width math sees it", () => {
    expect(markdownSegments("- item", undefined).map((segment) => segment.text).join("")).toBe("• item");
    expect(markdownSegments("## Titulo", undefined)[0]?.text).toBe("## ");
    expect(markdownSegments("> cita", undefined)[0]?.text).toBe("│ ");
    expect(markdownSegments("1. paso", undefined).map((segment) => segment.text).join("")).toBe("1. paso");
  });

  it("recognises h1 and h3 headings and keeps their inline markup", () => {
    const h1 = markdownSegments("# Titulo **fuerte**", undefined, 40);
    expect(h1.map((segment) => segment.text).join("")).toBe("# Titulo fuerte");
    expect(h1[0]?.text).toBe("# ");
    expect(h1[0]?.bold).toBe(true);
    expect(h1.find((segment) => segment.text === "fuerte")?.bold).toBe(true);

    const h3 = markdownSegments("### Detalle", undefined, 40);
    expect(h3.map((segment) => segment.text).join("")).toBe("### Detalle");
    expect(h3[0]?.bold).toBe(true);
  });

  it("keeps the indentation of nested list items", () => {
    expect(markdownSegments("  - item", undefined).map((segment) => segment.text).join("")).toBe(
      "  • item",
    );
    expect(markdownSegments("  1. paso", undefined).map((segment) => segment.text).join("")).toBe(
      "  1. paso",
    );
  });

  it("supports both emphasis spellings without leaving the markup behind", () => {
    const underscoreBold = inlineSegments("__fuerte__");
    expect(underscoreBold).toEqual([{ text: "fuerte", color: undefined, bold: true }]);
    const underscoreItalic = inlineSegments("_suave_");
    expect(underscoreItalic).toEqual([{ text: "suave", color: undefined, italic: true }]);
    // A lone, unmatched token is body text, never styled.
    expect(inlineSegments("a * b").map((segment) => segment.text).join("")).toBe("a * b");
  });

  it("exposes the node-shaped façade for markup it can style", () => {
    expect(renderInlineSpans("uno **dos** tres").length).toBe(3);
    expect(renderInlineSpans("plain").length).toBe(1);
  });
});

describe("wrapSegments", () => {
  const sentence = "El correo se guarda unicamente en el navegador de quien se apunta";

  it("never exceeds the requested width and loses no content", () => {
    for (const width of [8, 12, 20, 40]) {
      const rows = wrapSegments(markdownSegments(sentence, undefined), width);
      for (const row of rows) {
        expect(segmentsWidth(row), `width=${width}`).toBeLessThanOrEqual(width);
      }
      const rejoined = rows.map((row) => row.map((segment) => segment.text).join("")).join(" ");
      // A word wider than the row is hard-split, so compare with blanks ignored.
      expect(rejoined.replace(/\s+/g, ""), `width=${width}`).toBe(sentence.replace(/\s+/g, ""));
    }
  });

  it("hard-splits a token wider than the row instead of overflowing", () => {
    const rows = wrapSegments([{ text: "x".repeat(25) }], 10);
    expect(rows.every((row) => segmentsWidth(row) <= 10)).toBe(true);
    expect(rows.map((row) => row[0]?.text ?? "").join("")).toBe("x".repeat(25));
  });

  it("counts double-width glyphs and keeps each row inside the width", () => {
    const rows = wrapSegments([{ text: "日本語 日本語" }], 7);
    expect(rows.map((row) => row.map((segment) => segment.text).join(""))).toEqual(["日本語", "日本語"]);
  });

  it("keeps a blank line as exactly one empty row", () => {
    expect(wrapSegments([], 20)).toEqual([[]]);
    expect(wrapSegments([{ text: "   " }], 20)).toEqual([[]]);
  });

  it("breaks between styled segments without splitting their markup", () => {
    const rows = wrapSegments(markdownSegments("uno dos **tres cuatro**", undefined), 10);
    for (const row of rows) expect(segmentsWidth(row)).toBeLessThanOrEqual(10);
    const bold = rows.flat().filter((segment) => segment.bold).map((segment) => segment.text).join(" ");
    expect(bold.trim()).toBe("tres cuatro");
  });
});

describe("markdown rules at the container width (H-06)", () => {
  it("draws a horizontal rule with the width it is given, not a fixed literal", () => {
    for (const width of [20, 44, 60]) {
      const rule = markdownSegments("---", undefined, width);
      expect(rule.map((segment) => segment.text).join("")).toBe("─".repeat(width));
      expect(wrapSegments(rule, width)).toHaveLength(1);
      expect(segmentsWidth(rule)).toBe(width);
    }
  });

  it("draws the code-fence header with the width it is given", () => {
    const header = markdownSegments("```ts", undefined, 30);
    expect(segmentsWidth(header)).toBe(30);
    expect(header.map((segment) => segment.text).join("")).toContain("[ts]");
    expect(segmentsWidth(markdownSegments("```", undefined, 8))).toBe(8);
  });

  it("keeps a horizontal rule on one row inside a 44-column card (H-06)", () => {
    const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
    stdout.columns = 80;
    stdout.rows = 24;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const instance = render(
      React.createElement(
        Card,
        { tone: "primary", width: 44 },
        React.createElement(MarkdownLine, { text: "---", width: 44 - cardChrome("primary").columns }),
      ),
      { stdout, patchConsole: false },
    );
    instance.unmount();
    const ansi = /\u001B\[[0-9;?]*[A-Za-z]/g;
    const lines = output.replace(ansi, "").split("\n").map((line) => line.replace(/\s+$/, ""));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    // The card really is 44 columns wide (top border, one body row, bottom).
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.length === 44)).toBe(true);
    const bodyRules = lines.filter((line) => line.includes("│") && line.includes("─"));
    expect(bodyRules).toHaveLength(1);
    expect(bodyRules[0]).toContain("─".repeat(44 - cardChrome("primary").columns));
  });
});

describe("links", () => {
  it("keeps the label underlined and the URL dim between guillemets", () => {
    const segments = markdownSegments("read [the docs](https://example.com/a?b=1) now", undefined, 80);
    const text = segments.map((segment) => segment.text).join("");
    expect(text).toBe("read the docs ‹https://example.com/a?b=1› now");
    expect(segments.find((segment) => segment.text === "the docs")?.underline).toBe(true);
    const url = segments.find((segment) => segment.text.includes("https://example.com"));
    expect(url?.dim).toBe(true);
    expect(text).not.toContain("](");
  });

  it("wraps a long link without losing its underline or overflowing", () => {
    const yellow = "https://example.com/a/very/long/path/that/does/not/fit";
    const rows = wrapSegments(markdownSegments(`see [docs](${yellow})`, undefined, 16), 16);
    for (const row of rows) expect(segmentsWidth(row)).toBeLessThanOrEqual(16);
    const underlined = rows.flat().filter((segment) => segment.underline).map((segment) => segment.text).join("");
    expect(underlined).toBe("docs");
  });

  it("keeps the label bold and underlined when the link sits inside a heading", () => {
    const segments = markdownSegments("## [docs](https://x/y)", undefined, 40);
    const text = segments.map((segment) => segment.text).join("");
    expect(text).toBe("## docs ‹https://x/y›");
    const label = segments.find((segment) => segment.text === "docs");
    expect(label?.underline).toBe(true);
    expect(label?.bold).toBe(true);
    expect(segments.some((segment) => segment.text.includes("["))).toBe(false);
  });

  it("leaves a malformed link as literal text instead of swallowing the line", () => {
    for (const raw of ["[a](b c)", "[a]()", "[label](not a url)", "[no url]"]) {
      const segments = markdownSegments(raw, undefined, 40);
      expect(segments.map((segment) => segment.text).join(""), raw).toBe(raw);
      expect(segments.some((segment) => segment.underline)).toBe(false);
    }
  });

  it("does not treat bare brackets or parenthesised prose as a link", () => {
    const segments = markdownSegments("see [the section] (below) and (this)", undefined, 60);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "see [the section] (below) and (this)",
    );
    expect(segments.some((segment) => segment.underline)).toBe(false);
  });
});

describe("width propagation contract", () => {
  it("passes the container width at every MarkdownLine call site", () => {
    for (const file of ["markdown.tsx", "Dashboard.tsx", "LiveDashboard.tsx"]) {
      const source = readFileSync(new URL(`../../src/tui/${file}`, import.meta.url), "utf8");
      const callSites = source.split("<MarkdownLine").slice(1);
      for (const site of callSites) {
        const element = site.slice(0, site.indexOf("/>"));
        expect(element, `${file} passes width to MarkdownLine`).toContain("width=");
      }
    }
  });
});

describe("tableBlock", () => {
  const rows = [
    "| Fase | Resultado |",
    "| --- | --- |",
    "| EXECUTE | ok |",
    "| VALIDATE_STEP | a cell that is much too long for the table |",
  ];

  it("emits exactly one row per input row", () => {
    expect(tableBlock(rows, 44)).toHaveLength(rows.length);
    expect(tableBlock(rows, 8)).toHaveLength(rows.length);
    expect(tableBlock([], 44)).toEqual([]);
  });

  it("aligns the columns and keeps every row inside the width", () => {
    const output = tableBlock(rows, 44);
    const text = output.map((row) => row.map((segment) => segment.text).join(""));
    const separatorColumns = [text[0]!, text[2]!, text[3]!].map((line) => line.indexOf("│"));
    expect(new Set(separatorColumns).size).toBe(1);
    for (const row of output) expect(segmentsWidth(row)).toBeLessThanOrEqual(44);
    // The column separator is dim; the header is the only bold row.
    expect(output[0]!.find((segment) => segment.text.includes("│"))?.dim).toBe(true);
    expect(output[0]![0]?.bold).toBe(true);
    expect(output[2]![0]?.bold).toBeUndefined();
  });

  it("truncates an overlong cell with an ellipsis instead of wrapping it", () => {
    const output = tableBlock(rows, 30);
    const last = output[output.length - 1]!.map((segment) => segment.text).join("");
    expect(last).toContain("…");
    expect(last).not.toContain("much too long for the table");
    for (const row of output) expect(segmentsWidth(row)).toBeLessThanOrEqual(30);
  });

  it("renders the markdown separator line, not the raw pipes", () => {
    const output = tableBlock(rows, 44);
    const separator = output[1]!.map((segment) => segment.text).join("");
    expect(separator).toContain("─");
    expect(separator).not.toContain("---");
  });

  it("detects a contiguous table block and stops at the first non-table line", () => {
    const lines = [...rows, "", "after the table"];
    expect(isTableHeader(lines, 0)).toBe(true);
    expect(isTableHeader(lines, 1)).toBe(false);
    expect(tableBlockEnd(lines, 0)).toBe(rows.length);
  });
});
