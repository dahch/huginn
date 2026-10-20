import { describe, it, expect, vi } from "vitest";
import { conformanceCases } from "../../../src/engine/agent/conformance.js";
import {
  createCodexSdkPort,
  type CodexSdkAdapter,
  type CodexThreadHandle,
} from "../../../src/engine/agent/drivers/codex-sdk.js";

function fakeThread(overrides: Partial<CodexThreadHandle> = {}): CodexThreadHandle {
  return {
    currentId: () => "thread-1",
    async run(prompt: string) {
      return `codex says: ${prompt}`;
    },
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<CodexSdkAdapter> = {}): CodexSdkAdapter {
  return {
    async probe() {},
    async startThread() {
      return fakeThread();
    },
    ...overrides,
  };
}

describe("codex SDK driver", () => {
  const cases = conformanceCases({
    makePort: () => createCodexSdkPort(fakeAdapter()),
    makeFailingPort: () =>
      createCodexSdkPort(
        fakeAdapter({
          async startThread() {
            return fakeThread({
              async run() {
                throw new Error("app-server died");
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

describe("codex SDK driver specifics", () => {
  it("claims a real session history and nothing it cannot deliver", () => {
    const port = createCodexSdkPort(fakeAdapter());
    expect(port.id).toBe("codex");
    expect(port.capabilities.sessionHistory).toBe(true);
    // The SDK exposes no abort and no catalog; both say so.
    expect(port.capabilities.interrupt).toBe(false);
    expect(port.capabilities.modelCatalog).toBe("none");
    expect(port.capabilities.permissions).toBe("none");
  });

  it("carries the thread's answer and hands the model to the SDK", async () => {
    const startThread = vi.fn(async () => fakeThread());
    const port = createCodexSdkPort(fakeAdapter({ startThread }));
    const session = await port.createSession({ title: "t", model: "gpt-5.1-codex" });
    expect(startThread).toHaveBeenCalledWith({ model: "gpt-5.1-codex" });
    const result = await session.prompt({ text: "hola" });
    expect(result.text).toBe("codex says: hola");
    await session.close();
  });

  it("gives every session a handle before the provider has a thread id", async () => {
    const port = createCodexSdkPort(fakeAdapter({ async startThread() { return fakeThread({ currentId: () => null }); } }));
    const a = await port.createSession({ title: "a" });
    const b = await port.createSession({ title: "b" });
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThan(0);
  });

  it("reports a missing SDK or CLI as unavailable with the reason", async () => {
    const port = createCodexSdkPort(
      fakeAdapter({
        async probe() {
          throw new Error("codex executable not found");
        },
      }),
    );
    const availability = await port.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("not found");
  });

  it("explains that the catalog is absent instead of inventing one", async () => {
    const catalog = await createCodexSdkPort(fakeAdapter()).listModels();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toContain("no model catalog");
  });

  it("survives interrupt because it never claims it", async () => {
    const port = createCodexSdkPort(fakeAdapter());
    const session = await port.createSession({ title: "t" });
    await expect(session.interrupt()).resolves.toBeUndefined();
    await session.close();
  });
});
