import { delimiter, join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { isExecutableBinary } from "../binaryUtils.js";
import type {
  CommandOptions,
  IAgentRuntime,
  IAgentSession,
  McpServerListing,
  McpServerState,
  McpServerStatus,
  McpStatusReport,
  ModelCatalog,
  ModelInfo,
  PromptOptions,
  PromptResult,
  SessionOptions,
} from "../types.js";
import {
  abortSession,
  createClient,
  createSession as clientCreateSession,
  prompt as clientPrompt,
  runCommand as clientRunCommand,
} from "../../../server/client.js";
import { startServer, type ServerHandle } from "../../../server/lifecycle.js";
import { events } from "../../engineEvents.js";
import { resolveModel } from "../../modelRouter.js";
import { sanitizeTerminalText } from "../../../util/text.js";
import { listMcpServersViaCommand, parseOpencodeMcpList } from "./mcpList.js";
import { runModelListCommand } from "./modelList.js";

export interface OpencodeRuntimeOptions {
  client?: OpencodeClient;
  baseUrl?: string;
  projectPath?: string;
  port?: number;
  serverTimeoutMs?: number;
  /** Binary used for the `opencode models` CLI fallback (REQ-27 / AC-27.2). */
  modelsCommand?: string;
  /** Bounded spawn deadline for the CLI fallback; defaults to the shared `MODEL_LIST_TIMEOUT_MS` (8 s). */
  modelsTimeoutMs?: number;
  /** Binary used for `opencode mcp list` (REQ-32 / AC-32.1); defaults to `opencode`. */
  mcpListCommand?: string;
  /** Bounded spawn deadline for the MCP listing; defaults to the shared `MCP_LIST_TIMEOUT_MS` (5 s). */
  mcpListTimeoutMs?: number;
  /** PATH override used when spawning the fallback CLI (also used by tests). */
  env?: Record<string, string | undefined>;
}

/** Shape of `client.provider.list()` (ADR-27): `all` is the whole models.dev catalog. */
interface ProviderListResponse {
  all?: Array<{
    id: string;
    name: string;
    models?: Record<string, { id?: string; name?: string; description?: string }>;
  }>;
  default?: Record<string, string>;
  connected?: string[];
}

/**
 * Pure parser for `opencode models` output: one `provider/model` id per line
 * (model ids may themselves contain slashes, e.g. `fireworks-ai/accounts/...`).
 * Blank lines and any non-id noise are dropped. Exported for fixture tests.
 */
export function parseOpencodeModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = sanitizeTerminalText(rawLine).trim();
    if (!line) continue;
    // Require exactly `<provider>/<model...>` with no whitespace anywhere.
    if (!/^[^\s/]+\/\S+$/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);

    const slashIdx = line.indexOf("/");
    const provider = line.slice(0, slashIdx);
    const modelPath = line.slice(slashIdx + 1);
    const shortName = modelPath.slice(modelPath.lastIndexOf("/") + 1);
    models.push({ id: line, name: shortName || modelPath, provider });
  }

  return models;
}

export class OpencodeSession implements IAgentSession {
  readonly id: string;
  private readonly client: OpencodeClient;
  private readonly defaultDirectory?: string;

  constructor(id: string, client: OpencodeClient, defaultDirectory?: string) {
    this.id = id;
    this.client = client;
    this.defaultDirectory = defaultDirectory;
  }

  async prompt(text: string, options?: PromptOptions): Promise<PromptResult> {
    const modelRef = options?.model
      ? options.model.includes("/")
        ? resolveModel(options.model)
        : { providerID: "default", modelID: options.model }
      : undefined;
    return clientPrompt(this.client, this.id, {
      text,
      agent: options?.agent,
      model: modelRef,
      timeoutMs: options?.timeoutMs,
      directory: options?.directory ?? this.defaultDirectory,
    });
  }

  async runCommand(command: string, args: string, options?: CommandOptions): Promise<PromptResult> {
    return clientRunCommand(this.client, this.id, {
      command,
      arguments: args,
      agent: options?.agent,
      model: options?.model,
      timeoutMs: options?.timeoutMs,
      directory: options?.directory ?? this.defaultDirectory,
    });
  }

  async abort(): Promise<void> {
    await abortSession(this.client, this.id);
  }
}

export class OpencodeRuntimeAdapter implements IAgentRuntime {
  readonly id = "opencode" as const;
  readonly name = "OpenCode";
  /**
   * Phase 4A: the opencode **server** owns the session and replays every prior
   * turn, so the live engine may send just the new text after the first turn
   * instead of re-assembling a transcript. This is the only runtime that can
   * truthfully claim it — every subprocess CLI is one-shot.
   */
  readonly sessionHistory = true;

  private _client?: OpencodeClient;
  private serverHandle?: ServerHandle;
  /** Recovery state of the supervised daemon (AC-30.4); undefined while healthy. */
  private daemonFailure?: string;
  private readonly options: OpencodeRuntimeOptions;

  constructor(options: OpencodeRuntimeOptions = {}) {
    this.options = options;
    if (options.client) {
      this._client = options.client;
    }
  }

  get client(): OpencodeClient {
    if (!this._client) {
      const baseUrl = this.options.baseUrl ?? `http://127.0.0.1:${this.options.port ?? 4096}`;
      this._client = createClient(baseUrl);
    }
    return this._client;
  }

  async isAvailable(): Promise<boolean> {
    if (this._client) return true;

    const pathEnv = process.env.PATH ?? "";
    const dirs = pathEnv.split(delimiter);
    for (const dir of dirs) {
      if (!dir) continue;
      const fullPath = join(dir, "opencode");
      if (isExecutableBinary(fullPath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Truthful discovery (REQ-27 / AC-27.1, AC-27.2, REV-002/REV-010): only models
   * from providers in the response's `connected` set are offered (581 on the
   * reference machine, not the 8 195-model catalog). When the SDK is unreachable
   * — or the connected set yields nothing — fall back to parsing
   * `opencode models`. Never throws, never fabricates: an empty catalog carries a
   * `reason` naming the SDK failure or the CLI failure that produced it.
   */
  async getModelCatalog(): Promise<ModelCatalog> {
    let sdkReason: string | undefined;
    try {
      const response = (await this.client.provider.list()) as unknown as ProviderListResponse;
      const connected = new Set(response.connected ?? []);
      const providers = response.all ?? [];

      const models: ModelInfo[] = [];
      for (const p of providers) {
        if (!connected.has(p.id)) continue;
        if (!p.models) continue;
        for (const [modelId, m] of Object.entries(p.models)) {
          models.push({
            id: `${p.id}/${modelId}`,
            name: m.name ?? modelId,
            // REV-004: always the provider *id* — the `opencode models` CLI
            // fallback only knows ids, so badges/filtering stay consistent
            // regardless of which discovery path answered.
            provider: p.id,
            description: m.description,
          });
        }
      }

      if (models.length > 0) return { models };
      sdkReason = "no connected providers reported by the opencode SDK";
    } catch (err) {
      sdkReason = `opencode SDK provider discovery failed: ${sanitizeTerminalText(
        err instanceof Error ? err.message : String(err),
      )}`;
    }

    const fromCli = await this.getModelsFromCli();
    if (fromCli.models.length > 0) return fromCli;

    // Both paths failed: name them both (each part is short, already sanitized),
    // so the picker can say *why* opencode reported nothing.
    const reasons = [sdkReason, fromCli.reason].filter((r): r is string => Boolean(r));
    return { models: [], reason: reasons.join(" · ") || "no models discovered" };
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return (await this.getModelCatalog()).models;
  }

  /** `opencode models` fallback — bounded spawn, tolerant parse, reasoned empty result. */
  private async getModelsFromCli(): Promise<ModelCatalog> {
    const command = this.options.modelsCommand ?? "opencode";
    const result = await runModelListCommand(command, ["models"], {
      env: this.options.env,
      timeoutMs: this.options.modelsTimeoutMs,
    });
    if (result.error || result.stdout === undefined) {
      return { models: [], reason: result.error ?? "`opencode models` printed no output" };
    }
    try {
      const models = parseOpencodeModels(result.stdout);
      if (models.length === 0) return { models: [], reason: "`opencode models` listed no models" };
      return { models };
    } catch (err) {
      return {
        models: [],
        reason: `could not parse \`opencode models\` output: ${sanitizeTerminalText(
          err instanceof Error ? err.message : String(err),
        )}`,
      };
    }
  }

  /**
   * Enumerates the servers configured for **this** opencode install through
   * `opencode mcp list` (REQ-32 / AC-32.1).
   *
   * The listing is the agent's own answer and is what makes the panel
   * attributable: names the SDK cannot know (per-agent config files, plugin
   * servers) show up here, with opencode's own status word. It is a bounded
   * spawn and never throws — an absent or failing CLI resolves `[]`, leaving the
   * caller free to fall back to config discovery.
   */
  async listMcpServers(): Promise<McpServerListing[]> {
    return listMcpServersViaCommand(
      {
        command: this.options.mcpListCommand ?? "opencode",
        args: ["mcp", "list"],
        parse: parseOpencodeMcpList,
      },
      { env: this.options.env, timeoutMs: this.options.mcpListTimeoutMs },
    );
  }

  async getMcpStatus(): Promise<McpStatusReport> {
    // AC-30.4: a died/recovering daemon is a *known, recoverable* failure — say
    // so instead of letting the probe fail into a neutral empty state.
    const daemonError = this.daemonStatusError();
    if (daemonError) {
      return { servers: [], totalTools: 0, healthy: false, degraded: true, error: daemonError };
    }

    try {
      const response = await this.client.mcp.status();
      const statusMap = (response as unknown as Record<string, { status?: string; error?: string }>) ?? {};

      const servers: McpServerStatus[] = [];
      for (const [id, s] of Object.entries(statusMap)) {
        let status: McpServerState = "disconnected";
        if (s.status === "connected") status = "connected";
        else if (s.status === "failed") status = "error";

        servers.push({
          id,
          name: id,
          status,
          transport: "opencode",
          toolsCount: 0,
          error: s.error,
        });
      }

      const healthy = servers.length > 0 && servers.every((s) => s.status === "connected");
      return {
        servers,
        totalTools: servers.reduce((sum, s) => sum + s.toolsCount, 0),
        healthy,
      };
    } catch (err) {
      // REV-009 / ADR-30: never report an unreachable MCP surface as a neutral
      // empty state — carry the (sanitized) error so the badge can go degraded.
      return {
        servers: [],
        totalTools: 0,
        healthy: false,
        degraded: true,
        error: sanitizeTerminalText(err instanceof Error ? err.message : String(err)),
      };
    }
  }

  async createSession(options: SessionOptions): Promise<IAgentSession> {
    const created = await clientCreateSession(this.client, options.title, options.directory);
    return new OpencodeSession(created.id, this.client, options.directory);
  }

  async startDaemon(): Promise<void> {
    if (this.serverHandle) return;
    const projectPath = this.options.projectPath ?? process.cwd();
    const port = this.options.port ?? 0;
    const timeout = this.options.serverTimeoutMs ?? 60000;
    const handle = await startServer(projectPath, port, timeout);
    // AC-30.4: the daemon is supervised from here on. A mid-session exit is
    // logged by `startServer`, surfaced to the TUI and carried by
    // `getMcpStatus()` as a recoverable error until (or unless) it recovers.
    handle.onExit = ({ code, recovered }) => {
      this.daemonFailure = recovered
        ? undefined
        : `opencode server exited (code ${code}); recovery failed — restart it with /agent`;
      if (this.daemonFailure) {
        events.emit("log", { level: "warn", message: `[huginn] ${this.daemonFailure}` });
      } else {
        events.emit("log", {
          level: "info",
          message: `[huginn] opencode server exited (code ${code}) and was restarted`,
        });
      }
    };
    this.serverHandle = handle;
    this._client = createClient(handle.url);
  }

  /**
   * The recoverable reason the MCP surface is unreachable, when the supervised
   * opencode daemon died and has not (yet) recovered (AC-30.4).
   */
  private daemonStatusError(): string | undefined {
    const handle = this.serverHandle;
    if (!handle) return undefined;
    if (handle.isHealthy()) return undefined;
    return sanitizeTerminalText(
      this.daemonFailure ?? "opencode server is unresponsive after exiting; restarting (recoverable)",
    );
  }

  get serverUrl(): string | undefined {
    return this.serverHandle?.url;
  }

  async stopDaemon(): Promise<void> {
    if (this.serverHandle) {
      await this.serverHandle.close();
      this.serverHandle = undefined;
    }
  }
}
