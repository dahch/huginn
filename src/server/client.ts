import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
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

export function createClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    throwOnError: true,
    responseStyle: "data",
  });
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

export async function createSession(client: OpencodeClient, title: string): Promise<{ id: string }> {
  const res = await client.session.create({ body: { title } });
  return (res as unknown as { id: string });
}

export async function sessionExists(client: OpencodeClient, sessionId: string): Promise<boolean> {
  try {
    await client.session.get({ path: { id: sessionId } });
    return true;
  } catch {
    return false;
  }
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

export async function prompt(
  client: OpencodeClient,
  sessionId: string,
  opts: { text: string; agent?: string; model?: ModelRef; timeoutMs?: number },
): Promise<PromptResult> {
  const body: Record<string, unknown> = {
    parts: [textPart(opts.text)],
  };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };

  return withTimeout(
    opts.timeoutMs,
    async (signal) => {
      const res = (await client.session.prompt({
        path: { id: sessionId },
        body: body as never,
        signal: signal as AbortSignal | undefined,
      } as never)) as unknown as { info: { id: string; error?: unknown }; parts: Array<{ type?: string; text?: string }> };

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
  opts: { command: string; arguments: string; agent?: string; model?: string; timeoutMs?: number },
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
      const res = (await client.session.command({
        path: { id: sessionId },
        body: body as never,
        signal: signal as AbortSignal | undefined,
      } as never)) as unknown as { info: { id: string; error?: unknown }; parts: Array<{ type?: string; text?: string }> };

      if (res.info?.error) {
        throw new Error(`Command /${opts.command} failed: ${JSON.stringify(res.info.error)}`);
      }
      return { messageId: res.info.id, text: extractText(res.parts), raw: res };
    },
    () => void abortSession(client, sessionId),
  );
}
