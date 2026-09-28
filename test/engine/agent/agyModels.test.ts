import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGY_DEFAULT_PROVIDER,
  parseAgyModels,
} from "../../../src/engine/agent/adapters/agy.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/agy-models.txt", import.meta.url));
const stdout = readFileSync(fixturePath, "utf8");

describe("REQ-27 · agy (Antigravity CLI) catalog parser (AC-27.4)", () => {
  const models = parseAgyModels(stdout);

  it("parses every TSV row of the captured `agy models` fixture", () => {
    expect(stdout.split(/\r?\n/).filter(Boolean)).toHaveLength(14);
    expect(models).toHaveLength(14);
  });

  it("maps each id to its display name, e.g. gemini-3.8-flash-high", () => {
    expect(models.find((m) => m.id === "gemini-3.8-flash-high")).toEqual({
      id: "gemini-3.8-flash-high",
      name: "Gemini 3.8 Flash (High)",
      provider: AGY_DEFAULT_PROVIDER,
    });
    expect(models.find((m) => m.id === "gpt-oss-120b-medium")?.name).toBe("GPT-OSS 120B (Medium)");
  });

  it("ignores the `Fetching available models...` preamble", () => {
    const withPreamble = parseAgyModels(`Fetching available models...\n${stdout}`);
    expect(withPreamble).toEqual(models);
    expect(withPreamble.some((m) => m.id.includes("Fetching"))).toBe(false);
  });

  it("falls back to the runtime label without a `provider/` prefix", () => {
    expect(models.every((m) => m.provider === AGY_DEFAULT_PROVIDER)).toBe(true);
    expect(parseAgyModels("openai/gpt-5.1\tGPT-5.1\n")[0].provider).toBe("openai");
    // An injectable label keeps the parser usable from a differently branded caller.
    expect(parseAgyModels("bare-model\tBare\n", "Antigravity")[0].provider).toBe("Antigravity");
  });

  it("dedupes ids, skips whitespace-bearing ids and non-TSV noise", () => {
    const parsed = parseAgyModels(
      [
        "Fetching available models...",
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
        "not a model row",
        "two tokens\tTabbed",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", provider: "agy" },
    ]);
  });

  it("falls back to the id as the name and returns [] for empty output", () => {
    expect(parseAgyModels("gemini-3.8-flash-high\t\n")[0].name).toBe("gemini-3.8-flash-high");
    expect(parseAgyModels("")).toEqual([]);
    expect(parseAgyModels("Fetching available models...\n")).toEqual([]);
  });
});
