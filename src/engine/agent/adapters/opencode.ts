import { delimiter, join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { isExecutableBinary } from "../binaryUtils.js";
import type {
  CommandOptions,
  IAgentRuntime,
  IAgentSession,
  McpServerStatus,
  McpStatusReport,
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
import { resolveModel } from "../../modelRouter.js";

export interface OpencodeRuntimeOptions {
  client?: OpencodeClient;
  baseUrl?: string;
  projectPath?: string;
  port?: number;
  serverTimeoutMs?: number;
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

  private _client?: OpencodeClient;
  private serverHandle?: ServerHandle;
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

  async getAvailableModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.provider.list();
      const providers = (response as unknown as { all?: Array<{ id: string; name: string; models?: Record<string, { id: string; name: string; description?: string }> }> }).all ?? [];

      const models: ModelInfo[] = [];
      for (const p of providers) {
        if (!p.models) continue;
        for (const [modelId, m] of Object.entries(p.models)) {
          models.push({
            id: `${p.id}/${modelId}`,
            name: m.name ?? modelId,
            provider: p.name ?? p.id,
            description: m.description,
          });
        }
      }

      if (models.length > 0) return models;
    } catch {
      // client provider list may not be reachable yet or unauthenticated
    }

    return [
      {
        id: "anthropic/claude-opus-4-5",
        name: "Claude Opus 4.5",
        provider: "anthropic",
      },
      {
        id: "opencode/gpt-5.1-codex",
        name: "GPT-5.1 Codex",
        provider: "opencode",
      },
    ];
  }

  async getMcpStatus(): Promise<McpStatusReport> {
    try {
      const response = await this.client.mcp.status();
      const statusMap = (response as unknown as Record<string, { status?: string; error?: string }>) ?? {};

      const servers: McpServerStatus[] = [];
      for (const [id, s] of Object.entries(statusMap)) {
        let status: "connected" | "disconnected" | "error" = "disconnected";
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
      return {
        servers: [],
        totalTools: 0,
        healthy: false,
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
    this.serverHandle = await startServer(projectPath, port, timeout);
    this._client = createClient(this.serverHandle.url);
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
