import { describe, it, expect, vi } from "vitest";
import { conformanceCases } from "../../../src/engine/agent/conformance.js";
import {
  createClaudeSdkPort,
  createDefaultClaudeAdapter,
  type ClaudeSdkAdapter,
  type ClaudeTurnHandle,
} from "../../../src/engine/agent/drivers/claude-sdk.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

function fakeTurn(overrides: Partial<ClaudeTurnHandle> = {}): ClaudeTurnHandle {
  return {
    async run(prompt: string) {
      return `claude says: ${prompt}`;
    },
    abort() {},
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<ClaudeSdkAdapter> = {}): ClaudeSdkAdapter {
  return {
    async probe() {},
    async startTurn() {
      return fakeTurn();
    },
    ...overrides,
  };
}

describe("claude SDK driver", () => {
  const cases = conformanceCases({
    makePort: () => createClaudeSdkPort(fakeAdapter()),
    makeFailingPort: () =>
      createClaudeSdkPort(
        fakeAdapter({
          async startTurn() {
            return fakeTurn({
              async run() {
                throw new Error("claude binary exploded");
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

describe("claude SDK driver specifics", () => {
  it("claims an interrupt it can honour and nothing else", () => {
    const port = createClaudeSdkPort(fakeAdapter());
    expect(port.id).toBe("claude");
    expect(port.capabilities.sessionHistory).toBe(true);
    expect(port.capabilities.interrupt).toBe(true);
    // The non-OSS SDK is optional and external; it advertises no catalog, no
    // approvals (canUseTool is not wired) and no resume yet.
    expect(port.capabilities.modelCatalog).toBe("none");
    expect(port.capabilities.permissions).toBe("none");
    expect(port.capabilities.sessionResume).toBe(false);
    expect(port.capabilities.inProcess).toBe(false);
  });

  it("passes the working directory and model to the SDK", async () => {
    const startTurn = vi.fn(async () => fakeTurn());
    const port = createClaudeSdkPort(fakeAdapter({ startTurn }));
    const session = await port.createSession({ title: "t", directory: "/tmp/p", model: "claude-opus-4-5" });
    expect(startTurn).toHaveBeenCalledWith({
      cwd: "/tmp/p",
      model: "claude-opus-4-5",
      permissions: undefined,
    });
    await session.close();
  });

  it("carries the turn's answer through", async () => {
    const port = createClaudeSdkPort(fakeAdapter());
    const session = await port.createSession({ title: "t" });
    const result = await session.prompt({ text: "hola" });
    expect(result.text).toBe("claude says: hola");
    await session.close();
  });

  it("aborts the running turn on interrupt", async () => {
    const abort = vi.fn();
    const port = createClaudeSdkPort(
      fakeAdapter({ async startTurn() { return fakeTurn({ abort }); } }),
    );
    const session = await port.createSession({ title: "t" });
    await session.interrupt();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("honours the model and timeout the engine asks for on each turn", async () => {
    const run = vi.fn(async (_prompt: string, _options?: { model?: string; timeoutMs?: number }) => "ok");
    const port = createClaudeSdkPort(
      fakeAdapter({ async startTurn() { return fakeTurn({ run }); } }),
    );
    const session = await port.createSession({ title: "t" });
    await session.prompt({ text: "a", model: "claude-opus-4-5", timeoutMs: 1234 });
    expect(run).toHaveBeenCalledWith("a", { model: "claude-opus-4-5", timeoutMs: 1234 });
  });

  it("passes the run's permission mode to the SDK", async () => {
    const startTurn = vi.fn(async () => fakeTurn());
    const port = createClaudeSdkPort(fakeAdapter({ startTurn }));
    await port.createSession({ title: "t", permissions: "auto" });
    expect(startTurn).toHaveBeenCalledWith({
      cwd: undefined,
      model: undefined,
      permissions: "auto",
    });
  });

  it("resumes the captured session and strips the anthropic/ model prefix", async () => {
    queryMock.mockReset();
    queryMock.mockImplementation(async function* () {
      yield { type: "result", subtype: "success", result: "first", session_id: "sess-1" };
    });
    const port = createClaudeSdkPort(createDefaultClaudeAdapter());
    const session = await port.createSession({
      title: "t",
      model: "anthropic/claude-opus-4-5",
      permissions: "auto",
    });

    await session.prompt({ text: "one", model: "anthropic/claude-opus-4-5" });
    const first = queryMock.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(first.options.model).toBe("claude-opus-4-5");
    expect(first.options.resume).toBeUndefined();
    expect(first.options.permissionMode).toBe("bypassPermissions");
    expect(first.options.allowDangerouslySkipPermissions).toBe(true);

    queryMock.mockImplementation(async function* () {
      yield { type: "result", subtype: "success", result: "second", session_id: "sess-1" };
    });
    await session.prompt({ text: "two", model: "anthropic/claude-opus-4-5" });
    const second = queryMock.mock.calls[1]![0] as { options: Record<string, unknown> };
    expect(second.options.resume).toBe("sess-1");
  });

  it("reports an unloadable SDK as unavailable with the reason", async () => {
    const port = createClaudeSdkPort(
      fakeAdapter({ async probe() { throw new Error("claude-agent-sdk not installed"); } }),
    );
    const availability = await port.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("not installed");
  });
});
