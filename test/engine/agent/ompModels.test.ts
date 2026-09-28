import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseOmpModels } from "../../../src/engine/agent/adapters/omp.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/omp-models.txt", import.meta.url));
const stdout = readFileSync(fixturePath, "utf8");

/** Data rows of the box-drawing table (`│ … │`), minus the repeated header row. */
const fixtureDataRows = stdout
  .split(/\r?\n/)
  .filter((line) => line.trimStart().startsWith("│"))
  .filter((line) => !/^\s*│\s*model\s*│/.test(line));

describe("REQ-27 · Oh My Pi catalog parser (AC-27.4)", () => {
  const models = parseOmpModels(stdout);

  it("parses every data row of the captured `omp models` fixture", () => {
    expect(fixtureDataRows).toHaveLength(192);
    expect(models).toHaveLength(fixtureDataRows.length);
  });

  it("uses the model column of the first table cell and the section heading as provider", () => {
    const flash = models.find((m) => m.id === "deepseek/deepseek-flash");
    expect(flash).toBeDefined();
    expect(flash?.name).toBe("deepseek-flash");
    expect(flash?.provider).toBe("deepseek");

    const zenFlash = models.find((m) => m.id === "opencode-zen/gemini-3.8-flash");
    expect(zenFlash?.name).toBe("gemini-3.8-flash");
    expect(zenFlash?.provider).toBe("opencode-zen");
  });

  it("attributes every model to one of the five captured provider sections", () => {
    expect([...new Set(models.map((m) => m.provider))].sort()).toEqual([
      "deepseek",
      "fireworks",
      "ollama",
      "opencode-go",
      "opencode-zen",
    ]);
  });

  it("keeps the same model name under different sections as distinct ids", () => {
    const ids = models.filter((m) => m.name === "deepseek-flash").map((m) => m.id);
    expect(ids).toEqual(["deepseek/deepseek-flash", "opencode-go/deepseek-flash"]);
  });

  it("never turns a heading, header row or border line into a model id", () => {
    const ids = models.map((m) => m.id);

    // Border art / headers / headings.
    expect(ids).not.toContain("model");
    expect(ids.some((id) => /[\s│┌┬┐├┼┤└┴┘─]/.test(id))).toBe(false);
    expect(ids.some((id) => id.includes("("))).toBe(false);
    expect(ids.some((id) => /^\d+$/.test(id))).toBe(false);
    expect(models.every((m) => m.provider.length > 0 && !m.provider.includes("│"))).toBe(true);

    // Every fixture data row contributed exactly one id.
    for (const row of fixtureDataRows) {
      const name = row.split("│")[1]?.trim() ?? "";
      expect(ids.some((id) => id.endsWith(`/${name}`))).toBe(true);
    }
  });

  it("derives a description from the real table columns", () => {
    const flash = models.find((m) => m.id === "deepseek/deepseek-flash");
    expect(flash?.description).toContain("context 1M");
    expect(flash?.description).toContain("max-out 384K");
    expect(flash?.description).toContain("thinking low,high,max");
  });

  it("dedupes repeated ids and stays tolerant of missing sections", () => {
    const parsed = parseOmpModels(
      [
        "deepseek (2)",
        "┌──────┬─────────┐",
        "│ model │ context │",
        "├──────┼─────────┤",
        "│ deepseek-flash │ 1M │",
        "│ deepseek-flash │ 1M │",
        "│ deepseek-v4-pro │ 1M │",
        "└──────┴─────────┘",
      ].join("\n"),
    );

    expect(parsed).toEqual([
      {
        id: "deepseek/deepseek-flash",
        name: "deepseek-flash",
        provider: "deepseek",
        description: "context 1M",
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "deepseek-v4-pro",
        provider: "deepseek",
        description: "context 1M",
      },
    ]);
  });

  it("strips ANSI noise and returns [] for empty or garbage output", () => {
    const parsed = parseOmpModels("\u001b[32m│ deepseek-flash │ 1M │\u001b[0m\n");
    expect(parsed).toEqual([
      { id: "deepseek-flash", name: "deepseek-flash", provider: "deepseek-flash", description: "1M" },
    ]);

    expect(parseOmpModels("")).toEqual([]);
    expect(parseOmpModels("\n\n   \n")).toEqual([]);
    expect(parseOmpModels("┌───┬───┐\n│ model │ context │\n└───┴───┘\n")).toEqual([]);
  });
});
