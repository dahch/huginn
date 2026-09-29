import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KIMI_DEFAULT_PROVIDER,
  parseKimiModels,
} from "../../../src/engine/agent/adapters/kimi.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/kimi-provider-list.json", import.meta.url));
const stdout = readFileSync(fixturePath, "utf8");

describe("REQ-27 · kimi (Kimi Code CLI) catalog parser (AC-27.4, Phase 3C)", () => {
  const models = parseKimiModels(stdout);

  it("parses every model alias of the captured `kimi provider list --json` fixture", () => {
    // 4 aliases; the `providers` map is metadata and never a model.
    expect(models).toHaveLength(4);
    expect(models.map((m) => m.id)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "kimi-k2.5-high",
      "gemini-3-pro",
    ]);
  });

  it("keeps the alias as the id (what `-m/--model` accepts) and maps displayName/provider", () => {
    expect(models.find((m) => m.id === "kimi-k2.5-high")).toEqual({
      id: "kimi-k2.5-high",
      name: "Kimi K2.5 (High)",
      provider: "moonshot",
    });
  });

  it("falls back to the alias as the name when the row has no displayName", () => {
    expect(models.find((m) => m.id === "deepseek-reasoner")).toEqual({
      id: "deepseek-reasoner",
      name: "deepseek-reasoner",
      provider: "deepseek",
    });
  });

  it("keeps a model reference that carries its own slash intact under its alias", () => {
    // The row's `model` is `google/gemini-3-pro`, but `--model` takes the alias.
    expect(models.find((m) => m.id === "gemini-3-pro")).toEqual({
      id: "gemini-3-pro",
      name: "Gemini 3 Pro",
      provider: "openrouter",
    });
  });

  it("never surfaces the providers map — and with it no credential field (only `models` is read)", () => {
    const serialized = JSON.stringify(models);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("DEEPSEEK_API_KEY");
    expect(serialized).not.toContain("baseUrl");
    expect(models.some((m) => m.id === "deepseek" || m.id === "moonshot")).toBe(false);
  });

  it("returns [] for the `{\"providers\":{},\"models\":{}}` a machine with no providers prints", () => {
    // The reference machine's real output: an empty catalog, not a failure.
    expect(parseKimiModels('{\n  "providers": {},\n  "models": {}\n}\n')).toEqual([]);
  });

  it("accepts a missing or non-object `models` map without inventing rows", () => {
    expect(parseKimiModels('{"providers":{"x":{"type":"openai"}}}')).toEqual([]);
    expect(parseKimiModels('{"models":null}')).toEqual([]);
    expect(parseKimiModels('{"models":[]}')).toEqual([]);
    expect(parseKimiModels('{"models":"nope"}')).toEqual([]);
  });

  it("falls back to the runtime provider label when a row names no provider", () => {
    expect(parseKimiModels('{"models":{"bare":{"model":"bare","maxContextSize":1000}}}')).toEqual([
      { id: "bare", name: "bare", provider: KIMI_DEFAULT_PROVIDER },
    ]);
    expect(parseKimiModels('{"models":{"bare":{"provider":"  ","model":"bare"}}}','Moonshot')[0]).toEqual({
      id: "bare",
      name: "bare",
      provider: "Moonshot",
    });
  });

  it("skips rows that are not model objects instead of inventing ids from them", () => {
    const parsed = parseKimiModels(
      [
        "{",
        '  "models": {',
        '    "listed": { "provider": "p", "model": "listed", "displayName": "Listed" },',
        '    "broken": 7,',
        '    "array-row": ["not", "a", "row"],',
        '    "null-row": null,',
        '    "name-less": { "provider": "p" }',
        "  }",
        "}",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { id: "listed", name: "Listed", provider: "p" },
      { id: "name-less", name: "name-less", provider: "p" },
    ]);
  });

  it("throws on a payload that is not a JSON object, so the caller says 'could not parse'", () => {
    expect(() => parseKimiModels("No providers configured.\n")).toThrow();
    expect(() => parseKimiModels("[]")).toThrow(/JSON object/);
    expect(() => parseKimiModels("null")).toThrow(/JSON object/);
    // Empty output is the runner's "printed no output", not a parse failure.
    expect(parseKimiModels("   \n")).toEqual([]);
  });
});
