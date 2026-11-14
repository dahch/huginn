import { describe, expect, it, vi } from "vitest";
import {
  createClaudeSdkPort,
  type ClaudeSdkAdapter,
  type ClaudeTurnHandle,
} from "../../../src/engine/agent/drivers/claude-sdk";
import type { RuntimeEvent } from "../../../src/engine/agent/port";

/**
 * Contract tests for the Claude driver, run entirely through the injected
 * adapter — no Claude account, no CLI, no network.
 *
 * What they can prove: the driver builds the turn correctly, maps the result,
 * forwards usage, propagates errors and aborts. What they cannot: the provider
 * round-trip, which needs a logged-in `claude` and stays marked "not verified"
 * in RUNTIMES.md.
 */
function fakeTurn(overrides: Partial<ClaudeTurnHandle> = {}): ClaudeTurnHandle {
  return {
    run: vi.fn(async () => "pong"),
    abort: vi.fn(),
    ...overrides,
  };
}

function fakeAdapter(turn: ClaudeTurnHandle = fakeTurn()): ClaudeSdkAdapter & {
  startTurn: ReturnType<typeof vi.fn>;
} {
  return {
    probe: vi.fn(async () => {}),
    startTurn: vi.fn(async () => turn),
  };
}

const OPTIONS = { title: "contract", sink: () => {}, directory: "/tmp/project" } as const;

describe("claude driver contract (injected adapter)", () => {
  it("reports availability from the probe, and its reason when the probe fails", async () => {
    const ok = createClaudeSdkPort(fakeAdapter());
    expect(await ok.isAvailable()).toEqual({ ok: true });

    const failing = createClaudeSdkPort({
      probe: async () => {
        throw new Error("claude binary not found");
      },
      startTurn: async () => fakeTurn(),
    });
    const availability = await failing.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("claude binary not found");
  });

  it("explains an empty catalog and passes a bare model through", async () => {
    const port = createClaudeSdkPort(fakeAdapter());
    const catalog = await port.listModels();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toBeTruthy();
    expect(port.resolveModel("claude-sonnet-4-5")).toEqual({ ok: true, model: "claude-sonnet-4-5" });
    expect(port.resolveModel("  ").ok).toBe(false);
  });

  it("starts the turn with the session's directory, model and permissions", async () => {
    const adapter = fakeAdapter();
    const port = createClaudeSdkPort(adapter);
    await port.createSession({ ...OPTIONS, model: "claude-sonnet-4-5", permissions: "auto" });
    expect(adapter.startTurn).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      model: "claude-sonnet-4-5",
      permissions: "auto",
    });
  });

  it("returns the text, emits it once and closes the turn with done", async () => {
    const events: RuntimeEvent[] = [];
    const port = createClaudeSdkPort(fakeAdapter());
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });

    const result = await session.prompt({ text: "say pong" });

    expect(result.text).toBe("pong");
    expect(events.map((event) => event.type)).toEqual(["text", "done"]);
  });

  it("does not emit a usage event, because it cannot claim structured output", async () => {
    // The conformance contract allows only text/done/error when
    // `structuredEvents` is false. The SDK does report cost, but forwarding it
    // here would make the driver claim a capability it does not deliver.
    const events: RuntimeEvent[] = [];
    const port = createClaudeSdkPort(fakeAdapter());
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    await session.prompt({ text: "hi" });
    expect(events.some((event) => event.type === "usage")).toBe(false);
    expect(port.capabilities.usageCost).toBe(false);
  });

  it("propagates a failed turn and says so on the sink", async () => {
    const events: RuntimeEvent[] = [];
    const port = createClaudeSdkPort(
      fakeAdapter(
        fakeTurn({
          run: async () => {
            throw new Error("Not logged in · Please run /login");
          },
        }),
      ),
    );
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    await expect(session.prompt({ text: "hi" })).rejects.toThrow("Not logged in");
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("applies the per-prompt model override and the timeout, not the session's", async () => {
    const turn = fakeTurn();
    const port = createClaudeSdkPort(fakeAdapter(turn));
    const session = await port.createSession({ ...OPTIONS, model: "session-model" });
    await session.prompt({ text: "hi", model: "turn-model", timeoutMs: 1234 });
    expect(turn.run).toHaveBeenCalledWith("hi", { model: "turn-model", timeoutMs: 1234 });
  });

  it("aborts the running turn on interrupt and closes without side effects", async () => {
    const turn = fakeTurn();
    const port = createClaudeSdkPort(fakeAdapter(turn));
    const session = await port.createSession({ ...OPTIONS });
    await session.interrupt();
    expect(turn.abort).toHaveBeenCalledTimes(1);
    await expect(session.close()).resolves.toBeUndefined();
  });
});
