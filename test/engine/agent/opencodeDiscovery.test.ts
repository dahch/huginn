import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { OpencodeRuntimeAdapter, parseOpencodeModels } from "../../../src/engine/agent/adapters/opencode.js";

const providerListFixture = fileURLToPath(
  new URL("../../fixtures/opencode-provider-list.json", import.meta.url),
);
const opencodeModelsFixture = fileURLToPath(
  new URL("../../fixtures/opencode-models.txt", import.meta.url),
);

const CONNECTED_PROVIDER_COUNT = 10;
const CONNECTED_MODEL_COUNT = 53;

interface ProviderListPayload {
  all: Array<{ id: string; models?: Record<string, unknown> }>;
  connected: string[];
}

const payload = JSON.parse(readFileSync(providerListFixture, "utf8")) as ProviderListPayload;

describe("REQ-27 · opencode discovery against a real GET /provider payload (AC-27.1)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/provider")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("returns only models from providers in the `connected` set", async () => {
    const adapter = new OpencodeRuntimeAdapter({ baseUrl });
    const models = await adapter.getAvailableModels();

    expect(models).toHaveLength(CONNECTED_MODEL_COUNT);
    expect(payload.connected).toHaveLength(CONNECTED_PROVIDER_COUNT);

    const connected = new Set(payload.connected);
    for (const model of models) {
      const provider = model.id.slice(0, model.id.indexOf("/"));
      expect(connected.has(provider)).toBe(true);
    }
  });

  it("never offers models from unconnected catalog-only providers", async () => {
    const adapter = new OpencodeRuntimeAdapter({ baseUrl });
    const models = await adapter.getAvailableModels();
    const ids = models.map((m) => m.id);

    expect(ids.some((id) => id.startsWith("deepinfra/"))).toBe(false);
    expect(ids.some((id) => id.startsWith("perplexity-agent/"))).toBe(false);
    expect(ids.some((id) => id.startsWith("bailing/"))).toBe(false);

    // …while a genuinely connected provider is offered with its real name.
    const deepseekPro = models.find((m) => m.id === "deepseek/deepseek-v4-pro");
    expect(deepseekPro).toBeDefined();
    expect(deepseekPro?.name).toBe("DeepSeek V4 Pro");
    // REV-004: the provider id, identical to the `opencode models` CLI path, so
    // badges/filtering do not change with the discovery path.
    expect(deepseekPro?.provider).toBe("deepseek");
  });

  it("reports the provider id consistently with the CLI fallback (REV-004)", async () => {
    const adapter = new OpencodeRuntimeAdapter({ baseUrl });
    const viaSdk = await adapter.getAvailableModels();
    const viaCli = parseOpencodeModels(readFileSync(opencodeModelsFixture, "utf8"));

    const sdkProviders = new Set(viaSdk.map((m) => m.provider));
    const cliProviders = new Set(viaCli.map((m) => m.provider));
    expect(sdkProviders.size).toBeGreaterThan(0);

    // The SDK path and the CLI path must agree on the provider *ids* — no
    // display names leak in from one path only.
    for (const provider of sdkProviders) {
      expect(provider).not.toMatch(/\s/);
      expect(cliProviders.has(provider)).toBe(true);
    }
  });

  it("ignores a provider absent from the payload entirely", async () => {
    const adapter = new OpencodeRuntimeAdapter({ baseUrl });
    const ids = (await adapter.getAvailableModels()).map((m) => m.id);
    expect(ids.some((id) => id.startsWith("custom-provider/"))).toBe(false);
  });
});

describe("REQ-27 · opencode CLI fallback parser (AC-27.2)", () => {
  it("parses the captured `opencode models` fixture (581 ids)", () => {
    const stdout = readFileSync(opencodeModelsFixture, "utf8");
    const models = parseOpencodeModels(stdout);

    expect(models).toHaveLength(581);
    expect(models.some((m) => m.id === "opencode/claude-sonnet-5")).toBe(true);
  });

  it("keeps multi-slash ids intact and derives provider/short name", () => {
    const models = parseOpencodeModels(
      [
        "anthropic/claude-sonnet-5",
        "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
        "",
        "   ",
        "not-a-model-line",
        "/leading-slash",
        "trailing-slash/",
        "anthropic/claude-sonnet-5",
      ].join("\n"),
    );

    expect(models).toEqual([
      { id: "anthropic/claude-sonnet-5", name: "claude-sonnet-5", provider: "anthropic" },
      {
        id: "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
        name: "deepseek-v4p1-flash",
        provider: "fireworks-ai",
      },
    ]);
  });

  it("strips ANSI noise before parsing", () => {
    const models = parseOpencodeModels("\u001b[32manthropic/claude-sonnet-5\u001b[0m\n");
    expect(models).toEqual([
      { id: "anthropic/claude-sonnet-5", name: "claude-sonnet-5", provider: "anthropic" },
    ]);
  });

  it("returns [] when the CLI is missing, fails or prints nothing (never fakes)", async () => {
    const failingClient = {
      provider: { list: async () => Promise.reject(new Error("daemon down")) },
    } as unknown as OpencodeClient;

    const missingBinary = new OpencodeRuntimeAdapter({
      client: failingClient,
      modelsCommand: "__huginn_missing_opencode__",
    });
    expect(await missingBinary.getAvailableModels()).toEqual([]);

    const emptyOutput = new OpencodeRuntimeAdapter({
      client: failingClient,
      modelsCommand: process.execPath,
    });
    // `node models` exits non-zero / prints nothing usable → empty catalog.
    expect(await emptyOutput.getAvailableModels()).toEqual([]);
  });
});
