import { describe, it, expect } from "bun:test";
import { prompt, runCommand, PhaseTimeoutError } from "./client";

function stalledClient() {
  let aborted = false;
  return {
    session: {
      abort: async () => {
        aborted = true;
      },
      prompt: () => new Promise((_, reject) => {
        // never resolves — simulate a stalled provider call
        void reject;
      }),
      command: () => new Promise((_, reject) => {
        void reject;
      }),
    },
    get aborted() {
      return aborted;
    },
  } as never;
}

describe("client timeouts", () => {
  it("prompt rejects with PhaseTimeoutError and aborts the session when the provider stalls", async () => {
    const c = stalledClient();
    const t0 = Date.now();
    await expect(
      prompt(c as never, "ses_x", { text: "hello", timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(PhaseTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((c as unknown as { aborted: boolean }).aborted).toBe(true);
  });

  it("runCommand rejects with PhaseTimeoutError on a stalled command", async () => {
    const c = stalledClient();
    await expect(
      runCommand(c as never, "ses_x", { command: "validate-step", arguments: "src", timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(PhaseTimeoutError);
  });

  it("disables the timeout when timeoutMs is 0 (build still runs)", async () => {
    const fast = {
      session: {
        abort: async () => {},
        prompt: async () => ({ info: { id: "msg_1" }, parts: [{ type: "text", text: "done" }] }),
      },
    } as never;
    const res = await prompt(fast as never, "ses_x", { text: "hi", timeoutMs: 0 });
    expect(res.messageId).toBe("msg_1");
    expect(res.text).toBe("done");
  });
});
