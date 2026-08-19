import { describe, it, expect } from "bun:test";
import { subscribeToEvents } from "./permissions";
import type { RunConfig } from "../config";
import type { DecisionRequest } from "./types";

function createMockSse(eventsList: unknown[]) {
  async function* generator() {
    for (const ev of eventsList) {
      yield ev;
    }
  }
  return {
    stream: generator(),
  };
}

describe("subscribeToEvents", () => {
  it("auto-answers question.asked with the first option when permissions is auto", async () => {
    let repliedPayload: unknown = null;
    const mockClient = {
      event: {
        subscribe: async () =>
          createMockSse([
            {
              type: "question.asked",
              properties: {
                id: "req_1",
                sessionID: "ses_1",
                questions: [
                  {
                    question: "Pick direction",
                    options: [{ label: "Option A", description: "First" }, { label: "Option B" }],
                  },
                ],
              },
            },
          ]),
      },
      _client: {
        post: async (opts: unknown) => {
          repliedPayload = opts;
          return { response: { status: 200 } };
        },
      },
    };

    const cfg = { permissions: "auto" } as RunConfig;
    const sub = subscribeToEvents(mockClient as never, cfg, async () => "continue");

    await new Promise((r) => setTimeout(r, 50));
    sub.close();

    expect(repliedPayload).toBeDefined();
    const post = repliedPayload as { url: string; body: { answers: string[][] } };
    expect(post.url).toBe("/session/{sessionID}/question/{requestID}/reply");
    expect(post.body.answers).toEqual([["Option A"]]);
  });

  it("auto-rejects question.asked when permissions is deny", async () => {
    let rejectCalled = false;
    const mockClient = {
      event: {
        subscribe: async () =>
          createMockSse([
            {
              type: "question.asked",
              properties: {
                id: "req_2",
                sessionID: "ses_1",
                questions: [{ question: "Pick direction" }],
              },
            },
          ]),
      },
      _client: {
        post: async (opts: { url: string }) => {
          if (opts.url.includes("reject")) rejectCalled = true;
          return { response: { status: 200 } };
        },
      },
    };

    const cfg = { permissions: "deny" } as RunConfig;
    const sub = subscribeToEvents(mockClient as never, cfg, async () => "deny");

    await new Promise((r) => setTimeout(r, 50));
    sub.close();

    expect(rejectCalled).toBe(true);
  });

  it("surfaces question.asked through requestDecision when permissions is ask", async () => {
    let capturedDecision: DecisionRequest | null = null;
    let replied = false;
    const mockClient = {
      event: {
        subscribe: async () =>
          createMockSse([
            {
              type: "question.asked",
              properties: {
                id: "req_3",
                sessionID: "ses_1",
                questions: [
                  {
                    question: "Confirm refactor?",
                    options: [{ label: "Yes (Recommended)" }, { label: "No" }],
                  },
                ],
              },
            },
          ]),
      },
      _client: {
        post: async () => {
          replied = true;
          return { response: { status: 200 } };
        },
      },
    };

    const cfg = { permissions: "ask" } as RunConfig;
    const sub = subscribeToEvents(mockClient as never, cfg, async (req) => {
      capturedDecision = req;
      return "continue";
    });

    await new Promise((r) => setTimeout(r, 50));
    sub.close();

    expect(capturedDecision).toBeDefined();
    expect((capturedDecision as DecisionRequest | null)?.kind).toBe("question");
    expect((capturedDecision as DecisionRequest | null)?.message).toContain("Confirm refactor?");
    expect(replied).toBe(true);
  });
});
