import { describe, it, expect, vi } from "vitest";
import { conformanceCases } from "../../../src/engine/agent/conformance.js";
import {
  createPiSdkPort,
  type PiSdkAdapter,
  type PiSessionHandle,
} from "../../../src/engine/agent/drivers/pi-sdk.js";

function fakeHandle(overrides: Partial<PiSessionHandle> = {}): PiSessionHandle {
  return {
    id: "pi-session-1",
    async prompt(text: string) {
      return `pi says: ${text}`;
    },
    async setModel() {
      /* recorded by the test when it matters */
    },
    async interrupt() {
      /* recorded by the test when it matters */
    },
    async dispose() {
      /* recorded by the test when it matters */
    },
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<PiSdkAdapter> = {}): PiSdkAdapter {
  return {
    async createSession() {
      return fakeHandle();
    },
    async listModels() {
      return [
        { id: "anthropic/claude-opus-4-5", name: "claude-opus-4-5", provider: "anthropic" },
        { id: "openai/gpt-5.1-codex", name: "gpt-5.1-codex", provider: "openai" },
      ];
    },
    ...overrides,
  };
}

describe("pi SDK driver", () => {
  const cases = conformanceCases({
    makePort: () => createPiSdkPort(fakeAdapter()),
    makeFailingPort: () =>
      createPiSdkPort(
        fakeAdapter({
          async createSession() {
            return fakeHandle({
              async prompt() {
                throw new Error("provider exploded");
              },
            });
          },
        }),
      ),
  });
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});

describe("pi SDK driver specifics", () => {
  it("declares what an in-process driver must: no process bridge, real history", () => {
    const port = createPiSdkPort(fakeAdapter());
    expect(port.id).toBe("pi");
    expect(port.capabilities.inProcess).toBe(true);
    expect(port.capabilities.sessionHistory).toBe(true);
    // Not wired yet: claiming them would make the UI wait for events that never come.
    expect(port.capabilities.streaming).toBe(false);
    expect(port.capabilities.permissions).toBe("none");
  });

  it("carries the adapter's text through the prompt result", async () => {
    const port = createPiSdkPort(fakeAdapter());
    const session = await port.createSession({ title: "t" });
    const result = await session.prompt({ text: "hola" });
    expect(result.text).toBe("pi says: hola");
    expect(result.messageId).toContain("pi-session-1");
    await session.close();
  });

  it("passes the working directory and model to the SDK adapter", async () => {
    const createSession = vi.fn(async () => fakeHandle());
    const port = createPiSdkPort(fakeAdapter({ createSession }));
    const session = await port.createSession({
      title: "t",
      directory: "/tmp/project",
      model: "anthropic/claude-opus-4-5",
    });
    expect(createSession).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      model: "anthropic/claude-opus-4-5",
    });
    await session.close();
  });

  it("aborts and disposes the SDK handle", async () => {
    const interrupt = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const port = createPiSdkPort(
      fakeAdapter({
        async createSession() {
          return fakeHandle({ interrupt, dispose });
        },
      }),
    );
    const session = await port.createSession({ title: "t" });
    await session.interrupt("stop");
    await session.close();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports an unloadable SDK as unavailable with the reason", async () => {
    const port = createPiSdkPort(
      fakeAdapter({
        async listModels() {
          throw new Error("cannot find module @earendil-works/pi-coding-agent");
        },
      }),
    );
    const availability = await port.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("could not be loaded");
  });

  it("explains an empty catalog instead of pretending it is empty on purpose", async () => {
    const port = createPiSdkPort(
      fakeAdapter({
        async listModels() {
          return [];
        },
      }),
    );
    const catalog = await port.listModels();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toBeTruthy();
    expect((await port.isAvailable()).ok).toBe(false);
  });

  it("only accepts provider/model references", () => {
    const port = createPiSdkPort(fakeAdapter());
    expect(port.resolveModel("anthropic/claude-opus-4-5").ok).toBe(true);
    expect(port.resolveModel("claude-opus-4-5").ok).toBe(false);
    expect(port.resolveModel("/claude").ok).toBe(false);
    expect(port.resolveModel("anthropic/").ok).toBe(false);
  });
});

describe("pi driver · the model the engine asks for is the model that runs", () => {
  it("switches the session model on every prompt that names one", async () => {
    const setModel = vi.fn(async () => {});
    const port = createPiSdkPort(
      fakeAdapter({ async createSession() { return fakeHandle({ setModel }); } }),
    );
    const session = await port.createSession({ title: "t" });
    await session.prompt({ text: "audit", model: "anthropic/claude-opus-4-5" });
    await session.prompt({ text: "execute", model: "deepseek/deepseek-v4-pro" });
    expect(setModel.mock.calls.map((c) => c[0])).toEqual([
      "anthropic/claude-opus-4-5",
      "deepseek/deepseek-v4-pro",
    ]);
  });

  it("leaves pi's own setting alone when the prompt names no model", async () => {
    const setModel = vi.fn(async () => {});
    const port = createPiSdkPort(
      fakeAdapter({ async createSession() { return fakeHandle({ setModel }); } }),
    );
    const session = await port.createSession({ title: "t" });
    await session.prompt({ text: "hola" });
    expect(setModel).not.toHaveBeenCalled();
  });

  it("fails loudly instead of running the wrong model when it cannot switch", async () => {
    const handle = fakeHandle();
    delete handle.setModel;
    const port = createPiSdkPort(fakeAdapter({ async createSession() { return handle; } }));
    const session = await port.createSession({ title: "t" });
    await expect(session.prompt({ text: "x", model: "deepseek/deepseek-v4-pro" })).rejects.toThrow(
      /cannot switch models per prompt/,
    );
    expect((await Promise.resolve(true))).toBe(true);
  });
});
