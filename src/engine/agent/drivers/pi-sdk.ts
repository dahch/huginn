import type { ModelCatalog, ModelInfo } from "../types.js";
import type {
  Availability,
  RuntimeCapabilities,
  RuntimePort,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../port.js";

/** The slice of a pi session huginn needs. */
export interface PiSessionHandle {
  readonly id: string;
  /** Run one turn and resolve with the assistant's final text. */
  prompt(text: string): Promise<string>;
  /**
   * Switch the model for the next turns, without persisting it to pi's own
   * settings. huginn passes the model **per prompt** (thinker for fixes, executor
   * for everything else), so a driver that drops it silently runs whatever pi has
   * configured.
   */
  setModel?(reference: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The pi SDK, narrowed to what the driver uses.
 *
 * A seam, not a leak: tests inject a fake, and the default implementation is the
 * only place that imports `@earendil-works/pi-coding-agent`, so the driver stays
 * unit-testable without credentials or a provider.
 */
export interface PiSdkAdapter {
  createSession(options: { cwd?: string; model?: string }): Promise<PiSessionHandle>;
  listModels(): Promise<ModelInfo[]>;
}

const CAPABILITIES: RuntimeCapabilities = {
  // The agent loop runs in huginn's own process: no CLI, no daemon.
  inProcess: true,
  // Event mapping (text deltas, tool calls, usage) lands with the engine switch.
  structuredEvents: false,
  streaming: false,
  // pi's approval UI is extension-driven; until huginn feeds it, `ask|deny` must
  // keep failing closed rather than pretending to be honoured.
  permissions: "none",
  sessionHistory: true,
  sessionResume: false,
  modelCatalog: "dynamic",
  structuredOutput: false,
  usageCost: false,
  mcpListing: false,
  interrupt: true,
};

/** Split huginn's canonical `provider/model` reference. */
function splitReference(reference: string): { provider: string; model: string } | undefined {
  const value = reference.trim();
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

/**
 * The in-process pi driver.
 *
 * Advertised capabilities are deliberately conservative for this first cut: the
 * session is real (it keeps history and survives across prompts), but events,
 * permissions and resume are not wired yet, so they are declared `false` rather
 * than promised and dropped.
 */
export function createPiSdkPort(adapter: PiSdkAdapter = createDefaultPiAdapter()): RuntimePort {
  return {
    id: "pi",
    name: "Pi (in-process)",
    capabilities: CAPABILITIES,

    async isAvailable(): Promise<Availability> {
      try {
        const models = await adapter.listModels();
        if (models.length > 0) return { ok: true };
        return {
          ok: false,
          reason: "the pi SDK is installed but exposes no available model; run `pi` once to sign in",
        };
      } catch (err) {
        return {
          ok: false,
          reason: `the pi SDK could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    async listModels(): Promise<ModelCatalog> {
      try {
        const models = await adapter.listModels();
        return models.length > 0 ? { models } : { models: [], reason: "pi reported no available model" };
      } catch (err) {
        return { models: [], reason: err instanceof Error ? err.message : String(err) };
      }
    },

    resolveModel(reference: string) {
      const parsed = splitReference(reference);
      return parsed
        ? { ok: true as const, model: `${parsed.provider}/${parsed.model}` }
        : { ok: false as const, reason: 'expected a "provider/model" reference (for example "anthropic/claude-opus-4-5")' };
    },

    async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
      const handle = await adapter.createSession({
        cwd: options.directory,
        model: options.model,
      });
      const sink = options.sink;
      return {
        id: handle.id,
        resumable: false,
        async prompt(request) {
          try {
            // The engine asks for a model on every prompt; honour it or fail, never
            // fall back to pi's own setting in silence (that is how the TUI came to
            // show DeepSeek while the API billed Claude).
            if (request.model) {
              if (!handle.setModel) {
                throw new Error(
                  `the pi driver cannot switch models per prompt (asked for "${request.model}")`,
                );
              }
              await handle.setModel(request.model);
            }
            const text = await handle.prompt(request.text);
            const result = { messageId: `${handle.id}:last`, text };
            if (text) sink?.({ type: "text", text });
            sink?.({ type: "done", result });
            return result;
          } catch (err) {
            sink?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
            throw err;
          }
        },
        async interrupt() {
          await handle.interrupt();
        },
        async close() {
          await handle.dispose();
        },
      };
    },
  };
}

/**
 * The real SDK behind the seam.
 *
 * `import()` keeps the 23 MB package out of the startup path, and every call is
 * typed by the SDK's own declarations, so a breaking change in the package shows
 * up as a typecheck failure rather than at runtime.
 */
export function createDefaultPiAdapter(): PiSdkAdapter {
  let runtimePromise: Promise<import("@earendil-works/pi-coding-agent").ModelRuntime> | undefined;

  async function sdk() {
    return import("@earendil-works/pi-coding-agent");
  }

  async function modelRuntime() {
    if (!runtimePromise) {
      runtimePromise = sdk().then((pi) => pi.ModelRuntime.create({}));
    }
    return runtimePromise;
  }

  return {
    async createSession({ cwd, model }) {
      const pi = await sdk();
      const runtime = await modelRuntime();
      const resolved = model ? pi.resolveCliModel({ ...splitReferenceOrThrow(model), modelRuntime: runtime }) : undefined;
      const { session } = await pi.createAgentSession({
        cwd,
        model: resolved?.model,
        modelRuntime: runtime,
      });
      const stats = session.getSessionStats();
      // What the session currently runs; `undefined` means pi's own default.
      let appliedModel: string | undefined = model;
      return {
        id: stats.sessionId,
        async setModel(reference: string) {
          const wanted = reference.trim();
          if (wanted === appliedModel) return;
          const ticked = pi.resolveCliModel({
            ...splitReferenceOrThrow(wanted),
            modelRuntime: runtime,
          });
          if (!ticked.model) {
            throw new Error(ticked.error ?? `pi cannot resolve the model "${wanted}"`);
          }
          // `persist: false` keeps this a session choice: switching the executor
          // must never rewrite the model the user has configured in pi itself.
          await session.setModel(ticked.model, { persist: false });
          appliedModel = wanted;
        },
        async prompt(text: string) {
          await session.prompt(text);
          await session.waitForIdle();
          return session.getLastAssistantText() ?? "";
        },
        async interrupt() {
          await session.abort();
        },
        async dispose() {
          session.dispose();
        },
      };
    },

    async listModels() {
      const pi = await sdk();
      const runtime = await modelRuntime();
      const registry = new pi.ModelRegistry(runtime);
      await registry.refresh();
      return registry.getAvailable().map((entry) => ({
        id: `${entry.provider}/${entry.id}`,
        name: entry.name ?? entry.id,
        provider: entry.provider,
      }));
    },
  };
}

function splitReferenceOrThrow(reference: string): { cliProvider: string; cliModel: string } {
  const parsed = splitReference(reference);
  if (!parsed) throw new Error(`expected a "provider/model" reference, got "${reference}"`);
  return { cliProvider: parsed.provider, cliModel: parsed.model };
}
