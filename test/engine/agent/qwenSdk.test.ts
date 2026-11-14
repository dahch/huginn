import { describe, expect, it, vi } from "vitest";
import {
  createQwenSdkPort,
  qwenModelId,
  type QwenSdkAdapter,
  type QwenTurnHandle,
} from "../../../src/engine/agent/drivers/qwen-sdk";
import type { RuntimeEvent } from "../../../src/engine/agent/port";

/**
 * Contract tests for the Qwen driver, through the injected adapter only — no
 * credentials, no bundled CLI, no network. A real turn still needs a configured
 * Qwen account and stays "not verified" in RUNTIMES.md until one runs.
 */
function fakeTurn(overrides: Partial<QwenTurnHandle> = {}): QwenTurnHandle {
  return { run: vi.fn(async () => "pong"), abort: vi.fn(), ...overrides };
}

function fakeAdapter(turn: QwenTurnHandle = fakeTurn()): QwenSdkAdapter & {
  startTurn: ReturnType<typeof vi.fn>;
} {
  return { probe: vi.fn(async () => {}), startTurn: vi.fn(async () => turn) };
}

const OPTIONS = { title: "contract", sink: () => {}, directory: "/tmp/project" } as const;

describe("qwen driver contract", () => {
  it("reports availability from the probe, with its reason on failure", async () => {
    expect(await createQwenSdkPort(fakeAdapter()).isAvailable()).toEqual({ ok: true });
    const failing = createQwenSdkPort({
      probe: async () => {
        throw new Error("qwen module missing");
      },
      startTurn: async () => fakeTurn(),
    });
    const availability = await failing.isAvailable();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("qwen module missing");
  });

  it("explains the empty catalog and resolves a bare model", async () => {
    const port = createQwenSdkPort(fakeAdapter());
    const catalog = await port.listModels();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toBeTruthy();
    expect(port.resolveModel("qwen-max")).toEqual({ ok: true, model: "qwen-max" });
    expect(port.resolveModel("").ok).toBe(false);
  });

  it("strips the provider prefix from a canonical model reference", () => {
    expect(qwenModelId("dashscope/qwen-max")).toBe("qwen-max");
    expect(qwenModelId("qwen-plus")).toBe("qwen-plus");
    expect(qwenModelId(undefined)).toBeUndefined();
  });

  it("builds the turn with the session's directory, model and permissions", async () => {
    const adapter = fakeAdapter();
    const port = createQwenSdkPort(adapter);
    await port.createSession({ ...OPTIONS, model: "qwen-max", permissions: "auto" });
    expect(adapter.startTurn).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      model: "qwen-max",
      permissions: "auto",
    });
  });

  it("returns the text and emits text then done", async () => {
    const events: RuntimeEvent[] = [];
    const port = createQwenSdkPort(fakeAdapter());
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    const result = await session.prompt({ text: "say pong" });
    expect(result.text).toBe("pong");
    expect(events.map((event) => event.type)).toEqual(["text", "done"]);
  });

  it("propagates a failed turn to the caller and the sink", async () => {
    const events: RuntimeEvent[] = [];
    const port = createQwenSdkPort(
      fakeAdapter(
        fakeTurn({
          run: async () => {
            throw new Error("qwen auth required");
          },
        }),
      ),
    );
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    await expect(session.prompt({ text: "hi" })).rejects.toThrow("qwen auth required");
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("passes the per-prompt model and timeout, and aborts on interrupt", async () => {
    const turn = fakeTurn();
    const port = createQwenSdkPort(fakeAdapter(turn));
    const session = await port.createSession({ ...OPTIONS, model: "session-model" });
    await session.prompt({ text: "hi", model: "turn-model", timeoutMs: 999 });
    expect(turn.run).toHaveBeenCalledWith("hi", { model: "turn-model", timeoutMs: 999 });
    await session.interrupt();
    expect(turn.abort).toHaveBeenCalledTimes(1);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it("does not claim structured output it cannot deliver", async () => {
    const events: RuntimeEvent[] = [];
    const port = createQwenSdkPort(fakeAdapter());
    const session = await port.createSession({ ...OPTIONS, sink: (event) => events.push(event) });
    await session.prompt({ text: "hi" });
    expect(port.capabilities.usageCost).toBe(false);
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });
});
import { conformanceCases } from "../../../src/engine/agent/conformance.js";
import { describe as describeConformance } from "vitest";

describeConformance("qwen driver conformance", () => {
  const cases = conformanceCases({
    makePort: () => createQwenSdkPort(fakeAdapter()),
    makeFailingPort: () =>
      createQwenSdkPort(
        fakeAdapter(
          fakeTurn({
            run: async () => {
              throw new Error("qwen provider exploded");
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

describe("qwen permission wiring", () => {
  async function capture(decision: "allow-once" | "deny") {
    const events: RuntimeEvent[] = [];
    const captured: { onPermission?: (request: { tool: string; detail?: string }) => Promise<boolean> } = {};
    const adapter = {
      probe: async () => {},
      startTurn: async (options: { onPermission?: (request: { tool: string; detail?: string }) => Promise<boolean> }) => {
        captured.onPermission = options.onPermission;
        return fakeTurn();
      },
    };
    const port = createQwenSdkPort(adapter as never);
    await port.createSession({
      ...OPTIONS,
      sink: (event) => events.push(event),
      onPermission: async () => decision,
    });
    return { events, captured };
  }

  it("asks through the session handler and maps the decision to a boolean", async () => {
    const allowed = await capture("allow-once");
    expect(allowed.captured.onPermission).toBeTypeOf("function");
    expect(await allowed.captured.onPermission!({ tool: "Write" })).toBe(true);
    const event = allowed.events.find((e) => e.type === "permission.request");
    expect(event && event.type === "permission.request" && event.request.title).toBe("Write");

    const denied = await capture("deny");
    expect(await denied.captured.onPermission!({ tool: "Write" })).toBe(false);
  });

  it("declares interactive permissions and therefore interrupt", () => {
    const port = createQwenSdkPort(fakeAdapter());
    expect(port.capabilities.permissions).toBe("interactive");
    expect(port.capabilities.interrupt).toBe(true);
  });
});
