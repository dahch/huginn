import { describe, it, expect, vi } from "vitest";
import { toLegacyRuntime } from "../../../src/engine/agent/legacy-bridge.js";
import type {
  RuntimeCapabilities,
  RuntimePort,
  RuntimeSession,
} from "../../../src/engine/agent/port.js";

const CAPS: RuntimeCapabilities = {
  inProcess: true,
  structuredEvents: false,
  streaming: false,
  permissions: "none",
  sessionHistory: true,
  sessionResume: false,
  modelCatalog: "dynamic",
  structuredOutput: false,
  usageCost: false,
  mcpListing: false,
  interrupt: true,
};

function fakePort(overrides: Partial<RuntimePort> = {}): RuntimePort {
  const session: RuntimeSession = {
    id: "native-1",
    resumable: false,
    async prompt(request) {
      return { messageId: "m1", text: `echo: ${request.text}` };
    },
    async interrupt() {},
    async close() {},
  };
  return {
    id: "pi",
    name: "Pi (in-process)",
    capabilities: CAPS,
    async isAvailable() {
      return { ok: true };
    },
    async listModels() {
      return { models: [{ id: "anthropic/x", name: "x", provider: "anthropic" }] };
    },
    resolveModel(reference) {
      return { ok: true, model: reference };
    },
    async createSession() {
      return session;
    },
    ...overrides,
  };
}

describe("toLegacyRuntime", () => {
  it("mirrors the capabilities the legacy interface can express", () => {
    const runtime = toLegacyRuntime(fakePort());
    expect(runtime.id).toBe("pi");
    expect(runtime.sessionHistory).toBe(true);
    // No streaming capability claimed → no streaming advertised to the TUI.
    expect(runtime.streamsOutput).toBe(false);
  });

  it("forwards availability and the model catalog", async () => {
    const runtime = toLegacyRuntime(
      fakePort({
        async isAvailable() {
          return { ok: false, reason: "no auth" };
        },
      }),
    );
    expect(await runtime.isAvailable()).toBe(false);
    expect((await runtime.getModelCatalog!()).models).toHaveLength(1);
  });

  it("passes the prompt and its options through to the port session", async () => {
    const prompt = vi.fn(async () => ({ messageId: "m", text: "ok" }));
    const createSession = vi.fn(async () => ({
      id: "s1",
      resumable: false,
      prompt,
      async interrupt() {},
      async close() {},
    }));
    const runtime = toLegacyRuntime(fakePort({ createSession }));
    const session = await runtime.createSession({ title: "t", directory: "/tmp/x" });
    expect(createSession).toHaveBeenCalledWith({
      title: "t",
      directory: "/tmp/x",
      model: undefined,
      agent: undefined,
    });

    const result = await session.prompt("hola", {
      model: "anthropic/x",
      agent: "build",
      timeoutMs: 1234,
      directory: "/tmp/y",
    });
    expect(prompt).toHaveBeenCalledWith({
      text: "hola",
      model: "anthropic/x",
      agent: "build",
      timeoutMs: 1234,
      directory: "/tmp/y",
    });
    expect(result).toEqual({ messageId: "m", text: "ok" });
  });

  it("interrupts and releases the native handle on abort", async () => {
    const interrupt = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const runtime = toLegacyRuntime(
      fakePort({
        async createSession() {
          return { id: "s1", resumable: false, async prompt() { return { messageId: "m", text: "" }; }, interrupt, close };
        },
      }),
    );
    const session = await runtime.createSession({ title: "t" });
    await session.abort();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never reports MCP health it did not verify", async () => {
    const status = await toLegacyRuntime(fakePort()).getMcpStatus();
    expect(status.healthy).toBe(false);
    expect(status.unverified).toBe(true);
  });
});
