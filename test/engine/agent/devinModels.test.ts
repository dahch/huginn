import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEVIN_DEFAULT_PROVIDER,
  parseDevinModels,
} from "../../../src/engine/agent/adapters/devin.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/devin-models.txt", import.meta.url));
const stdout = readFileSync(fixturePath, "utf8");

describe("REQ-27 · Devin catalog parser (AC-27.4)", () => {
  const models = parseDevinModels(stdout);

  it("parses every variant row of the captured `devin models list` fixture", () => {
    // 763 lines: 1 preamble + 54 family headers + 7 `aliases:` lines + 644
    // variant rows + 55 blank separators + 2 footer lines.
    expect(models).toHaveLength(644);
    expect(new Set(models.map((m) => m.provider)).size).toBe(54);
  });

  it("maps each model uid to its label, family and cost/context annotation", () => {
    expect(models.find((m) => m.id === "claude-opus-5-5-medium")).toEqual({
      id: "claude-opus-5-5-medium",
      name: "Claude Opus 5.5 Medium",
      provider: "Claude Opus 5.5",
      description: "$4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output",
    });
    expect(models.find((m) => m.id === "adaptive")).toEqual({
      id: "adaptive",
      name: "Adaptive",
      provider: "Adaptive",
      description: "$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output",
    });
  });

  it("keeps a variant without an annotation description-less", () => {
    expect(models.find((m) => m.id === "swe-2-high")).toEqual({
      id: "swe-2-high",
      name: "SWE-2 High",
      provider: "SWE-2",
      description: undefined,
    });
  });

  it("preserves uppercase model uids and parenthesised labels verbatim", () => {
    expect(models.find((m) => m.id === "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL")?.name).toBe(
      "Gemini 3 Flash Minimal",
    );
    // A Fusion label carries its own parentheses, which must survive.
    expect(
      models.find((m) => m.id === "fusion-claude-opus-5-5-medium-sidekick-swe-2-medium")?.name,
    ).toBe("Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)");
  });

  it("never turns the preamble, family headings, `aliases:` lines or footer into models", () => {
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain("Available");
    expect(ids).not.toContain("Pass");
    expect(ids).not.toContain("SWE-2");
    expect(ids).not.toContain("Adaptive");
    // `swe` is the SWE-2 family alias, not a model uid.
    expect(ids).not.toContain("swe");
    expect(ids).not.toContain("claude");
    expect(models.every((m) => !m.id.includes(" ") && m.provider.length > 0)).toBe(true);
  });

  it("ignores a prepended/leading preamble and trailing noise", () => {
    const noisy = parseDevinModels(`Fetching catalog…\n\u001b[32mAvailable models (54 families)\u001b[0m\n${stdout}\nTrailing noise\n`);
    expect(noisy).toEqual(models);
  });

  it("falls back to the runtime provider for an orphan row and returns [] for empty output", () => {
    expect(parseDevinModels("  lone-uid   Lone Model\n")).toEqual([
      { id: "lone-uid", name: "Lone Model", provider: DEVIN_DEFAULT_PROVIDER, description: undefined },
    ]);
    expect(parseDevinModels("")).toEqual([]);
    expect(parseDevinModels("Available models (0 families)\n")).toEqual([]);
  });

  it("dedupes repeated model uids", () => {
    const parsed = parseDevinModels(
      [
        "SWE-2 (swe-2)",
        "  aliases: swe",
        "  swe-2-high   SWE-2 High",
        "  swe-2-high   SWE-2 High",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { id: "swe-2-high", name: "SWE-2 High", provider: "SWE-2", description: undefined },
    ]);
  });
});
