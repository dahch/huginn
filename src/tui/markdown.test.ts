import { describe, expect, it } from "bun:test";
import { markdownBlockRows, renderInlineSpans, segmentsWidth, tableBlock } from "./markdown";

describe("renderInlineSpans", () => {
  it("parses plain text without modification", () => {
    const nodes = renderInlineSpans("Hello world");
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("extracts inline code enclosed in backticks", () => {
    const nodes = renderInlineSpans("Use `npm run test` now");
    expect(nodes.length).toBe(3);
  });

  it("extracts bold tokens enclosed in double asterisks", () => {
    const nodes = renderInlineSpans("This is **critical** requirement");
    expect(nodes.length).toBe(3);
  });

  it("extracts italic tokens enclosed in single asterisks or underscores", () => {
    const nodes = renderInlineSpans("This is *important* and _useful_");
    expect(nodes.length).toBe(4);
  });

  it("handles mixed markdown in a single line", () => {
    const nodes = renderInlineSpans("1. **¿Qué campos edita?** Opciones: solo `retitle <id>` o ambos");
    expect(nodes.length).toBeGreaterThan(3);
  });
});


describe("markdownBlockRows", () => {
  it("wraps a long line into terminal rows that each fit the width", () => {
    const rows = markdownBlockRows(["x".repeat(200)], 40);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) expect(segmentsWidth(row)).toBeLessThanOrEqual(40);
  });

  it("expands a table block through tableBlock, one row per source row", () => {
    const lines = ["| a | b |", "|---|---|", "| 1 | 2 |"];
    const rows = markdownBlockRows(lines, 40);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(tableBlock(lines, 40));
  });

  it("keeps an empty line as one paintable row", () => {
    expect(markdownBlockRows([""], 20)).toHaveLength(1);
  });
});
