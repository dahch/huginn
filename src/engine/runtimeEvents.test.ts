import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { addUsage, createRuntimeSink } from "./runtimeEvents";
import { events } from "./engineEvents";
import type { RuntimeEvent } from "./agent/port.js";

let stream: string[] = [];
let logs: string[] = [];
let usages: Array<{ total: { inputTokens: number; outputTokens: number; costUsd: number } }> = [];
const offs: Array<() => void> = [];

beforeEach(() => {
  stream = [];
  logs = [];
  usages = [];
  offs.push(events.on("phaseStream", (e) => stream.push(e.text)));
  offs.push(events.on("log", (e) => logs.push(e.message)));
  offs.push(events.on("usage", (e) => usages.push({ total: e.total })));
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
});

function emit(sink: ReturnType<typeof createRuntimeSink>, event: RuntimeEvent): void {
  sink(event);
}

describe("createRuntimeSink", () => {
  it("forwards text deltas only when the driver streams", () => {
    emit(createRuntimeSink({ streaming: true }), { type: "text", text: "hola" });
    expect(stream.join("")).toContain("hola");

    stream = [];
    emit(createRuntimeSink({ streaming: false }), { type: "text", text: "one-shot" });
    expect(stream.join("")).toBe("");
  });

  it("maps tools to the stream and the log", () => {
    const sink = createRuntimeSink({ streaming: true });
    emit(sink, { type: "tool.start", name: "read", detail: "file.ts" });
    emit(sink, { type: "tool.end", name: "read", ok: true });
    emit(sink, { type: "tool.end", name: "read", ok: false, detail: "boom" });

    expect(stream.join("")).toContain("⚡ [tool: read] file.ts");
    expect(stream.join("")).toContain("✓ [tool: read] completed");
    expect(stream.join("")).toContain("✗ [tool: read] error: boom");
    expect(logs.some((line) => line.includes("tool: read"))).toBe(true);
  });

  it("emits nothing for done", () => {
    emit(createRuntimeSink({ streaming: true }), {
      type: "done",
      result: { messageId: "m", text: "the final report" },
    });
    expect(stream.join("")).toBe("");
    expect(logs).toEqual([]);
  });

  it("accumulates usage and notifies the caller", () => {
    const seen: number[] = [];
    const sink = createRuntimeSink({
      streaming: false,
      onUsage: (event) => seen.push(event.inputTokens ?? 0),
    });
    emit(sink, { type: "usage", inputTokens: 10, outputTokens: 4, costUsd: 0.02 });
    emit(sink, { type: "usage", inputTokens: 5, outputTokens: 1, costUsd: 0.01 });

    expect(seen).toEqual([10, 5]);
    expect(usages.at(-1)?.total).toEqual({ inputTokens: 15, outputTokens: 5, costUsd: 0.03 });
  });

  it("sanitizes terminal escapes", () => {
    emit(createRuntimeSink({ streaming: true }), { type: "text", text: "\u001b[2Jpwned" });
    expect(stream.join("")).not.toContain("\u001b");
    expect(stream.join("")).toContain("pwned");
  });

  it("never throws out of the sink, even when onUsage does", () => {
    const sink = createRuntimeSink({
      streaming: true,
      onUsage: () => {
        throw new Error("boom");
      },
    });
    expect(() => emit(sink, { type: "usage", inputTokens: 1 })).not.toThrow();
    expect(() => emit(sink, { type: "error", message: "x" })).not.toThrow();
  });
});

describe("addUsage", () => {
  it("treats missing metrics as zero", () => {
    expect(addUsage({ inputTokens: 1, outputTokens: 2, costUsd: 0.1 }, { type: "usage" })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.1,
    });
  });
});
