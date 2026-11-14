import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { promptV2, type V2Auth } from "./opencodeV2.js";
import type { ModelRef } from "../engine/types";
import { events } from "../engine/engineEvents";

export class PhaseTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Phase exceeded timeout of ${timeoutMs}ms`);
    this.name = "PhaseTimeoutError";
  }
}

export async function abortSession(client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    await client.session.abort({ path: { id: sessionId } } as never);
  } catch {
    // best effort — the server-side agent may already be done
  }
}

/**
 * Runs `build` (which issues a blocking request) with a hard deadline. On
 * timeout the underlying fetch is aborted, the server-side agent is
 * interrupted via `session.abort`, and a `PhaseTimeoutError` is thrown so the
 * engine can retry/escalate instead of hanging forever on a stalled provider.
 */
function withTimeout<T>(
  timeoutMs: number | undefined,
  build: (signal?: AbortSignal) => Promise<T>,
  onTimeout: () => void,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return build(undefined);
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      ac.abort(new Error(`timed out after ${timeoutMs}ms`));
      reject(new PhaseTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const buildPromise = build(ac.signal).then(
    (v) => {
      if (timedOut) {
        events.emit("log", {
          level: "warn",
          message: "a request settled after its timeout; the provider may still be processing",
        });
      }
      return v;
    },
    (err) => {
      if (ac.signal.aborted && !(err instanceof PhaseTimeoutError)) {
        if (timedOut) {
          events.emit("log", {
            level: "warn",
            message: "a request rejected after its timeout (already aborted locally)",
          });
        }
        throw new PhaseTimeoutError(timeoutMs);
      }
      throw err;
    },
  );
  return Promise.race([buildPromise, timeout]).finally(() => {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  });
}

/**
 * The SDK client, authenticated when the server needs it.
 *
 * opencode v2 requires HTTP Basic (user `opencode`, the password printed by
 * `serve`) on every /api/* call; v1 required nothing, so the header is only
 * added when a password is known.
 */
export function createClient(baseUrl: string, password?: string): OpencodeClient {
  // The generated SDK paths are relative to the API root ("/session/…",
  // "/event"), and v2 serves them under "/api" — v1 served them at the root.
  const root = password ? baseUrl.replace(/\/+$/, "") + "/api" : baseUrl;
  return createOpencodeClient({
    baseUrl: root,
    throwOnError: true,
    responseStyle: "data",
    ...(password
      ? { headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } }
      : {}),
  });
}

/**
 * Unwrap the v2 response envelope.
 *
 * The generated v2 helpers return `{ data: … }` (the server's body shape), while
 * the v1 helpers returned the body itself. Unwrapping here keeps every caller on
 * one shape and is a no-op for a response that has no `data` key.
 */
export function unwrapData<T>(value: T): T extends { data: infer D } ? D : T {
  if (value && typeof value === "object" && "data" in (value as Record<string, unknown>)) {
    return (value as unknown as { data: unknown }).data as never;
  }
  return value as never;
}

export function extractText(parts: Array<{ type?: string; text?: string }>): string {
  return (parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function textPart(text: string) {
  return { type: "text", text } as const;
}

export interface PromptResult {
  messageId: string;
  text: string;
  raw: { info: unknown; parts: Array<{ type?: string; text?: string }> };
}

export async function createSession(
  client: OpencodeClient,
  title: string,
  directory?: string,
): Promise<{ id: string }> {
  const res = await client.session.create({
    body: { title },
    ...(directory ? { query: { directory } } : {}),
  });
  return unwrapData(res as unknown as { id: string });
}

export async function sessionExists(client: OpencodeClient, sessionId: string): Promise<boolean> {
  return (await probeSession(client, sessionId)) === "exists";
}

/** How a session lookup ended — see {@link probeSession}. */
export type SessionProbe = "exists" | "gone" | "failed";

/**
 * Three-valued version of {@link sessionExists} (REV-4C-003): a caller that has
 * to *report* what happened must be able to tell "that session is gone" from
 * "the lookup itself did not answer". Both non-`exists` outcomes are handled the
 * same way (never adopt a session that was not confirmed), so this only changes
 * the wording, not the behavior.
 *
 * `throwOnError: true` (see {@link createClient}) makes a non-2xx response an
 * `Error` carrying the HTTP status under `cause.status` (the SDK's
 * `wrapClientError`), so a 404 is recognized from the status rather than guessed
 * from prose. The message fallback keeps a plainly-worded "not found" error (an
 * injected client, a wrapped error) classified as `gone`; anything else —
 * including a status that is neither 404 nor absent — is a failed probe.
 */
export async function probeSession(client: OpencodeClient, sessionId: string): Promise<SessionProbe> {
  try {
    await client.session.get({ path: { id: sessionId } });
    return "exists";
  } catch (err) {
    return isMissingSessionError(err) ? "gone" : "failed";
  }
}

function isMissingSessionError(err: unknown): boolean {
  const status =
    (err as { status?: unknown } | null)?.status ??
    (err as { cause?: { status?: unknown } } | null)?.cause?.status ??
    (err as { response?: { status?: unknown } } | null)?.response?.status;
  if (status !== undefined) return status === 404;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\b404\b|not[\s_-]?found/i.test(message);
}

export async function respondPermission(
  client: OpencodeClient,
  sessionID: string,
  permissionID: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  await client.postSessionIdPermissionsPermissionId({
    path: { id: sessionID, permissionID },
    body: { response },
  });
}

function getClientBaseUrl(client: OpencodeClient): string {
  const c = client as unknown as { _client?: { getConfig?: () => { baseUrl?: string }; baseUrl?: string }; baseUrl?: string };
  return c._client?.getConfig?.()?.baseUrl || c._client?.baseUrl || c.baseUrl || "http://127.0.0.1:4096";
}

/**
 * Path parameters of the two question endpoints, percent-encoded (M-3).
 *
 * The SDK path (`_client.post({ path: { … } })`) encodes its parameters itself,
 * but the plain-`fetch` fallback interpolated them straight into the URL: a
 * session or request id carrying `/`, `?` or `#` (a hand-edited session store,
 * or whatever a server hands back) could then address a *different* endpoint of
 * the opencode server. Both ids go through `encodeURIComponent` here, so the
 * request always names the id it was given.
 */
function questionPath(sessionID: string, requestID: string, action: "reply" | "reject"): string {
  return `/session/${encodeURIComponent(sessionID)}/question/${encodeURIComponent(requestID)}/${action}`;
}

export async function respondQuestion(
  client: OpencodeClient,
  sessionID: string,
  requestID: string,
  answers: string[][],
): Promise<void> {
  const c = client as unknown as { _client?: { post?: (opts: unknown) => Promise<unknown> } };
  if (c._client?.post) {
    await c._client.post({
      url: "/session/{sessionID}/question/{requestID}/reply",
      path: { sessionID, requestID },
      body: { answers },
    });
    return;
  }
  const baseUrl = getClientBaseUrl(client);
  await fetch(`${baseUrl}${questionPath(sessionID, requestID, "reply")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
}

export async function rejectQuestion(
  client: OpencodeClient,
  sessionID: string,
  requestID: string,
): Promise<void> {
  const c = client as unknown as { _client?: { post?: (opts: unknown) => Promise<unknown> } };
  if (c._client?.post) {
    await c._client.post({
      url: "/session/{sessionID}/question/{requestID}/reject",
      path: { sessionID, requestID },
    });
    return;
  }
  const baseUrl = getClientBaseUrl(client);
  await fetch(`${baseUrl}${questionPath(sessionID, requestID, "reject")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

export async function prompt(
  client: OpencodeClient,
  sessionId: string,
  opts: {
    text: string;
    agent?: string;
    model?: ModelRef;
    timeoutMs?: number;
    /**
     * Directory the server-side session is scoped to. Forwarded as the SDK
     * `directory` query parameter so the agent's tools operate inside the
     * sandbox worktree rather than the primary project tree (REQ-17).
     */
    directory?: string;
    /** Present for a v2 server: the prompt is asynchronous there. */
    v2?: V2Auth;
  },
): Promise<PromptResult> {
  if (opts.v2) {
    const result = await promptV2({
      ...opts.v2,
      sessionId,
      text: opts.text,
      agent: opts.agent,
      model: opts.model,
      directory: opts.directory,
      timeoutMs: opts.timeoutMs,
    });
    return {
      messageId: result.messageId,
      text: result.text,
      raw: {
        info: { id: result.messageId, tokens: result.tokens, cost: result.cost },
        parts: [{ type: "text", text: result.text }],
      },
    };
  }
  const body: Record<string, unknown> = {
    parts: [textPart(opts.text)],
  };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };

  return withTimeout(
    opts.timeoutMs,
    async (signal) => {
      // v2 wraps every body in { data }, so the envelope is unwrapped before the
      // fields are read; a v1 body (no `data`) passes through unchanged.
      const res = unwrapData(
        (await client.session.prompt({
          path: { id: sessionId },
          body: body as never,
          signal: signal as AbortSignal | undefined,
          ...(opts.directory ? { query: { directory: opts.directory } } : {}),
        } as never)) as unknown as { info: { id: string; error?: unknown }; parts: Array<{ type?: string; text?: string }> },
      );

      if (res.info?.error) {
        throw new Error(`Agent message failed: ${JSON.stringify(res.info.error)}`);
      }
      return { messageId: res.info.id, text: extractText(res.parts), raw: res };
    },
    () => void abortSession(client, sessionId),
  );
}

export async function runCommand(
  client: OpencodeClient,
  sessionId: string,
  opts: {
    command: string;
    arguments: string;
    agent?: string;
    model?: string;
    timeoutMs?: number;
    /** See {@link prompt}: sandbox-scoped directory query parameter (REQ-17). */
    directory?: string;
  },
): Promise<PromptResult> {
  const body: Record<string, unknown> = {
    command: opts.command,
    arguments: opts.arguments ?? "",
  };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) body.model = opts.model;

  return withTimeout(
    opts.timeoutMs,
    async (signal) => {
      const res = unwrapData(
        (await client.session.command({
          path: { id: sessionId },
          body: body as never,
          signal: signal as AbortSignal | undefined,
          ...(opts.directory ? { query: { directory: opts.directory } } : {}),
        } as never)) as unknown as { info: { id: string; error?: unknown }; parts: Array<{ type?: string; text?: string }> },
      );

      if (res.info?.error) {
        throw new Error(`Command /${opts.command} failed: ${JSON.stringify(res.info.error)}`);
      }
      return { messageId: res.info.id, text: extractText(res.parts), raw: res };
    },
    () => void abortSession(client, sessionId),
  );
}
