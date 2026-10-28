import { homedir } from "node:os";
import type {
  McpListingStatus,
  McpServerListing,
  McpServerStatus,
  McpStatusReport,
  ModelCatalog,
  ModelInfo,
} from "../types.js";
import type {
  Availability,
  RuntimeCapabilities,
  RuntimePort,
  RuntimeSession,
  RuntimeSessionOptions,
} from "../port.js";
import { runModelListCommand } from "../adapters/modelList.js";
import { readMcpConfigFile } from "../mcpConfig.js";
import { resolveMcpPaths } from "../../../agents/integrator.js";
import { sanitizeTerminalText } from "../../../util/text.js";

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
  /**
   * `pi mcp list --json`: the agent's own answer, with real state and tool
   * counts. Optional so a test fake (or an older SDK without the command) can
   * omit it; the caller then falls back to config discovery.
   */
  listMcpServers?(): Promise<McpServerListing[]>;
  /** Config-file view of pi's servers, reported as configured (never "connected"). */
  getMcpStatus?(): Promise<McpStatusReport>;
}

/** Where the pi driver looks for project-scoped config and how it spawns the CLI. */
export interface PiPortOptions {
  projectPath?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  /** pi binary used for `mcp list`; defaults to `pi` on PATH. */
  command?: string;
}

/** `pi mcp list --json` connects to every server, so it gets a generous bound. */
export const PI_MCP_LIST_TIMEOUT_MS = 30000;

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
  // Config discovery is always available; `pi mcp list --json` adds real liveness.
  mcpListing: true,
  interrupt: true,
};

/** Split huginn's canonical `provider/model` reference. */
function splitReference(reference: string): { provider: string; model: string } | undefined {
  const value = reference.trim();
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function mapPiMcpState(state: unknown, enabled: unknown): McpListingStatus {
  if (enabled === false) return "disabled";
  const clean = sanitizeTerminalText(String(state ?? "")).toLowerCase();
  // `disconnected` and `not connected` both contain the word "connected".
  if (clean.includes("disconnected") || clean.includes("not connected")) return "unknown";
  if (clean.includes("connected")) return "connected";
  if (clean.includes("error") || clean.includes("fail")) return "error";
  if (clean.includes("pending")) return "pending";
  if (clean.includes("disabled")) return "disabled";
  if (clean.includes("enabled") || clean.includes("configured")) return "enabled";
  return "unknown";
}

/**
 * Pure parser for `pi mcp list --json` (verified against pi 1.4.0).
 *
 * Shape: `{ servers: [{ name, scope, source, enabled, exposure, transport,
 * state, tools: string[] }] }`. Every displayed string is sanitized, and only
 * `state: connected` may become `connected` — `enabled: true` alone is
 * configured, not live. Exported for fixture tests.
 */
export function parsePiMcpListJson(stdout: string): McpServerListing[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const servers = Array.isArray(parsed)
    ? parsed
    : (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return [];

  const listings: McpServerListing[] = [];
  const seen = new Set<string>();
  for (const raw of servers) {
    if (!raw || typeof raw !== "object") continue;
    const server = raw as Record<string, unknown>;
    const name = sanitizeTerminalText(String(server.name ?? "")).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const tools = Array.isArray(server.tools)
      ? server.tools
          .filter((tool): tool is string => typeof tool === "string")
          .map((tool) => sanitizeTerminalText(tool))
          .filter((tool) => tool.length > 0)
      : undefined;
    const scope = sanitizeTerminalText(String(server.scope ?? "")).trim();
    const source = sanitizeTerminalText(String(server.source ?? "")).trim();
    const exposure = sanitizeTerminalText(String(server.exposure ?? "")).trim();
    const transport = sanitizeTerminalText(String(server.transport ?? "")).trim();

    listings.push({
      name,
      transport: transport || undefined,
      status: mapPiMcpState(server.state, server.enabled),
      detail: [scope, exposure, source].filter((part) => part.length > 0).join(" · ") || undefined,
      toolsCount: tools?.length ?? 0,
      tools,
    });
  }
  return listings;
}

/** Config files pi would read, project entry last (it overrides the user one). */
function configuredPiServers(options: PiPortOptions): McpStatusReport {
  const paths = resolveMcpPaths("pi", {
    projectPath: options.projectPath ?? process.cwd(),
    homeDir: options.homeDir ?? homedir(),
    env: options.env,
  });
  const byName = new Map<string, McpServerStatus>();
  for (const path of paths) {
    for (const server of readMcpConfigFile(path)) {
      byName.set(server.name, server);
    }
  }
  const servers = [...byName.values()];
  return {
    servers,
    totalTools: 0,
    // A config declaration is never liveness (AC-30.1).
    healthy: false,
    unverified: servers.some((server) => server.status === "unknown"),
    degraded: servers.some((server) => server.status === "error"),
  };
}

/**
 * The in-process pi driver.
 *
 * Advertised capabilities are deliberately conservative for this first cut: the
 * session is real (it keeps history and survives across prompts), but events,
 * permissions and resume are not wired yet, so they are declared `false` rather
 * than promised and dropped.
 */
export function createPiSdkPort(
  adapter?: PiSdkAdapter,
  options: PiPortOptions = {},
): RuntimePort {
  const resolvedAdapter = adapter ?? createDefaultPiAdapter(options);
  // A test fake (or an older adapter) that cannot enumerate MCP must not claim
  // it can: the conformance suite enforces the implication.
  const capabilities: RuntimeCapabilities = {
    ...CAPABILITIES,
    mcpListing: Boolean(resolvedAdapter.listMcpServers || resolvedAdapter.getMcpStatus),
  };
  return {
    id: "pi",
    name: "Pi (in-process)",
    capabilities,

    async isAvailable(): Promise<Availability> {
      try {
        const models = await resolvedAdapter.listModels();
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
        const models = await resolvedAdapter.listModels();
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

    ...(resolvedAdapter.listMcpServers
      ? { listMcpServers: () => resolvedAdapter.listMcpServers!() }
      : {}),
    ...(resolvedAdapter.getMcpStatus
      ? { mcpStatus: () => resolvedAdapter.getMcpStatus!() }
      : {}),

    async createSession(options: RuntimeSessionOptions): Promise<RuntimeSession> {
      const handle = await resolvedAdapter.createSession({
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
export function createDefaultPiAdapter(options: PiPortOptions = {}): PiSdkAdapter {
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

    async listMcpServers() {
      // The CLI is the only source that can say "connected" and report tools;
      // the in-process SDK does not expose its MCP registry through this seam.
      const result = await runModelListCommand(
        options.command ?? "pi",
        ["mcp", "list", "--json"],
        {
          env: options.env,
          timeoutMs: PI_MCP_LIST_TIMEOUT_MS,
          cwd: options.projectPath,
        },
      );
      if (result.error || result.stdout === undefined) return [];
      return parsePiMcpListJson(result.stdout);
    },

    async getMcpStatus() {
      return configuredPiServers(options);
    },
  };
}

function splitReferenceOrThrow(reference: string): { cliProvider: string; cliModel: string } {
  const parsed = splitReference(reference);
  if (!parsed) throw new Error(`expected a "provider/model" reference, got "${reference}"`);
  return { cliProvider: parsed.provider, cliModel: parsed.model };
}
