/**
 * The v2 prompt exchange.
 *
 * v1's `POST /session/{id}/message` blocked until the model finished. v2 does
 * not: `POST /api/session/{id}/prompt` returns the *user* message immediately and
 * the answer arrives on the event stream (`session.text.delta`,
 * `session.text.ended`, `session.step.ended`, `session.execution.succeeded`).
 *
 * So a caller that wants a result has to subscribe first, prompt second, and
 * wait for the execution to end. That is what this module does, and it is why the
 * SDK's generated `session.prompt` cannot be used for v2: it still speaks the v1
 * shapes (`/message` with `parts`).
 */
import type { ModelRef } from "../engine/types.js";

export interface V2Auth {
  baseUrl: string;
  /** Password printed by `opencode serve`; HTTP Basic with user `opencode`. */
  password: string;
}

export interface V2PromptOptions extends V2Auth {
  sessionId: string;
  text: string;
  agent?: string;
  model?: ModelRef;
  directory?: string;
  timeoutMs?: number;
  /** Answers a permission request; absent means deny (fail closed). */
  onPermission?: (request: { id: string; sessionId: string; title?: string }) => "once" | "always" | "reject";
}

export interface V2PromptResult {
  messageId: string;
  text: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
}

function basic(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

function authHeaders(options: V2Auth): Record<string, string> {
  return { authorization: basic(options.password) };
}

/**
 * The pure part: one SSE `data:` frame to the state change it means.
 *
 * Exported so the event contract can be tested without a server — the shapes are
 * the whole risk here, and they are not typed by the SDK.
 */
export interface V2EventState {
  text: string;
  assistantMessageId?: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
  done: boolean;
  error?: string;
}

export function applyV2Event(state: V2EventState, frame: unknown): V2EventState {
  if (!frame || typeof frame !== "object") return state;
  const event = frame as { type?: string; data?: Record<string, unknown> };
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "session.text.delta": {
      const delta = typeof data.delta === "string" ? data.delta : "";
      return { ...state, text: state.text + delta, assistantMessageId: (data.assistantMessageID as string) ?? state.assistantMessageId };
    }
    case "session.text.ended": {
      const text = typeof data.text === "string" ? data.text : state.text;
      return { ...state, text, assistantMessageId: (data.assistantMessageID as string) ?? state.assistantMessageId };
    }
    case "session.step.ended": {
      const tokens = data.tokens as V2EventState["tokens"];
      return {
        ...state,
        tokens: tokens ?? state.tokens,
        cost: typeof data.cost === "number" ? data.cost : state.cost,
      };
    }
    case "session.execution.succeeded":
      return { ...state, done: true };
    case "session.execution.failed":
    case "session.execution.error": {
      const message =
        typeof data.error === "string"
          ? data.error
          : typeof data.message === "string"
            ? data.message
            : "the opencode session failed";
      return { ...state, done: true, error: message };
    }
    default:
      return state;
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Abort a running turn; best effort, like the v1 helper. */
export async function abortV2(options: V2Auth, sessionId: string): Promise<void> {
  try {
    await post(
      `${options.baseUrl}/api/session/${encodeURIComponent(sessionId)}/abort`,
      authHeaders(options),
      {},
    );
  } catch {
    /* the server may already be done with it */
  }
}

export async function promptV2(options: V2PromptOptions): Promise<V2PromptResult> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 0;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      : undefined;
  const headers = authHeaders(options);

  try {
    // Subscribe first: the prompt can finish before a later subscriber sees the
    // first delta, and a lost text event cannot be recovered from the POST.
    const stream = await fetch(`${options.baseUrl}/api/event`, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!stream.ok || !stream.body) {
      throw new Error(`opencode /api/event answered ${stream.status}`);
    }

    const started = await post(
      `${options.baseUrl}/api/session/${encodeURIComponent(options.sessionId)}/prompt`,
      headers,
      {
        text: options.text,
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.model ? { model: { providerID: options.model.providerID, modelID: options.model.modelID } } : {}),
        ...(options.directory ? { directory: options.directory } : {}),
      },
    );
    if (!started.ok) {
      const detail = await started.text().catch(() => "");
      throw new Error(`opencode /api/session/prompt answered ${started.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
    }

    let state: V2EventState = { text: "", done: false };
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!state.done) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let frame: unknown;
          try {
            frame = JSON.parse(payload);
          } catch {
            continue;
          }
          const data = (frame as { data?: { sessionID?: string } }).data;
          if (data?.sessionID && data.sessionID !== options.sessionId) continue;
          state = applyV2Event(state, frame);
        }
      }
    }
    if (state.error) throw new Error(state.error);
    if (!state.done) throw new Error("the opencode event stream ended before the turn completed");
    return {
      messageId: state.assistantMessageId ?? "",
      text: state.text.trim(),
      tokens: state.tokens,
      cost: state.cost,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      await abortV2(options, options.sessionId);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
