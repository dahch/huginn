import { describe, expect, it } from "bun:test";
import { renderInlineSpans } from "./markdown";

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
