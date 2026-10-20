import { describe, it, expect } from "vitest";
import { AGENT_TARGETS, type AgentTarget } from "../../../src/agents/integrator.js";
import { conformanceCases } from "../../../src/engine/agent/conformance.js";
import { toRuntimePort } from "../../../src/engine/agent/legacy-bridge.js";
import type {
  IAgentRuntime,
  IAgentSession,
  ModelCatalog,
  ModelInfo,
  PromptResult,
} from "../../../src/engine/agent/types.js";

interface FakeOptions {
  sessionHistory?: boolean;
  streamsOutput?: boolean;
  available?: boolean;
  failPrompt?: boolean;
  catalogThrows?: boolean;
  models?: ModelInfo[];
}

/**
 * A legacy adapter with the shape `IAgentRuntime` requires, so the bridge and
 * the conformance suite can be exercised for every registered target without a
 * CLI on PATH.
 */
function fakeRuntime(id: AgentTarget, options: FakeOptions = {}): IAgentRuntime {
  const models = options.models ?? [];
  const session: IAgentSession = {
    id: `${id}-session`,
    async prompt(text: string): Promise<PromptResult> {
      if (options.failPrompt) throw new Error("provider exploded");
      return { messageId: `${id}-message`, text: `echo: ${text}` };
    },
    async abort() {
      /* nothing to abort in the fake */
    },
  };

  const runtime: IAgentRuntime = {
    id,
    name: id,
    sessionHistory: options.sessionHistory,
    streamsOutput: options.streamsOutput,
    async isAvailable() {
      return options.available ?? true;
    },
    async getAvailableModels() {
      return models;
    },
    async getModelCatalog(): Promise<ModelCatalog> {
      if (options.catalogThrows) throw new Error("discovery blew up");
      return { models };
    },
    async getMcpStatus() {
      return { servers: [], totalTools: 0, healthy: true };
    },
    async createSession() {
      return session;
    },
  };
  return runtime;
}

describe("runtime port conformance (legacy bridge)", () => {
  for (const target of AGENT_TARGETS) {
    describe(target, () => {
      const cases = conformanceCases({
        makePort: () => toRuntimePort(fakeRuntime(target)),
        makeFailingPort: () => toRuntimePort(fakeRuntime(target, { failPrompt: true })),
      });
      for (const testCase of cases) {
        it(testCase.name, async () => {
          await testCase.run();
        });
      }
    });
  }
});

describe("legacy bridge parity with IAgentRuntime", () => {
  it("mirrors the adapter's own capability booleans", () => {
    const streaming = toRuntimePort(
      fakeRuntime("opencode", { sessionHistory: true, streamsOutput: true }),
    );
    expect(streaming.capabilities.sessionHistory).toBe(true);
    expect(streaming.capabilities.streaming).toBe(true);
    expect(streaming.capabilities.structuredEvents).toBe(true);
    expect(streaming.capabilities.inProcess).toBe(false);
    // opencode's permission handling lives in the engine, not in the port.
    expect(streaming.capabilities.permissions).toBe("none");

    const oneShot = toRuntimePort(fakeRuntime("codex"));
    expect(oneShot.capabilities.sessionHistory).toBe(false);
    expect(oneShot.capabilities.streaming).toBe(false);
    expect(oneShot.capabilities.structuredEvents).toBe(false);
  });

  it("returns the legacy prompt result unchanged", async () => {
    const port = toRuntimePort(fakeRuntime("claude"));
    const session = await port.createSession({ title: "parity" });
    const result = await session.prompt({ text: "hola" });
    expect(result).toEqual({ messageId: "claude-message", text: "echo: hola" });
    expect(session.id).toBe("claude-session");
    expect(session.resumable).toBe(false);
  });

  it("explains an unavailable driver instead of throwing", async () => {
    const port = toRuntimePort(fakeRuntime("claude", { available: false }));
    const availability = await port.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("claude");
  });

  it("turns a failing catalog into an explained empty list", async () => {
    const port = toRuntimePort(fakeRuntime("qwen", { catalogThrows: true }));
    const catalog = await port.listModels();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toContain("discovery blew up");
  });

  it("keeps the provider/model reference intact and rejects an empty one", () => {
    const port = toRuntimePort(fakeRuntime("pi"));
    expect(port.resolveModel("anthropic/claude-opus-4-5")).toEqual({
      ok: true,
      model: "anthropic/claude-opus-4-5",
    });
    const rejected = port.resolveModel("  ");
    expect(rejected.ok).toBe(false);
  });
});
