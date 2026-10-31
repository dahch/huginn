import { describe, it, expect } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { createOpencodePort } from "./opencode";
import type { RuntimeEvent } from "../port.js";

interface FakeState {
  permissions: Array<{ sessionId: string; permissionId: string; response: string }>;
  prompts: Array<{ sessionId: string; text: string }>;
  aborts: string[];
  questions: Array<{ url?: string; body?: unknown }>;
}

function fakeClient(script: unknown[]): { client: OpencodeClient; state: FakeState } {
  const state: FakeState = { permissions: [], prompts: [], aborts: [], questions: [] };
  const post = async (opts: { url?: string; body?: unknown }) => {
    state.questions.push(opts);
    return {};
  };
  const client = {
    session: {
      create: async () => ({ id: "ses_1" }),
      get: async ({ path }: { path: { id: string } }) => {
        if (path.id === "missing") {
          const err = new Error("not found");
          (err as unknown as { status: number }).status = 404;
          throw err;
        }
        return { id: path.id };
      },
      abort: async ({ path }: { path: { id: string } }) => {
        state.aborts.push(path.id);
      },
      prompt: async (params: { path: { id: string }; body?: { parts?: Array<{ text?: string }> } }) => {
        state.prompts.push({ sessionId: params.path.id, text: params.body?.parts?.[0]?.text ?? "" });
        return { info: { id: "msg", error: undefined }, parts: [{ type: "text", text: "the result" }] };
      },
    },
    postSessionIdPermissionsPermissionId: async (params: {
      path: { id: string; permissionID: string };
      body: { response: string };
    }) => {
      state.permissions.push({
        sessionId: params.path.id,
        permissionId: params.path.permissionID,
        response: params.body.response,
      });
    },
    _client: { post },
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          for (const event of script) yield event;
        })(),
      }),
    },
  } as unknown as OpencodeClient;
  return { client, state };
}

function tick(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function partEvent(part: Record<string, unknown>): unknown {
  return { type: "message.part.updated", properties: { part: { sessionID: "ses_1", ...part } } };
}

describe("createOpencodePort", () => {
  it("streams text deltas once, maps tools and reports usage", async () => {
    const { client } = fakeClient([
      partEvent({ id: "p1", type: "text", text: "Hel" }),
      partEvent({ id: "p1", type: "text", text: "Hello" }),
      partEvent({ id: "t1", type: "tool", tool: "read", state: { status: "running", title: "file.ts" } }),
      partEvent({ id: "t1", type: "tool", tool: "read", state: { status: "completed" } }),
      {
        type: "message.updated",
        properties: { info: { role: "assistant", sessionID: "ses_1", tokens: { input: 10, output: 3 }, cost: 0.01 } },
      },
    ]);
    const port = createOpencodePort({ client });
    const events: RuntimeEvent[] = [];
    const session = await port.createSession({ title: "t", sink: (event) => events.push(event) });
    await tick();

    const text = events.filter((event) => event.type === "text").map((event) => event.text);
    expect(text).toEqual(["Hel", "lo"]);
    expect(events.some((event) => event.type === "tool.start")).toBe(true);
    expect(events.some((event) => event.type === "tool.end" && event.ok)).toBe(true);
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toEqual({ type: "usage", inputTokens: 10, outputTokens: 3, costUsd: 0.01 });

    await session.close();
  });

  it("asks its permission handler and answers the server with the decision", async () => {
    const { client, state } = fakeClient([
      {
        type: "permission.asked",
        properties: { id: "perm_1", sessionID: "ses_1", title: "run tests" },
      },
    ]);
    const port = createOpencodePort({ client });
    const asked: string[] = [];
    const session = await port.createSession({
      title: "t",
      onPermission: async (request) => {
        asked.push(request.title);
        return "allow-once";
      },
    });
    await tick();

    expect(asked).toEqual(["run tests"]);
    expect(state.permissions).toEqual([
      { sessionId: "ses_1", permissionId: "perm_1", response: "once" },
    ]);
    await session.close();
  });

  it("fails closed on a permission it cannot ask about", async () => {
    const { client, state } = fakeClient([
      { type: "permission.asked", properties: { id: "perm_2", sessionID: "ses_1" } },
    ]);
    const port = createOpencodePort({ client });
    const session = await port.createSession({ title: "t" });
    await tick();
    expect(state.permissions[0]?.response).toBe("reject");
    await session.close();
  });

  it("routes the backend's questions through onQuestion", async () => {
    const { client, state } = fakeClient([
      {
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "ses_1",
          questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
        },
      },
    ]);
    const port = createOpencodePort({ client });
    const asked: string[] = [];
    const session = await port.createSession({
      title: "t",
      onQuestion: async (request) => {
        asked.push(request.questions[0]!.question);
        return { answers: [["B"]] };
      },
    });
    await tick();

    expect(asked).toEqual(["Pick one"]);
    expect(state.questions[0]?.url).toContain("/question/{requestID}/reply");
    await session.close();
  });

  it("rejects a question it cannot ask about", async () => {
    const { client, state } = fakeClient([
      {
        type: "question.asked",
        properties: { id: "q2", sessionID: "ses_1", questions: [{ question: "Pick" }] },
      },
    ]);
    const port = createOpencodePort({ client });
    const session = await port.createSession({ title: "t" });
    await tick();
    expect(state.questions[0]?.url).toContain("/reject");
    await session.close();
  });

  it("creates, resumes and probes sessions", async () => {
    const { client } = fakeClient([]);
    const port = createOpencodePort({ client });

    const session = await port.createSession({ title: "t" });
    expect(session.id).toBe("ses_1");
    expect(session.resumable).toBe(true);

    expect(await port.probeSession!("ses_1")).toBe("exists");
    expect(await port.probeSession!("missing")).toBe("gone");

    const resumed = await port.resumeSession!("ses_existing", { title: "t" });
    expect(resumed.id).toBe("ses_existing");
    await session.close();
    await resumed.close();
  });

  it("emits exactly one done event with the prompt result", async () => {
    const { client } = fakeClient([]);
    const port = createOpencodePort({ client });
    const events: RuntimeEvent[] = [];
    const session = await port.createSession({ title: "t", sink: (event) => events.push(event) });
    const result = await session.prompt({ text: "go" });
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", result });
    await session.close();
  });

  it("interrupt aborts the session and close never does", async () => {
    const { client, state } = fakeClient([]);
    const port = createOpencodePort({ client });
    const session = await port.createSession({ title: "t" });
    await session.interrupt();
    await session.close();
    expect(state.aborts).toEqual(["ses_1"]);
  });
});
