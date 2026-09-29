import { describe, expect, it, vi } from "vitest";
import {
  catalogReasonFromError,
  discoverModelCatalog,
  sanitizeCatalogReason,
} from "../../../src/engine/agent/modelCatalog.js";
import type { IAgentRuntime, ModelCatalog, ModelInfo } from "../../../src/engine/agent/types.js";

function runtimeWith(partial: Partial<IAgentRuntime>): IAgentRuntime {
  return {
    id: "opencode",
    name: "stub",
    isAvailable: async () => false,
    getAvailableModels: async () => [],
    getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    createSession: async () => ({
      id: "stub-session",
      prompt: async () => ({ messageId: "stub", text: "" }),
      abort: async () => {},
    }),
    ...partial,
  };
}

const MODELS: ModelInfo[] = [
  { id: "acme/alpha", name: "Alpha", provider: "acme" },
  { id: "acme/beta", name: "Beta", provider: "acme" },
];

describe("discoverModelCatalog — shared & safe by construction (REV-503/REV-504/REV-508)", () => {
  it("prefers getModelCatalog over getAvailableModels", async () => {
    const getAvailableModels = vi.fn(async () => MODELS);
    const catalog = await discoverModelCatalog(
      runtimeWith({
        getModelCatalog: async () => ({ models: MODELS, reason: "carried through" }),
        getAvailableModels,
      }),
    );

    expect(catalog).toEqual({ models: MODELS, reason: "carried through" });
    expect(getAvailableModels).not.toHaveBeenCalled();
  });

  it("falls back to getAvailableModels when the richer accessor is absent", async () => {
    const runtime = runtimeWith({ getAvailableModels: async () => MODELS });
    expect(runtime.getModelCatalog).toBeUndefined();

    expect(await discoverModelCatalog(runtime)).toEqual({ models: MODELS });
  });

  it("absorbs a synchronous throw into a sanitized reason", async () => {
    const catalog = await discoverModelCatalog(
      runtimeWith({
        getModelCatalog: () => {
          throw new Error("sync boom\u0007tail");
        },
      }),
    );

    expect(catalog.models).toEqual([]);
    // the BEL is stripped at the boundary (SEC-001)
    expect(catalog.reason).toBe("sync boomtail");
  });

  it("absorbs an asynchronous rejection into a sanitized reason", async () => {
    const catalog = await discoverModelCatalog(
      runtimeWith({
        getModelCatalog: async () => {
          throw new Error("async \u001b[31mboom");
        },
      }),
    );

    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toBe("async boom");
  });

  it("normalizes a malformed catalog to an empty model list", async () => {
    const catalog = await discoverModelCatalog(
      runtimeWith({
        getModelCatalog: async () =>
          ({ models: null, reason: "  " }) as unknown as ModelCatalog,
      }),
    );

    expect(catalog).toEqual({ models: [] });
  });

  it("drops non-string and blank reasons", () => {
    expect(sanitizeCatalogReason("   ")).toBeUndefined();
    expect(sanitizeCatalogReason(42)).toBeUndefined();
    expect(sanitizeCatalogReason(undefined)).toBeUndefined();
    expect(sanitizeCatalogReason("  keep  ")).toBe("keep");
  });

  it("always yields a non-empty reason from an error", () => {
    expect(catalogReasonFromError(new Error(""))).toBe("model discovery failed");
    expect(catalogReasonFromError("plain")).toBe("plain");
  });
});
