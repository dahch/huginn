import { describe, expect, it } from "bun:test";
import { applyV2Event, type V2EventState } from "./opencodeV2";

/**
 * The v2 event vocabulary is not typed by the SDK, so the shapes are the risk.
 * These pin exactly the frames captured from a real v2.3.0 server.
 */
describe("opencode v2 event reduction", () => {
  const empty: V2EventState = { text: "", done: false };

  it("accumulates text deltas and keeps the assistant message id", () => {
    const state = applyV2Event(
      applyV2Event(empty, {
        type: "session.text.delta",
        data: { sessionID: "s", assistantMessageID: "m1", delta: "po" },
      }),
      { type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "m1", delta: "ng" } },
    );
    expect(state.text).toBe("pong");
    expect(state.assistantMessageId).toBe("m1");
  });

  it("takes the final text from session.text.ended", () => {
    const state = applyV2Event(empty, {
      type: "session.text.ended",
      data: { assistantMessageID: "m1", text: "pong" },
    });
    expect(state.text).toBe("pong");
  });

  it("records tokens and cost from the step", () => {
    const state = applyV2Event(empty, {
      type: "session.step.ended",
      data: { tokens: { input: 5211, output: 12, reasoning: 1 }, cost: 0 },
    });
    expect(state.tokens?.input).toBe(5211);
    expect(state.cost).toBe(0);
  });

  it("marks the turn done only on execution end, and surfaces its error", () => {
    expect(applyV2Event(empty, { type: "session.usage.updated", data: {} }).done).toBe(false);
    expect(applyV2Event(empty, { type: "session.execution.succeeded", data: {} }).done).toBe(true);
    const failed = applyV2Event(empty, {
      type: "session.execution.failed",
      data: { message: "provider refused" },
    });
    expect(failed.done).toBe(true);
    expect(failed.error).toBe("provider refused");
  });

  it("ignores frames it does not know", () => {
    expect(applyV2Event(empty, { type: "server.connected", data: {} })).toEqual(empty);
    expect(applyV2Event(empty, null)).toEqual(empty);
  });
});
