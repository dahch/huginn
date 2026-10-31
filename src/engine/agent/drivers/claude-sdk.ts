import { randomUUID } from "node:crypto";
import type { ModelCatalog } from "../types.js";
import type {
  Availability,
  RuntimeCapabilities,
  RuntimePort,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../port.js";

/** One Claude Code turn, as huginn needs it. */
export interface ClaudeTurnHandle {
  /** Per-prompt model override and wall-clock bound. */
  run(prompt: string, options?: { model?: string; timeoutMs?: number }): Promise<string>;
  abort(): void;
}

/**
 * The Claude Agent SDK, narrowed to what the driver uses.
 *
 * The package is **not** open source (its licence is defined in its README) and
 * ships per-platform binaries, so it stays an external, optional dependency: the
 * import lives only here, never in the bundle.
 */
export interface ClaudeSdkAdapter {
  probe(): Promise<void>;
  startTurn(options: {
    cwd?: string;
    model?: string;
    permissions?: "auto" | "ask" | "deny";
  }): Promise<ClaudeTurnHandle>;
}

const CAPABILITIES: RuntimeCapabilities = {
  // The SDK drives the Claude Code binary; the loop is not ours.
  inProcess: false,
  structuredEvents: false,
  streaming: false,
  // Approvals need the SDK's canUseTool control channel; huginn does not feed it
  // yet, so ask|deny keeps failing closed.
  permissions: "none",
  sessionHistory: true,
  sessionResume: false,
  modelCatalog: "none",
  structuredOutput: false,
  usageCost: false,
  mcpListing: false,
  // An AbortController cancels a running query.
  interrupt: true,
};

/** The Claude driver. */
export function createClaudeSdkPort(adapter: ClaudeSdkAdapter = createDefaultClaudeAdapter()): RuntimePort {
  return {
    id: "claude",
    name: "Claude (SDK)",
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
      return { models: [], reason: "the Claude Agent SDK exposes no model catalog; pass a model id explicitly" };
    },

    resolveModel(reference: string) {
      const model = reference.trim();
      return model === ""
        ? { ok: false as const, reason: "the model reference is empty" }
        : { ok: true as const, model };
    },

    async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
      const turn = await adapter.startTurn({
        cwd: options.directory,
        model: options.model,
        permissions: options.permissions,
      });
      const sink = options.sink;
      const id = randomUUID();
      return {
        id,
        resumable: false,
        async prompt(request) {
          try {
            // Each turn is its own query, so the model the engine asks for is
            // applied without restarting the session (and without persisting it).
            const text = await turn.run(request.text, {
              model: request.model,
              timeoutMs: request.timeoutMs,
            });
            const result = { messageId: `${id}:last`, text };
            if (text) sink?.({ type: "text", text });
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
          // Nothing to release: the query closes itself when it finishes.
        },
      };
    },
  };
}

/**
 * The Claude CLI wants a bare model id (`claude-sonnet-4-...`), not huginn's
 * canonical `anthropic/...` reference. Other providers are passed through
 * unchanged so the CLI can still report a mismatch instead of a silent guess.
 */
function stripProviderPrefix(reference: string | undefined): string | undefined {
  if (!reference) return reference;
  const prefix = "anthropic/";
  return reference.startsWith(prefix) ? reference.slice(prefix.length) : reference;
}

/** The real SDK behind the seam. */
export function createDefaultClaudeAdapter(): ClaudeSdkAdapter {
  async function sdk() {
    return import("@anthropic-ai/claude-agent-sdk");
  }

  return {
    async probe() {
      await sdk();
    },

    async startTurn({ cwd, model, permissions }) {
      const { query } = await sdk();
      // The CLI's own session id, captured from the result stream so later turns
      // of the *same* huginn session resume the conversation instead of starting
      // over (the SDK's `resume` option).
      let sessionId: string | undefined;
      let controller: AbortController | undefined;
      return {
        abort() {
          controller?.abort();
        },
        async run(prompt: string, options?: { model?: string; timeoutMs?: number }) {
          // A fresh controller per turn: aborting a timed-out turn must not
          // poison the next one.
          controller = new AbortController();
          const active = controller;
          const timeoutMs = options?.timeoutMs;
          const timer =
            timeoutMs && timeoutMs > 0 ? setTimeout(() => active.abort(), timeoutMs) : undefined;
          const requestedModel = stripProviderPrefix(options?.model ?? model);
          try {
            const stream = query({
              prompt,
              options: {
                cwd,
                ...(requestedModel ? { model: requestedModel } : {}),
                abortController: active,
                ...(sessionId ? { resume: sessionId } : {}),
                ...(permissions === "auto"
                  ? {
                      permissionMode: "bypassPermissions" as const,
                      allowDangerouslySkipPermissions: true,
                    }
                  : {}),
              },
            });
            let text = "";
            for await (const message of stream) {
              const id = (message as { session_id?: unknown }).session_id;
              if (typeof id === "string" && id.length > 0) sessionId = id;
              if (message.type === "result" && message.subtype === "success") {
                text = message.result;
              }
            }
            return text;
          } catch (err) {
            if (active.signal.aborted && timeoutMs) {
              throw new Error(`claude turn timed out after ${timeoutMs}ms`);
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
