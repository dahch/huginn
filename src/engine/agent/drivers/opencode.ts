import type { OpencodeClient } from "@opencode-ai/sdk";
import type { AgentTarget } from "../../../agents/integrator.js";
import {
  abortSession as clientAbortSession,
  createSession as clientCreateSession,
  prompt as clientPrompt,
  probeSession as clientProbeSession,
  rejectQuestion,
  respondPermission,
  respondQuestion,
} from "../../../server/client.js";
import { events } from "../../engineEvents.js";
import { resolveModel } from "../../modelRouter.js";
import { sanitizeTerminalText } from "../../../util/text.js";
import { OpencodeRuntimeAdapter } from "../adapters/opencode.js";
import type {
  EventSink,
  PermissionHandler,
  QuestionHandler,
  RuntimeCapabilities,
  RuntimePort,
  RuntimePromptRequest,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../port.js";
import type { McpServerListing, McpStatusReport, ModelCatalog, PromptResult } from "../types.js";

export interface OpencodePortOptions {
  client?: OpencodeClient;
  baseUrl?: string;
  projectPath?: string;
  port?: number;
  serverTimeoutMs?: number;
  target?: AgentTarget;
  modelsCommand?: string;
  modelsTimeoutMs?: number;
  mcpListCommand?: string;
  mcpListTimeoutMs?: number;
  env?: Record<string, string | undefined>;
}

const CAPABILITIES: RuntimeCapabilities = {
  inProcess: false,
  structuredEvents: true,
  streaming: true,
  permissions: "interactive",
  sessionHistory: true,
  sessionResume: true,
  modelCatalog: "dynamic",
  structuredOutput: false,
  usageCost: true,
  mcpListing: true,
  interrupt: true,
  // The worktree is where the agent is pointed; nothing stops it
  // writing elsewhere.
  filesystemIsolation: "worktree",
};

interface SessionRegistration {
  sink?: EventSink;
  onPermission?: PermissionHandler;
  onQuestion?: QuestionHandler;
  permissions?: "auto" | "ask" | "deny";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The native `RuntimePort` for opencode.
 *
 * It owns one SSE subscription and fans it out to the registered sessions, so
 * the engine's per-phase sessions receive typed deltas without the CLI wiring a
 * second subscriber (two subscribers would emit every delta twice). Model
 * discovery, the MCP listing and the supervised daemon are delegated to the
 * existing adapter — that code is unchanged, not reimplemented.
 *
 * The port is the only runtime that truthfully declares streaming, structured
 * events, interactive permissions, session history and session resume.
 */
export function createOpencodePort(options: OpencodePortOptions = {}): RuntimePort {
  const legacy = new OpencodeRuntimeAdapter(options);
  const registrations = new Map<string, SessionRegistration>();
  const streamedTextLen = new Map<string, number>();
  const seenToolStatus = new Map<string, string>();
  let client: OpencodeClient | undefined = options.client;
  let pumpStarted = false;
  let closed = false;

  const ensureClient = (): OpencodeClient => {
    if (!client) client = legacy.client;
    return client;
  };

  const responseFor = async (
    sessionId: string,
    permissionId: string,
    decision: "allow-once" | "allow-always" | "deny",
  ): Promise<void> => {
    const response = decision === "deny" ? "reject" : decision === "allow-once" ? "once" : "always";
    try {
      await respondPermission(ensureClient(), sessionId, permissionId, response);
    } catch (err) {
      events.emit("log", {
        level: "error",
        message: `failed to respond to permission: ${sanitizeTerminalText(messageOf(err))}`,
      });
    }
  };

  const handleEvent = async (ev: unknown): Promise<void> => {
    const event = ev as { type?: string; properties?: Record<string, unknown> } | undefined;
    if (!event || typeof event.type !== "string") return;

    switch (event.type) {
      case "permission.updated":
      case "permission.asked":
      case "permission.v2.asked": {
        const p = event.properties as {
          id?: string;
          sessionID?: string;
          title?: string;
        };
        if (!p?.id || !p.sessionID) return;
        const registration = registrations.get(p.sessionID);
        const title = sanitizeTerminalText(p.title ?? p.id);
        registration?.sink?.({ type: "permission.request", request: { id: p.id, title } });
        if (registration?.onPermission) {
          const decision = await registration.onPermission({ id: p.id, title });
          await responseFor(p.sessionID, p.id, decision);
        } else if (registration?.permissions === "auto") {
          await responseFor(p.sessionID, p.id, "allow-always");
        } else {
          // No handler and no auto mode: fail closed.
          await responseFor(p.sessionID, p.id, "deny");
        }
        return;
      }
      case "question.asked":
      case "question.v2.asked":
      case "question.updated": {
        const p = event.properties as {
          id?: string;
          sessionID?: string;
          questions?: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
        };
        if (!p?.id || !p.sessionID) return;
        const registration = registrations.get(p.sessionID);
        const questions = p.questions ?? [];
        const answers = questions.map((q) =>
          q.options && q.options.length > 0 ? [q.options[0]!.label] : ["continue"],
        );
        try {
          if (registration?.onQuestion) {
            const answer = await registration.onQuestion({
              id: p.id,
              sessionId: p.sessionID,
              questions,
            });
            if (answer === "deny") {
              await rejectQuestion(ensureClient(), p.sessionID, p.id);
            } else {
              await respondQuestion(ensureClient(), p.sessionID, p.id, answer.answers);
            }
          } else if (registration?.permissions === "auto") {
            await respondQuestion(ensureClient(), p.sessionID, p.id, answers);
          } else {
            await rejectQuestion(ensureClient(), p.sessionID, p.id);
          }
        } catch (err) {
          events.emit("log", {
            level: "warn",
            message: `failed to answer question: ${sanitizeTerminalText(messageOf(err))}`,
          });
        }
        return;
      }
      case "message.part.updated": {
        const properties = event.properties as {
          part?: {
            id?: string;
            type?: string;
            text?: string;
            tool?: string;
            state?: { status?: string; title?: string; input?: unknown; error?: string };
            sessionID?: string;
          };
        };
        const part = properties?.part;
        if (!part?.id) return;
        const registration = part.sessionID ? registrations.get(part.sessionID) : undefined;
        const sink = registration?.sink;
        if (!sink) return;

        if (part.type === "text" || part.type === "reasoning") {
          const text = part.text ?? "";
          const start = streamedTextLen.get(part.id) ?? 0;
          if (text.length > start) {
            streamedTextLen.set(part.id, text.length);
            sink({ type: part.type === "text" ? "text" : "reasoning", text: text.slice(start) });
          }
          return;
        }
        if (part.type === "tool") {
          const status = part.state?.status;
          if (!status || status === seenToolStatus.get(part.id)) return;
          seenToolStatus.set(part.id, status);
          const name = part.tool ?? "tool";
          if (status === "running") {
            const detail = part.state?.title
              ? part.state.title
              : part.state?.input
                ? JSON.stringify(part.state.input).slice(0, 80)
                : undefined;
            sink({ type: "tool.start", name, detail });
          } else if (status === "completed") {
            sink({ type: "tool.end", name, ok: true });
          } else if (status === "error") {
            sink({ type: "tool.end", name, ok: false, detail: part.state?.error });
          }
        }
        return;
      }
      case "message.updated": {
        const info = (event.properties as {
          info?: {
            role?: string;
            sessionID?: string;
            tokens?: { input?: number; output?: number };
            cost?: number;
          };
        })?.info;
        if (info?.role !== "assistant" || !info.sessionID) return;
        const sink = registrations.get(info.sessionID)?.sink;
        if (!sink) return;
        const inputTokens = info.tokens?.input;
        const outputTokens = info.tokens?.output;
        const costUsd = info.cost;
        if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return;
        sink({ type: "usage", inputTokens, outputTokens, costUsd });
        return;
      }
      default:
        return;
    }
  };

  const startPump = (): void => {
    if (pumpStarted) return;
    pumpStarted = true;
    const activeClient = ensureClient();
    if (typeof activeClient.event?.subscribe !== "function") return;
    void (async () => {
      try {
        const sse = await activeClient.event.subscribe();
        for await (const ev of sse.stream as AsyncGenerator<unknown>) {
          if (closed) break;
          await handleEvent(ev);
        }
      } catch (err) {
        if (!closed) {
          events.emit("log", {
            level: "warn",
            message: `opencode event stream ended: ${sanitizeTerminalText(messageOf(err))}`,
          });
        }
      }
    })();
  };

  const makeSession = (
    id: string,
    defaultDirectory: string | undefined,
    registration: SessionRegistration,
  ): RuntimeSession => {
    registrations.set(id, registration);
    const activeClient = ensureClient();

    return {
      id,
      resumable: true,

      async prompt(request: RuntimePromptRequest): Promise<PromptResult> {
        const modelRef = request.model
          ? request.model.includes("/")
            ? resolveModel(request.model)
            : { providerID: "default", modelID: request.model }
          : undefined;
        try {
          const result = await clientPrompt(activeClient, id, {
            text: request.text,
            agent: request.agent,
            model: modelRef,
            timeoutMs: request.timeoutMs,
            directory: request.directory ?? defaultDirectory,
          });
          registration.sink?.({ type: "done", result });
          return result;
        } catch (err) {
          registration.sink?.({ type: "error", message: messageOf(err) });
          throw err;
        }
      },

      async interrupt(): Promise<void> {
        await clientAbortSession(activeClient, id);
      },

      async close(): Promise<void> {
        // Never abort: closing a handle must not kill a turn the engine may
        // still retry. `withPhaseSession` is the owner of the lifecycle.
        registrations.delete(id);
        if (registrations.size === 0) {
          streamedTextLen.clear();
          seenToolStatus.clear();
        }
      },
    };
  };

  const port: RuntimePort = {
    id: "opencode",
    name: "OpenCode",
    target: options.target ?? "opencode",
    capabilities: CAPABILITIES,

    async isAvailable() {
      if (client) return { ok: true };
      const available = await legacy.isAvailable();
      return available
        ? { ok: true }
        : { ok: false, reason: "the opencode binary is not installed or is not on PATH" };
    },

    listModels(): Promise<ModelCatalog> {
      return legacy.getModelCatalog();
    },

    resolveModel(reference: string) {
      const model = reference.trim();
      return model === ""
        ? { ok: false, reason: "the model reference is empty" }
        : { ok: true, model };
    },

    async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
      const created = await clientCreateSession(ensureClient(), options.title, options.directory);
      startPump();
      return makeSession(created.id, options.directory, {
        sink: options.sink,
        onPermission: options.onPermission,
        onQuestion: options.onQuestion,
        permissions: options.permissions,
      });
    },

    async start() {
      await legacy.startDaemon();
      client = legacy.client;
    },

    endpoint() {
      return legacy.serverUrl;
    },

    async resumeSession(id: string, options: RuntimeSessionOptions): Promise<RuntimeSession> {
      startPump();
      return makeSession(id, options.directory, {
        sink: options.sink,
        onPermission: options.onPermission,
        onQuestion: options.onQuestion,
        permissions: options.permissions,
      });
    },

    probeSession(id: string) {
      return clientProbeSession(ensureClient(), id);
    },

    async abortSession(id: string) {
      await clientAbortSession(ensureClient(), id);
    },

    listMcpServers(): Promise<McpServerListing[]> {
      return legacy.listMcpServers();
    },

    mcpStatus(): Promise<McpStatusReport> {
      return legacy.getMcpStatus();
    },

    async dispose() {
      closed = true;
      registrations.clear();
      await legacy.stopDaemon();
    },
  };

  return port;
}
