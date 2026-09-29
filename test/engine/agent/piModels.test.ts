import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePiModels } from "../../../src/engine/agent/adapters/pi.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/pi-models.txt", import.meta.url));
const stdout = readFileSync(fixturePath, "utf8");

describe("REQ-27 · pi (Pi coding agent) catalog parser (AC-27.4, Phase 3C)", () => {
  const models = parsePiModels(stdout);

  it("parses every row of the captured `pi --list-models` fixture", () => {
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  });

  it("uses `provider/model` as the id (what `--model` accepts) with the header's own labels as the description", () => {
    expect(models[0]).toEqual({
      id: "deepseek/deepseek-flash",
      name: "deepseek-flash",
      provider: "deepseek",
      description: "context 1M · max-out 384K · thinking yes · images yes",
    });
    expect(models[1]).toEqual({
      id: "deepseek/deepseek-v4-pro",
      name: "deepseek-v4-pro",
      provider: "deepseek",
      description: "context 1M · max-out 384K · thinking yes · images no",
    });
  });

  it("never turns the header itself into a model", () => {
    expect(models.some((m) => m.provider === "provider")).toBe(false);
    expect(models.map((m) => m.id)).not.toContain("provider/model");
    expect(models.some((m) => m.name === "model")).toBe(false);
  });

  it("takes the column labels from the header, so a differently shaped table still parses", () => {
    expect(
      parsePiModels(
        ["provider  model  context", "anthropic  claude-sonnet-5  200K", "openai  gpt-6-luna  400K"].join("\n"),
      ),
    ).toEqual([
      {
        id: "anthropic/claude-sonnet-5",
        name: "claude-sonnet-5",
        provider: "anthropic",
        description: "context 200K",
      },
      { id: "openai/gpt-6-luna", name: "gpt-6-luna", provider: "openai", description: "context 400K" },
    ]);
  });

  it("never turns the no-models message (and its login help) into models", () => {
    const noModels = [
      "No models available. Use /login to log into a provider via OAuth or API key. See:",
      "  /opt/pi/docs/providers.md",
      "  /opt/pi/docs/models.md",
      "",
    ].join("\n");
    expect(parsePiModels(noModels)).toEqual([]);
    // …nor the fuzzy-search empty result.
    expect(parsePiModels('No models matching "gpt-5"\n')).toEqual([]);
  });

  it("skips a row whose columns collapsed instead of misreading it as a model", () => {
    // An empty cell collapses the 2+-space separator run, so the row is not the
    // header's shape any more: under-reporting beats a wrong `provider/model` id.
    const collapsed = [
      "provider  model  context  max-out  thinking  images",
      "deepseek  deepseek-flash  1M        yes       no",
      "",
    ].join("\n");
    expect(parsePiModels(collapsed)).toEqual([]);
  });

  it("requires the header before any row can be a model", () => {
    expect(parsePiModels("deepseek  deepseek-flash  1M  384K  yes  yes\n")).toEqual([]);
  });

  it("drops empty and `-` cells from the description and dedupes repeated ids", () => {
    const parsed = parsePiModels(
      [
        "provider  model  context  max-out  thinking  images",
        "deepseek  deepseek-flash  1M  -  yes  -",
        "deepseek  deepseek-flash  1M  -  yes  -",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      {
        id: "deepseek/deepseek-flash",
        name: "deepseek-flash",
        provider: "deepseek",
        description: "context 1M · thinking yes",
      },
    ]);
  });

  it("returns [] for empty output", () => {
    expect(parsePiModels("")).toEqual([]);
    expect(parsePiModels("\n\n   \n")).toEqual([]);
  });
});
