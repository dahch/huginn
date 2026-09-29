import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseMimoModels } from "../../../src/engine/agent/adapters/mimo.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/mimo-models.txt", import.meta.url));
const stdout = readFileSync(fixturePath, "utf8");

describe("REQ-27 · MiMo Code catalog parser (AC-27.4)", () => {
  const models = parseMimoModels(stdout);

  it("parses every row of the captured `mimo models` fixture", () => {
    // 9 lines, one `<provider>/<model> — <description>` per line (MiMo Code 0.1.15).
    expect(models).toHaveLength(9);
    expect(new Set(models.map((m) => m.provider))).toEqual(
      new Set(["deepseek", "mimo", "xiaomi"]),
    );
  });

  it("maps each row to its id, short name, provider and window description", () => {
    expect(models[0]).toEqual({
      id: "deepseek/deepseek-flash",
      name: "deepseek-flash",
      provider: "deepseek",
      description: "window 1M, compacts at 900K",
    });
    // The id is exactly what `--model` accepts, dashes and all.
    expect(models.find((m) => m.id === "xiaomi/mimo-v2.6-pro-ultraspeed")).toEqual({
      id: "xiaomi/mimo-v2.6-pro-ultraspeed",
      name: "mimo-v2.6-pro-ultraspeed",
      provider: "xiaomi",
      description: "window 1.05M, compacts at 944K",
    });
    // The EM DASH separator never leaks into a description.
    expect(models.every((m) => !m.description?.includes("—"))).toBe(true);
  });

  it("keeps the ids verbatim (they are the `--model` references) and drops nothing", () => {
    expect(models.map((m) => m.id)).toEqual([
      "deepseek/deepseek-flash",
      "deepseek/deepseek-v4-pro",
      "mimo/mimo-auto",
      "xiaomi/mimo-v2.5",
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5-pro-ultraspeed",
      "xiaomi/mimo-v2.6-flash",
      "xiaomi/mimo-v2.6-pro",
      "xiaomi/mimo-v2.6-pro-ultraspeed",
    ]);
  });

  it("ignores the JSON blocks `--verbose` interleaves (a real, not hypothetical, mode)", () => {
    // Synthetic, because the real verbose capture is 550 lines of embedded
    // catalog; the shape is the one the CLI prints (see the comment on
    // `MIMO_MODEL_ROW`): the summary line per model, then that model's JSON.
    const verbose = [
      "deepseek/deepseek-flash — window 1M, compacts at 900K",
      "{",
      '  "id": "deepseek-flash",',
      '  "providerID": "deepseek",',
      '  "name": "DeepSeek V4.1 Flash",',
      '  "api": { "url": "https://api.deepseek.com", "npm": "@ai-sdk/openai-compatible" },',
      '  "limit": { "context": 1000000, "output": 393216 }',
      "}",
      "xiaomi/mimo-v2.6-pro — window 1.05M, compacts at 944K",
      "{",
      '  "id": "mimo-v2.6-pro",',
      '  "providerID": "xiaomi"',
      "}",
    ].join("\n");

    expect(parseMimoModels(verbose)).toEqual([
      {
        id: "deepseek/deepseek-flash",
        name: "deepseek-flash",
        provider: "deepseek",
        description: "window 1M, compacts at 900K",
      },
      {
        id: "xiaomi/mimo-v2.6-pro",
        name: "mimo-v2.6-pro",
        provider: "xiaomi",
        description: "window 1.05M, compacts at 944K",
      },
    ]);
  });

  it("never turns a preamble, footer or ANSI noise into a model", () => {
    const noisy = parseMimoModels(
      `\u001b[32mFetching models…\u001b[0m\n${stdout}\n9 models\n`,
    );
    expect(noisy).toEqual(models);
    expect(noisy.every((m) => m.id.includes("/") && !m.id.includes("\u001b"))).toBe(true);
  });

  it("returns [] for empty output and dedupes repeated ids", () => {
    expect(parseMimoModels("")).toEqual([]);
    expect(parseMimoModels("no models configured\n")).toEqual([]);
    expect(
      parseMimoModels(
        "mimo/mimo-auto — window 1M, compacts at 900K\nmimo/mimo-auto — window 1M, compacts at 900K\n",
      ),
    ).toEqual([
      {
        id: "mimo/mimo-auto",
        name: "mimo-auto",
        provider: "mimo",
        description: "window 1M, compacts at 900K",
      },
    ]);
  });
});
