import { randomUUID } from "node:crypto";
import type { ModelCatalog } from "../types.js";
import type {
  Availability,
  RuntimeCapabilities,
  RuntimePort,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../port.js";

/** The slice of a Codex thread huginn needs. */
export interface CodexThreadHandle {
  /** The provider's thread id, known only after the first turn. */
  currentId(): string | null;
  run(prompt: string): Promise<string>;
}

/**
 * The Codex SDK, narrowed to what the driver uses.
 *
 * Same seam as the pi driver: the default implementation is the only place that
 * imports `@openai/codex-sdk`, so the driver is unit-testable without the CLI,
 * credentials or a provider.
 */
export interface CodexSdkAdapter {
  /** Resolve the SDK (and its bundled CLI) without starting a turn. */
  probe(): Promise<void>;
  startThread(options: { model?: string }): Promise<CodexThreadHandle>;
}

const CAPABILITIES: RuntimeCapabilities = {
  // Codex runs through its app-server child process, not in huginn's loop.
  inProcess: false,
  structuredEvents: false,
  streaming: false,
  // Approvals live in the SDK's thread options; huginn does not feed them yet,
  // so `ask|deny` keeps failing closed.
  permissions: "none",
  // Threads are persisted under ~/.codex/sessions and continue across turns.
  sessionHistory: true,
  sessionResume: false,
  modelCatalog: "none",
  structuredOutput: false,
  usageCost: false,
  mcpListing: false,
  // The SDK exposes no abort for a running turn.
  interrupt: false,
};

/**
 * The Codex driver.
 *
 * `sessionHistory` is the only capability claimed beyond the basics, and it is
 * the real thing: a `Thread` keeps the conversation server-side. Resume by id is
 * possible in the SDK but not wired here, so it is not advertised.
 */
export function createCodexSdkPort(adapter: CodexSdkAdapter = createDefaultCodexAdapter()): RuntimePort {
  return {
    id: "codex",
    name: "Codex (SDK)",
    capabilities: CAPABILITIES,

    async isAvailable(): Promise<Availability> {
      try {
        await adapter.probe();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async listModels(): Promise<ModelCatalog> {
      return { models: [], reason: "the Codex SDK exposes no model catalog; pass a model id explicitly" };
    },

    resolveModel(reference: string) {
      const model = reference.trim();
      return model === ""
        ? { ok: false as const, reason: "the model reference is empty" }
        : { ok: true as const, model };
    },

    async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
      const thread = await adapter.startThread({ model: options.model });
      const sink = options.sink;
      // The provider id is null until the first turn, so huginn's handle is its
      // own: a session must have an id before it has run anything.
      const id = randomUUID();
      return {
        id,
        resumable: false,
        async prompt(request) {
          try {
            const text = await thread.run(request.text);
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
          // Not supported by the SDK; a no-op is the honest behaviour and the
          // capability says so, so no surface offers the button.
        },
        async close() {
          // The thread owns no handle huginn must release.
        },
      };
    },
  };
}

/** The real SDK behind the seam. */
export function createDefaultCodexAdapter(): CodexSdkAdapter {
  async function sdk() {
    return import("@openai/codex-sdk");
  }

  return {
    async probe() {
      const { Codex } = await sdk();
      // Constructing the client is what surfaces a missing bundled CLI.
      new Codex();
    },

    async startThread({ model }) {
      const { Codex } = await sdk();
      const codex = new Codex();
      const thread = codex.startThread(model ? { model } : undefined);
      return {
        currentId() {
          return thread.id;
        },
        async run(prompt: string) {
          const turn = await thread.run(prompt);
          return turn.finalResponse;
        },
      };
    },
  };
}
