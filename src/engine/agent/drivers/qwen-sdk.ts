import { randomUUID } from "node:crypto";
import type { ModelCatalog } from "../types.js";
import type {
  Availability,
  RuntimeCapabilities,
  RuntimePort,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../port.js";

/**
 * One Qwen Code turn, as huginn needs it.
 *
 * Returns text for the same reason the Claude driver does: the driver declares
 * `structuredEvents: false`, and the conformance contract only lets such a
 * driver emit `text`, `done` or `error`.
 */
export interface QwenTurnHandle {
  run(prompt: string, options?: { model?: string; timeoutMs?: number }): Promise<string>;
  abort(): void;
}

/**
 * The Qwen Code SDK, narrowed to what the driver uses.
 *
 * The SDK bundles the CLI, so there is no binary to find: `probe` loads the
 * module, and the first turn is what proves credentials.
 */
export interface QwenSdkAdapter {
  probe(): Promise<void>;
  startTurn(options: {
    cwd?: string;
    model?: string;
    permissions?: "auto" | "ask" | "deny";
    /** Asked before a tool runs; resolved `false` means deny (fail closed). */
    onPermission?: (request: { tool: string; detail?: string }) => Promise<boolean>;
  }): Promise<QwenTurnHandle>;
}

const CAPABILITIES: RuntimeCapabilities = {
  // The SDK spawns the bundled CLI; the loop is not ours.
  inProcess: false,
  structuredEvents: false,
  streaming: false,
  // `canUseTool` is wired through the session's PermissionHandler; an unanswered
  // request denies.
  permissions: "interactive",
  sessionHistory: true,
  sessionResume: false,
  modelCatalog: "none",
  structuredOutput: false,
  usageCost: false,
  mcpListing: false,
  // An AbortController cancels a running query.
  interrupt: true,
  // The worktree is where the agent is pointed; nothing stops it writing
  // elsewhere.
  filesystemIsolation: "worktree",
};

/** The Qwen driver. */
export function createQwenSdkPort(adapter: QwenSdkAdapter = createDefaultQwenAdapter()): RuntimePort {
  return {
    id: "qwen",
    target: "qwen",
    name: "Qwen Code (SDK)",
    capabilities: CAPABILITIES,

    async isAvailable(): Promise<Availability> {
      try {
        await adapter.probe();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async listModels(): Promise<ModelCatalog> {
      return {
        models: [],
        reason: "the Qwen Code SDK exposes no model catalog; pass a model id explicitly",
      };
    },

    resolveModel(reference: string) {
      const model = reference.trim();
      return model === ""
        ? { ok: false as const, reason: "the model reference is empty" }
        : { ok: true as const, model };
    },

    async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
      const sink = options.sink;
      const id = randomUUID();
      let asked = 0;
      const onPermission = options.onPermission
        ? async (request: { tool: string; detail?: string }): Promise<boolean> => {
            const permissionRequest = {
              id: `${id}:perm:${(asked += 1)}`,
              title: request.tool,
              detail: request.detail,
            };
            sink?.({ type: "permission.request", request: permissionRequest });
            const decision = await options.onPermission!(permissionRequest);
            return decision !== "deny";
          }
        : undefined;
      const turn = await adapter.startTurn({
        cwd: options.directory,
        model: options.model,
        permissions: options.permissions,
        onPermission,
      });
      return {
        id,
        resumable: false,
        async prompt(request) {
          try {
            const text = await turn.run(request.text, {
              model: request.model,
              timeoutMs: request.timeoutMs,
            });
            if (text) sink?.({ type: "text", text });
            const result = { messageId: `${id}:last`, text };
            sink?.({ type: "done", result });
            return result;
          } catch (err) {
            sink?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
            throw err;
          }
        },
        async interrupt() {
          turn.abort();
        },
        async close() {
          // The query closes itself when the turn finishes.
        },
      };
    },
  };
}

/**
 * The Qwen SDK wants a bare model id, not huginn's canonical `provider/model`.
 * Only the provider prefix is removed; the rest is passed through so the CLI can
 * report a real mismatch instead of a silent guess.
 */
export function qwenModelId(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  const slash = reference.indexOf("/");
  return slash >= 0 ? reference.slice(slash + 1) : reference;
}

/** The real SDK behind the seam. */
export function createDefaultQwenAdapter(): QwenSdkAdapter {
  async function sdk() {
    return import("@qwen-code/sdk");
  }

  return {
    async probe() {
      await sdk();
    },

    async startTurn({ cwd, model, permissions, onPermission }) {
      const { query } = await sdk();
      let controller: AbortController | undefined;
      return {
        abort() {
          controller?.abort();
        },
        async run(prompt: string, options?: { model?: string; timeoutMs?: number }) {
          controller = new AbortController();
          const active = controller;
          const timeoutMs = options?.timeoutMs;
          const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => active.abort(), timeoutMs) : undefined;
          try {
            const stream = query({
              prompt,
              options: {
                cwd,
                ...(qwenModelId(options?.model ?? model)
                  ? { model: qwenModelId(options?.model ?? model) }
                  : {}),
                abortController: active,
                // Only a caller that asked for unattended mode gets it; the
                // default stays the CLI's own default (ask), and an unanswerable
                // prompt then fails closed instead of silently editing.
                ...(permissions === "auto" ? { permissionMode: "auto" as const } : {}),
                // Only a caller with an answerer gets the control channel.
                ...(onPermission && permissions !== "auto"
                  ? {
                      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
                        const allowed = await onPermission({ tool: toolName });
                        return allowed
                          ? { behavior: "allow" as const, updatedInput: input }
                          : { behavior: "deny" as const, message: "denied by huginn" };
                      },
                    }
                  : {}),
              },
            });
            let text = "";
            for await (const message of stream as AsyncIterable<{
              type?: string;
              subtype?: string;
              result?: string;
              error?: unknown;
            }>) {
              if (message.type === "result") {
                if (message.subtype && message.subtype !== "success") {
                  // The SDK puts the provider's own words under `error.message`
                  // (a 401 surfaces there). Keeping that text is the difference
                  // between "qwen failed" and "fix your credentials".
                  const detail =
                    typeof message.error === "string"
                      ? message.error
                      : (message.error as { message?: unknown } | undefined)?.message;
                  throw new Error(
                    typeof detail === "string" && detail.length > 0
                      ? `qwen turn failed: ${detail}`
                      : `qwen turn failed (${message.subtype})`,
                  );
                }
                text = message.result ?? text;
              }
            }
            return text;
          } catch (err) {
            if (active.signal.aborted && timeoutMs) {
              throw new Error(`qwen turn timed out after ${timeoutMs}ms`);
            }
            throw err;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      };
    },
  };
}
