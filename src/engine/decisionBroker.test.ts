import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DecisionBroker } from "./decisionBroker";
import { events } from "./engineEvents";
import type { DecisionRequest } from "./types";

function req(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    id: crypto.randomUUID(),
    kind: "gate-blocked",
    iteration: 1,
    phase: "SPEC_AUDIT",
    attempt: 1,
    message: "gate",
    ...overrides,
  };
}

let seen: Array<string> = [];
let off: () => void;

beforeEach(() => {
  seen = [];
  off = events.on("decision", (d) => seen.push(d.id));
});

afterEach(() => {
  off();
  seen = [];
});

describe("DecisionBroker", () => {
  it("resolves a single request FIFO", async () => {
    const broker = new DecisionBroker();
    const p = broker.request(req({ id: "a" }));
    broker.resolve("continue");
    await expect(p).resolves.toBe("continue");
    expect(broker.pending).toBe(false);
  });

  it("queues concurrent requests and resolves them in arrival order", async () => {
    const broker = new DecisionBroker();
    // a gate-blocked decision is pending while a permission request arrives
    const gate = broker.request(req({ id: "gate", kind: "gate-blocked", phase: "REVIEW" }));
    const permission = broker.request(
      req({ id: "perm", kind: "permission", permissionId: "p1", permissionSessionId: "s1" }),
    );
    // only the head of the queue is surfaced
    expect(seen).toEqual(["gate"]);
    expect(broker.length).toBe(2);

    broker.resolve("abort");
    await expect(gate).resolves.toBe("abort");
    // the next queued request is now surfaced
    expect(seen).toEqual(["gate", "perm"]);
    expect(broker.length).toBe(1);

    broker.resolve("allow");
    await expect(permission).resolves.toBe("allow");
    expect(broker.pending).toBe(false);
  });

  it("resolveAll unblocks every pending request (abort path)", async () => {
    const broker = new DecisionBroker();
    const a = broker.request(req({ id: "a" }));
    const b = broker.request(req({ id: "b" }));
    broker.resolveAll("abort");
    await expect(a).resolves.toBe("abort");
    await expect(b).resolves.toBe("abort");
    expect(broker.pending).toBe(false);
  });

  it("resolve on an empty queue is a no-op", () => {
    const broker = new DecisionBroker();
    expect(() => broker.resolve("continue")).not.toThrow();
    expect(broker.pending).toBe(false);
  });
});
