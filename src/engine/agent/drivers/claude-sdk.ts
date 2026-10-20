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
  run(prompt: string): Promise<string>;
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
  startTurn(options: { cwd?: string; model?: string }): Promise<ClaudeTurnHandle>;
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
      const turn = await adapter.startTurn({ cwd: options.directory, model: options.model });
      const sink = options.sink;
      const id = randomUUID();
      return {
        id,
        resumable: false,
        async prompt(request) {
          try {
            const text = await turn.run(request.text);
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

/** The real SDK behind the seam. */
export function createDefaultClaudeAdapter(): ClaudeSdkAdapter {
  async function sdk() {
    return import("@anthropic-ai/claude-agent-sdk");
  }

  return {
    async probe() {
      await sdk();
    },

    async startTurn({ cwd, model }) {
      const { query } = await sdk();
      const controller = new AbortController();
      return {
        abort() {
          controller.abort();
        },
        async run(prompt: string) {
          const stream = query({
            prompt,
            options: {
              cwd,
              model,
              abortController: controller,
            },
          });
          let text = "";
          for await (const message of stream) {
            if (message.type === "result" && message.subtype === "success") {
              text = message.result;
            }
          }
          return text;
        },
      };
    },
  };
}
