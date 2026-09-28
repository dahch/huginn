import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RunConfig } from "../../../src/config.js";

const baseConfig: RunConfig = {
  projectPath: "/tmp/huginn-validate-models",
  planPath: "/tmp/huginn-validate-models/plan.md",
  specPath: "/tmp/huginn-validate-models/SPEC.md",
  adrPath: "/tmp/huginn-validate-models/ADR.md",
  thinker: "anthropic/claude-sonnet-5",
  executor: "opencode/gpt-5.1-codex",
  mode: "auto",
  permissions: "auto",
  maxRetries: 3,
  tui: false,
  port: 0,
  serverTimeoutMs: 1000,
  phaseTimeoutMs: 1000,
  ignorePlanChanges: false,
  sandbox: false,
};

function clientReturning(response: unknown): OpencodeClient {
  return {
    config: { providers: async () => response },
  } as unknown as OpencodeClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("REQ-27 · validateModels reads the correct provider field (AC-27.6)", () => {
  it("does not warn when every provider is in config.providers().providers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { validateModels } = await import("../../../src/cli.js");

    await validateModels(
      clientReturning({ providers: [{ id: "anthropic" }, { id: "opencode" }], default: {} }),
      { ...baseConfig },
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns only for the provider that is genuinely absent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { validateModels } = await import("../../../src/cli.js");

    await validateModels(clientReturning({ providers: [{ id: "anthropic" }], default: {} }), {
      ...baseConfig,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain('provider "opencode"');
    expect(message).toContain("executor");
    expect(message).not.toContain('provider "anthropic"');
  });

  it("tolerates a response without a providers field (warns instead of crashing)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { validateModels } = await import("../../../src/cli.js");

    await validateModels(clientReturning({ default: {} }), { ...baseConfig });

    // Both roles are unknown → two warnings, and the call itself must not throw.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("warns once about validation being impossible when the request throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { validateModels } = await import("../../../src/cli.js");

    const failing = {
      config: {
        providers: async () => {
          throw new Error("daemon down");
        },
      },
    } as unknown as OpencodeClient;

    await validateModels(failing, { ...baseConfig });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("could not validate models");
  });
});
