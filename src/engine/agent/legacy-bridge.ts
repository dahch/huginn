import type { IAgentRuntime, IAgentSession, McpStatusReport, PromptResult } from "./types.js";
import type {
  EventSink,
  ModelResolution,
  RuntimeCapabilities,
  RuntimePort,
  RuntimeSession,
} from "./port.js";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The capabilities of a legacy `IAgentRuntime`, stated honestly.
 *
 * Only what the adapter can prove today is claimed:
 *
 * - `permissions: "none"` — a legacy adapter has no channel back mid-turn (opencode's
 *   permission handling lives in the engine's event subscriber, not in the port),
 *   so `--permissions ask|deny` must keep failing closed for it.
 * - `structuredOutput`, `usageCost` and `structuredEvents` (beyond streaming) are
 *   false: the port carries no such payload yet.
 * - `streaming` is exactly the adapter's `streamsOutput`.
 *
 * The native drivers added later flip these as they gain the ability, which is
 * what the conformance suite checks they do not fake.
 */
export function legacyCapabilities(runtime: IAgentRuntime): RuntimeCapabilities {
  const streaming = runtime.streamsOutput === true;
  return {
    inProcess: false,
    structuredEvents: streaming,
    streaming,
    permissions: "none",
    sessionHistory: runtime.sessionHistory === true,
    sessionResume: false,
    modelCatalog: "dynamic",
    structuredOutput: false,
    usageCost: false,
    mcpListing: typeof runtime.listMcpServers === "function",
    interrupt: true,
  };
}

/**
 * Wrap a legacy adapter as a {@link RuntimePort} without changing a single
 * behaviour: the same session, the same prompt, the same result.
 *
 * The bridge is the safety net for the runtime migration — every existing
 * adapter keeps working byte-identically, and a driver only leaves the bridge
 * once it implements the port natively and passes the conformance suite.
 */
export function toRuntimePort(runtime: IAgentRuntime): RuntimePort {
  const capabilities = legacyCapabilities(runtime);
  return {
    id: runtime.id,
    name: runtime.name,
    capabilities,

    async isAvailable() {
      try {
        return (await runtime.isAvailable())
          ? { ok: true }
          : {
              ok: false,
              reason: `the "${runtime.id}" runtime is not installed or is not on PATH`,
            };
      } catch (err) {
        return { ok: false, reason: messageOf(err) };
      }
    },

    async listModels() {
      try {
        return typeof runtime.getModelCatalog === "function"
          ? await runtime.getModelCatalog()
          : { models: await runtime.getAvailableModels() };
      } catch (err) {
        return { models: [], reason: messageOf(err) };
      }
    },

    resolveModel(reference: string): ModelResolution {
      const model = reference.trim();
      return model === ""
        ? { ok: false, reason: "the model reference is empty" }
        : { ok: true, model };
    },

    async createSession(options) {
      const session = await runtime.createSession({
        title: options.title,
        directory: options.directory,
        model: options.model,
        agent: options.agent,
      });
      return bridgeSession(session, options.sink);
    },

    async dispose() {
      await runtime.stopDaemon?.();
    },
  };
}

/** One legacy session behind a {@link RuntimeSession}. */
function bridgeSession(session: IAgentSession, sink?: EventSink): RuntimeSession {
  return {
    id: session.id,
    resumable: false,

    async prompt(request): Promise<PromptResult> {
      try {
        const result = await session.prompt(request.text, {
          model: request.model,
          agent: request.agent,
          timeoutMs: request.timeoutMs,
          directory: request.directory,
        });
        // A legacy adapter resolves once: the whole answer is one `text` event,
        // never a stream (the streaming capability stays false).
        if (result.text) sink?.({ type: "text", text: result.text });
        sink?.({ type: "done", result });
        return result;
      } catch (err) {
        sink?.({ type: "error", message: messageOf(err) });
        throw err;
      }
    },

    async interrupt() {
      await session.abort();
    },

    async close() {
      // A legacy session owns no resource the caller must release: the adapter
      // either talks to the shared opencode daemon or spawns a short-lived CLI.
    },
  };
}

/**
 * Present a {@link RuntimePort} as the legacy `IAgentRuntime` the engine still
 * consumes.
 *
 * The other direction of the bridge: it lets a native driver (today pi) run on
 * the production path without rewriting `CycleEngine`/`LiveEngine` first. What it
 * cannot do is invent a channel the legacy interface has no room for — events
 * are dropped, and `streamsOutput` mirrors `capabilities.streaming` so no surface
 * waits for output that will not arrive.
 */
export function toLegacyRuntime(port: RuntimePort): IAgentRuntime {
  const capabilities = port.capabilities;
  return {
    id: port.id as IAgentRuntime["id"],
    name: port.name,
    sessionHistory: capabilities.sessionHistory,
    streamsOutput: capabilities.streaming,

    async isAvailable() {
      return (await port.isAvailable()).ok;
    },

    async getAvailableModels() {
      return (await port.listModels()).models;
    },

    async getModelCatalog() {
      return port.listModels();
    },

    async getMcpStatus(): Promise<McpStatusReport> {
      // A native driver owns no MCP client of its own, so claiming health would
      // be the always-green badge again: report "nothing verified" instead.
      return { servers: [], totalTools: 0, healthy: false, unverified: true };
    },

    async createSession(options) {
      const session = await port.createSession({
        title: options.title,
        directory: options.directory,
        model: options.model,
        agent: options.agent,
      });
      const legacy: IAgentSession = {
        id: session.id,
        async prompt(text, promptOptions) {
          return session.prompt({
            text,
            model: promptOptions?.model,
            agent: promptOptions?.agent,
            timeoutMs: promptOptions?.timeoutMs,
            directory: promptOptions?.directory,
          });
        },
        async abort() {
          // The engine's abort ends the run, so the handle is released too: a
          // native driver keeps file handles and a session file otherwise.
          await session.interrupt("aborted by the engine");
          await session.close();
        },
      };
      return legacy;
    },

    async stopDaemon() {
      await port.dispose?.();
    },
  };
}
