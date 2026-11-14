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
 * One Kimi turn, as huginn needs it.
 *
 * Text only, for the same reason as the Qwen and Claude drivers: the driver
 * declares `structuredEvents: false`, and the conformance contract allows such a
 * driver to emit only `text`, `done` or `error`.
 */
export interface KimiTurnHandle {
  run(prompt: string, options?: { model?: string; timeoutMs?: number }): Promise<string>;
  abort(): void;
  /** Release the underlying CLI session, when the adapter owns one. */
  close?(): Promise<void>;
}

/**
 * The Kimi agent SDK, narrowed to what the driver uses.
 *
 * The SDK speaks a wire protocol to the Kimi Code CLI, so `probe` asks whether
 * that CLI has credentials — a runtime that cannot authenticate is unavailable
 * with an actionable reason, not a mystery at prompt time.
 */
export interface KimiSdkAdapter {
  probe(): Promise<void>;
  startTurn(options: {
    cwd?: string;
    model?: string;
    permissions?: "auto" | "ask" | "deny";
  }): Promise<KimiTurnHandle>;
}

const CAPABILITIES: RuntimeCapabilities = {
  inProcess: false,
  structuredEvents: false,
  streaming: false,
  // The wire protocol has an ApprovalRequest, but huginn does not answer it yet;
  // an unattended caller must pass `auto` or the turn fails closed (below).
  permissions: "none",
  sessionHistory: true,
  sessionResume: false,
  modelCatalog: "none",
  structuredOutput: false,
  usageCost: false,
  mcpListing: false,
  interrupt: true,
  filesystemIsolation: "worktree",
};

/** The Kimi driver. */
export function createKimiSdkPort(adapter: KimiSdkAdapter = createDefaultKimiAdapter()): RuntimePort {
  return {
    id: "kimi",
    target: "kimi",
    name: "Kimi Code (SDK)",
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
        reason: "the Kimi agent SDK exposes no model catalog; pass a model id explicitly",
      };
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
            const text = await turn.run(request.text, {
              model: request.model,
              timeoutMs: request.timeoutMs,
            });
            if (text) sink?.({ type: "text", text });
            const result = { messageId: id + ":last", text };
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
          await turn.close?.();
        },
      };
    },
  };
}

/** `provider/model` -> the bare id the CLI expects. */
export function kimiModelId(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  const slash = reference.indexOf("/");
  return slash >= 0 ? reference.slice(slash + 1) : reference;
}

/** The real SDK behind the seam. */
export function createDefaultKimiAdapter(): KimiSdkAdapter {
  async function sdk() {
    return import("@moonshot-ai/kimi-agent-sdk");
  }

  return {
    async probe() {
      const { isLoggedIn } = await sdk();
      if (!isLoggedIn()) {
        throw new Error("kimi is not logged in; run kimi login (or kimi auth) first");
      }
    },

    async startTurn({ cwd, model, permissions }) {
      const { createSession, isLoggedIn } = await sdk();
      // Selecting a runtime probes once, but a direct `--agent kimi` skips that:
      // without credentials the CLI would sit waiting on auth until the timeout,
      // so fail now with the same actionable sentence.
      if (!isLoggedIn()) {
        throw new Error("kimi is not logged in; run kimi login (or kimi auth) first");
      }
      const session = createSession({
        workDir: cwd ?? process.cwd(),
        ...(kimiModelId(model) ? { model: kimiModelId(model) } : {}),
        // Only an explicit unattended caller gets auto-approval; the default keeps
        // the CLI's own policy and a request huginn cannot answer fails closed.
        ...(permissions === "auto" ? { yoloMode: true } : {}),
      });
      let active: { interrupt(): Promise<void> } | undefined;

      return {
        abort() {
          void active?.interrupt().catch(() => undefined);
        },
        async close() {
          await session.close();
        },
        async run(prompt: string, options?: { model?: string; timeoutMs?: number }) {
          if (options?.model) session.model = kimiModelId(options.model);
          const turn = session.prompt(prompt);
          active = turn;
          const timeoutMs = options?.timeoutMs;
          const timer =
            timeoutMs && timeoutMs > 0
              ? setTimeout(() => void turn.interrupt().catch(() => undefined), timeoutMs)
              : undefined;
          try {
            let text = "";
            for await (const event of turn as AsyncIterable<{
              type?: string;
              payload?: { type?: string; text?: string; requestId?: string };
            }>) {
              if (event.type === "ContentPart" && event.payload?.type === "text") {
                text += event.payload.text ?? "";
              }
              if (event.type === "ApprovalRequest") {
                // No approval channel is wired: refusing to answer silently would
                // hang the turn, so stop it and say what to do instead.
                await turn.interrupt().catch(() => undefined);
                throw new Error(
                  "kimi asked for tool approval, which huginn cannot answer yet; re-run with --permissions auto",
                );
              }
            }
            const result = await turn.result;
            if (result.status !== "finished") {
              throw new Error("kimi turn " + result.status);
            }
            return text;
          } catch (err) {
            if (timer) {
              // A timeout surfaces as an interrupted turn; keep the clearer cause.
              throw new Error("kimi turn timed out after " + timeoutMs + "ms");
            }
            throw err;
          } finally {
            if (timer) clearTimeout(timer);
            if (active === turn) active = undefined;
          }
        },
      };
    },
  };
}
