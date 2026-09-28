import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCommandCodeModels } from "../../../src/engine/agent/adapters/commandcode.js";

const fixturePath = fileURLToPath(
  new URL("../../fixtures/commandcode-list-models.txt", import.meta.url),
);

describe("REQ-27 · Command Code catalog parser (AC-27.3)", () => {
  const stdout = readFileSync(fixturePath, "utf8");
  const models = parseCommandCodeModels(stdout);

  it("parses every model row of the captured `commandcode --list-models` fixture", () => {
    expect(models).toHaveLength(82);
  });

  it("preserves full `provider/model` ids with their descriptions", () => {
    const deepseek = models.find((m) => m.id === "deepseek/deepseek-v4-pro");
    expect(deepseek).toEqual({
      id: "deepseek/deepseek-v4-pro",
      name: "deepseek-v4-pro",
      provider: "deepseek",
      description: "hybrid-attention long-context reasoning",
    });
  });

  it("keeps bare ids bare and attributes them to their group heading", () => {
    const bare = models.find((m) => m.id === "claude-sonnet-5");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("claude-sonnet-5");
    expect(bare?.provider).toBe("Anthropic");
    expect(bare?.description).toBe("best combo of speed & intelligence (recommended)");

    const gpt = models.find((m) => m.id === "gpt-5.4-mini");
    expect(gpt?.provider).toBe("OpenAI");
  });

  it("ignores the header, blank lines and group headings themselves", () => {
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain("Available");
    expect(ids).not.toContain("Open");
    expect(ids).not.toContain("Stealth");
    expect(ids).not.toContain("Anthropic");
    expect(ids).not.toContain("Docs:");
    expect(ids.every((id) => !id.includes(" "))).toBe(true);
  });

  it("stops before the trailing help/docs footer", () => {
    const ids = models.map((m) => m.id);
    const descriptions = models.map((m) => m.description ?? "").join("\n");

    expect(ids).not.toContain("cmd");
    expect(ids).not.toContain("typesafe/jev");
    expect(descriptions).not.toContain("Pass the full id");
    expect(descriptions).not.toContain("commandcode.ai/docs");
    expect(descriptions).not.toContain("headless only");
  });

  it("keeps every real group heading working (REV-006)", () => {
    // Bare ids under a heading are attributed to that heading…
    const sakana = models.find((m) => m.id === "sakana/fugu-ultra");
    expect(sakana?.provider).toBe("sakana");
    // …and the fixture's headings themselves never became models.
    const ids = models.map((m) => m.id);
    for (const heading of ["Open Source", "Stealth", "Anthropic", "OpenAI", "Google", "Sakana", "Meta", "xAI"]) {
      expect(ids).not.toContain(heading);
    }
    expect(models.some((m) => m.provider === "Anthropic")).toBe(true);
    expect(models.some((m) => m.provider === "OpenAI")).toBe(true);
  });

  it("does not swallow a malformed single-space model row as a heading (REV-006)", () => {
    const parsed = parseCommandCodeModels(
      [
        "Available models  ·  2 models",
        "",
        "Open Source",
        "",
        // Malformed: single space instead of the expected 2+ space gap.
        "deepseek/deepseek-v4-pro hybrid-attention long-context reasoning",
        "claude-sonnet-5                       best combo of speed & intelligence",
      ].join("\n"),
    );

    // Only the well-formed row is parsed…
    expect(parsed.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
    // …and the malformed line did not reset the group, so the bare id keeps the
    // real heading as its provider instead of the malformed text.
    expect(parsed[0].provider).toBe("Open Source");
    expect(parsed.some((m) => m.provider.includes("deepseek/deepseek-v4-pro"))).toBe(false);
    expect(parsed.some((m) => m.id.includes("single"))).toBe(false);
  });

  it("is tolerant of a footer-less / truncated listing", () => {
    const truncated = parseCommandCodeModels(
      [
        "Available models  ·  2 models",
        "",
        "Open Source",
        "",
        "deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning",
        "moonshotai/kimi-k3                     long-horizon coding",
      ].join("\n"),
    );
    expect(truncated.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-pro", "moonshotai/kimi-k3"]);
    expect(truncated.every((m) => m.provider === "deepseek" || m.provider === "moonshotai")).toBe(true);
  });

  it("returns [] for empty or garbage output", () => {
    expect(parseCommandCodeModels("")).toEqual([]);
    expect(parseCommandCodeModels("\n\n   \n")).toEqual([]);
  });
});
