import { describe, expect, it, vi } from "vitest";
import { conformanceCases } from "../../../src/engine/agent/conformance.js";
import {
  createKimiSdkPort,
  kimiModelId,
  type KimiSdkAdapter,
  type KimiTurnHandle,
} from "../../../src/engine/agent/drivers/kimi-sdk";
import type { RuntimeEvent } from "../../../src/engine/agent/port";

/**
 * Contract tests for the Kimi driver through the injected adapter: no CLI, no
 * wire protocol, no credentials. A real turn needs a logged-in Kimi Code CLI and
 * stays "not verified" in RUNTIMES.md until one runs.
 */
function fakeTurn(overrides: Partial<KimiTurnHandle> = {}): KimiTurnHandle {
  return { run: vi.fn(async () => "pong"), abort: vi.fn(), close: vi.fn(async () => {}), ...overrides };
}

function fakeAdapter(turn: KimiTurnHandle = fakeTurn()): KimiSdkAdapter & {
  startTurn: ReturnType<typeof vi.fn>;
} {
  return { probe: vi.fn(async () => {}), startTurn: vi.fn(async () => turn) };
}

const OPTIONS = { title: "contract", sink: () => {}, directory: "/tmp/project" } as const;

describe("kimi driver contract", () => {
  it("reports availability from the probe, with its reason on failure", async () => {
    expect(await createKimiSdkPort(fakeAdapter()).isAvailable()).toEqual({ ok: true });
    const failing = createKimiSdkPort({
      probe: async () => {
        throw new Error("kimi is not logged in");
      },
      startTurn: async () => fakeTurn(),
    });
    const availability = await failing.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("not logged in");
  });

  it("explains the empty catalog and resolves a bare model", async () => {
    const port = createKimiSdkPort(fakeAdapter());
    const catalog = await port.listModels();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toBeTruthy();
    expect(port.resolveModel("kimi-latest")).toEqual({ ok: true, model: "kimi-latest" });
    expect(port.resolveModel("").ok).toBe(false);
  });

  it("strips the provider prefix from a canonical model reference", () => {
    expect(kimiModelId("moonshot/kimi-latest")).toBe("kimi-latest");
    expect(kimiModelId("kimi-latest")).toBe("kimi-latest");
    expect(kimiModelId(undefined)).toBeUndefined();
  });

  it("builds the turn with the session's directory, model and permissions", async () => {
    const adapter = fakeAdapter();
    const port = createKimiSdkPort(adapter);
    await port.createSession({ ...OPTIONS, model: "kimi-latest", permissions: "auto" });
    expect(adapter.startTurn).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      model: "kimi-latest",
      permissions: "auto",
    });
  });

  it("returns the text and emits text then done", async () => {
    const events: RuntimeEvent[] = [];
    const port = createKimiSdkPort(fakeAdapter());
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    const result = await session.prompt({ text: "say pong" });
    expect(result.text).toBe("pong");
    expect(events.map((event) => event.type)).toEqual(["text", "done"]);
  });

  it("propagates a failed turn to the caller and the sink", async () => {
    const events: RuntimeEvent[] = [];
    const port = createKimiSdkPort(
      fakeAdapter(
        fakeTurn({
          run: async () => {
            throw new Error("kimi asked for tool approval");
          },
        }),
      ),
    );
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    await expect(session.prompt({ text: "hi" })).rejects.toThrow("tool approval");
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("passes the per-prompt model and timeout, aborts, and closes the CLI session", async () => {
    const turn = fakeTurn();
    const port = createKimiSdkPort(fakeAdapter(turn));
    const session = await port.createSession({ ...OPTIONS, model: "session-model" });
    await session.prompt({ text: "hi", model: "turn-model", timeoutMs: 999 });
    expect(turn.run).toHaveBeenCalledWith("hi", { model: "turn-model", timeoutMs: 999 });
    await session.interrupt();
    expect(turn.abort).toHaveBeenCalledTimes(1);
    await session.close();
    expect(turn.close).toHaveBeenCalledTimes(1);
  });

  it("does not claim structured output it cannot deliver", async () => {
    const events: RuntimeEvent[] = [];
    const port = createKimiSdkPort(fakeAdapter());
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    await session.prompt({ text: "hi" });
    expect(port.capabilities.usageCost).toBe(false);
    expect(port.capabilities.permissions).toBe("none");
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });
});

describe("kimi driver conformance", () => {
  const cases = conformanceCases({
    makePort: () => createKimiSdkPort(fakeAdapter()),
    makeFailingPort: () =>
      createKimiSdkPort(
        fakeAdapter(
          fakeTurn({
            run: async () => {
              throw new Error("kimi provider exploded");
            },
          }),
        ),
      ),
  });
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});
