import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join } from "node:path";
import type { AgentTarget } from "../../../agents/integrator.js";
import { resolveMcpPaths } from "../../../agents/integrator.js";
import {
  isReservedKey,
  loadProjectMcpConfig,
  parseMcpServerEntry,
  sanitizeTerminalText,
} from "../mcpConfig.js";
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

export interface GenericSubprocessOptions {
  id: AgentTarget;
  name: string;
  command: string;
  args?: string[];
  projectPath?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  models?: ModelInfo[];
  defaultTimeoutMs?: number;
  promptViaStdin?: boolean;
  maxPromptArgLength?: number;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB bound against memory DoS (SEC-003)
const DEFAULT_MAX_PROMPT_ARG_LENGTH = 4096;

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // best-effort
    }
  }
}

export class GenericSubprocessSession implements IAgentSession {
  readonly id: string;
  private activeProcess?: ChildProcess;
  private terminateProcess?: (graceMs?: number) => void;
  private aborted = false;
  private isPrompting = false;

  constructor(
    id: string,
    private readonly runtimeOptions: GenericSubprocessOptions,
    private readonly sessionOptions: SessionOptions,
  ) {
    this.id = id;
  }

  async prompt(text: string, options?: PromptOptions): Promise<PromptResult> {
    if (this.aborted) {
      throw new Error(`Session ${this.id} was aborted`);
    }
    if (this.isPrompting) {
      throw new Error(`Session ${this.id} already has a prompt in progress`);
    }

    const command = this.runtimeOptions.command;
    const baseArgs = this.runtimeOptions.args ?? [];
    const cwd = options?.directory ?? this.sessionOptions.directory ?? this.runtimeOptions.projectPath ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? this.runtimeOptions.defaultTimeoutMs ?? 120000;

    // SEC-002: Do NOT pass full prompt text as an argv positional command line argument.
    // Prefer streaming prompt text safely via child.stdin.write(text); child.stdin.end().
    // If promptViaStdin is explicitly set to false, check length and use '--' end-of-options delimiter.
    const useStdin = this.runtimeOptions.promptViaStdin !== false;
    let childArgs: string[];

    if (useStdin) {
      childArgs = [...baseArgs];
    } else {
      const maxLen = this.runtimeOptions.maxPromptArgLength ?? DEFAULT_MAX_PROMPT_ARG_LENGTH;
      if (text.length > maxLen) {
        throw new Error(`Prompt length (${text.length}) exceeds maximum command line argument limit (${maxLen})`);
      }
      childArgs = baseArgs.includes("--")
        ? [...baseArgs, text]
        : [...baseArgs, "--", text];
    }

    this.isPrompting = true;

    return new Promise<PromptResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let settled = false;

      const cleanup = () => {
        this.isPrompting = false;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
          sigkillTimer = undefined;
        }
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
          }
        } catch {
          // best-effort
        }
        this.activeProcess = undefined;
        this.terminateProcess = undefined;
      };

      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const safeResolve = (res: PromptResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      };

      let child: ChildProcess;
      try {
        child = spawn(command, childArgs, {
          cwd,
          env: {
            ...process.env,
            ...this.runtimeOptions.env,
            ...(options?.model ? { HUGINN_MODEL: options.model } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (err) {
        this.isPrompting = false;
        reject(err);
        return;
      }

      // SEC-003: Process group cleanup with SIGTERM followed by SIGKILL grace period
      const terminate = (graceMs = 1000) => {
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
          }
        } catch {
          // best-effort
        }
        killProcessGroup(child, "SIGTERM");
        if (!sigkillTimer) {
          sigkillTimer = setTimeout(() => {
            killProcessGroup(child, "SIGKILL");
          }, graceMs);
          if (typeof sigkillTimer.unref === "function") {
            sigkillTimer.unref();
          }
        }
      };

      this.activeProcess = child;
      this.terminateProcess = terminate;

      // SEC-003: Bound stdout and stderr string accumulation to prevent memory exhaustion (DoS)
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
          const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
          stdout += slice.toString("utf8");
          stdoutBytes += slice.length;
        }
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stderrBytes;
          const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
          stderr += slice.toString("utf8");
          stderrBytes += slice.length;
        }
      });

      // SEC-002 & SEC-003: Stream prompt text safely via stdin and ensure child.stdin.end() is called
      if (child.stdin) {
        child.stdin.on("error", () => {
          // Ignore EPIPE or write errors if child exits early
        });
        if (useStdin) {
          try {
            child.stdin.write(text, "utf8", () => {
              try {
                if (child.stdin && !child.stdin.destroyed) {
                  child.stdin.end();
                }
              } catch {
                // best-effort
              }
            });
          } catch {
            try {
              child.stdin.end();
            } catch {
              // best-effort
            }
          }
        } else {
          try {
            child.stdin.end();
          } catch {
            // best-effort
          }
        }
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          terminate(1000);
          safeReject(new Error(`Agent process timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      child.on("error", (err) => {
        safeReject(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        if (timedOut) return;

        if (this.aborted) {
          safeReject(new Error(`Agent execution aborted`));
          return;
        }

        if (code !== 0) {
          safeReject(
            new Error("Agent process exited with code " + code + ": " + (stderr.trim() || stdout.trim())),
          );
          return;
        }

        const messageId = randomUUID();
        const outputText = stdout.trim() || stderr.trim();
        safeResolve({
          messageId,
          text: outputText,
          raw: { stdout, stderr, exitCode: code },
        });
      });
    });
  }

  async runCommand(command: string, args: string, options?: CommandOptions): Promise<PromptResult> {
    const formattedPrompt = `/${command}${args ? ` ${args}` : ""}`;
    return this.prompt(formattedPrompt, {
      model: options?.model,
      agent: options?.agent,
      timeoutMs: options?.timeoutMs,
      directory: options?.directory,
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    if (this.terminateProcess) {
      this.terminateProcess(1000);
    } else if (this.activeProcess) {
      killProcessGroup(this.activeProcess, "SIGTERM");
    }
  }
}

export class GenericSubprocessRuntimeAdapter implements IAgentRuntime {
  readonly id: AgentTarget;
  readonly name: string;
  protected options: GenericSubprocessOptions;

  constructor(options: GenericSubprocessOptions) {
    this.id = options.id;
    this.name = options.name;
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    if (isExecutableBinary(this.options.command)) {
      return true;
    }

    const pathEnv = this.options.env?.PATH ?? process.env.PATH ?? "";
    const dirs = pathEnv.split(delimiter);
    for (const dir of dirs) {
      if (!dir) continue;
      const fullPath = join(dir, this.options.command);
      // SEC-004: verify resolved path is a regular file and executable
      if (isExecutableBinary(fullPath)) {
        return true;
      }
    }

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      try {
        const child = spawn(this.options.command, ["--version"], {
          stdio: "ignore",
          env: {
            ...process.env,
            ...this.options.env,
          },
        });

        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best-effort
          }
          finish(false);
        }, 2000);
        if (typeof timer.unref === "function") {
          timer.unref();
        }

        child.on("error", () => finish(false));
        child.on("close", (code) => finish(code === 0));
      } catch {
        finish(false);
      }
    });
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    if (this.options.models && this.options.models.length > 0) {
      return [...this.options.models];
    }
    return [
      {
        id: `${this.id}/default`,
        name: `${this.name} Default Model`,
        provider: this.name,
      },
    ];
  }

  async getMcpStatus(): Promise<McpStatusReport> {
    const projectPath = this.options.projectPath ?? process.cwd();
    const servers: McpServerStatus[] = [];
    const seenServerIds = new Set<string>();

    // 1. Project-level .huginn/mcp.json
    try {
      const projectConfig = loadProjectMcpConfig(projectPath);
      if (projectConfig) {
        const mcpServers = (projectConfig.mcpServers ?? projectConfig.mcp ?? projectConfig.servers) as
          | Record<string, unknown>
          | undefined;
        if (mcpServers && typeof mcpServers === "object") {
          for (const [name, val] of Object.entries(mcpServers)) {
            if (isReservedKey(name)) continue;
            const entry = parseMcpServerEntry(name, val);
            servers.push(entry);
            seenServerIds.add(name);
          }
        }
      }
    } catch (err) {
      servers.push({
        id: join(projectPath, ".huginn", "mcp.json"),
        name: ".huginn/mcp.json",
        status: "error",
        transport: "file",
        toolsCount: 0,
        error: sanitizeTerminalText((err as Error).message),
      });
    }

    // 2. Target agent configuration paths
    const paths = resolveMcpPaths(this.id, {
      projectPath,
      homeDir: this.options.homeDir ?? process.env.HOME ?? "",
      env: this.options.env,
    });

    for (const filePath of paths) {
      if (!existsSync(filePath)) continue;
      try {
        const stat = statSync(filePath);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const content = readFileSync(filePath, "utf8");
        if (filePath.endsWith(".toml")) {
          const tableMatches = content.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]/gm);
          for (const match of tableMatches) {
            const rawName = match[1].trim();
            if (isReservedKey(rawName)) continue;
            const name = sanitizeTerminalText(rawName);
            if (!name) continue;
            if (!seenServerIds.has(name)) {
              servers.push({
                id: name,
                name,
                status: "connected",
                transport: "stdio",
                toolsCount: 0,
                tools: [],
              });
              seenServerIds.add(name);
            }
          }
        } else {
          const parsed = JSON.parse(content, (key, value) => {
            if (isReservedKey(key)) return undefined;
            return value;
          }) as Record<string, unknown>;
          const mcpServers = (parsed.mcpServers ?? parsed.mcp) as Record<string, unknown> | undefined;
          if (mcpServers && typeof mcpServers === "object") {
            for (const [name, val] of Object.entries(mcpServers)) {
              if (isReservedKey(name)) continue;
              if (typeof val === "object" && val !== null && !seenServerIds.has(name)) {
                servers.push(parseMcpServerEntry(name, val));
                seenServerIds.add(name);
              }
            }
          }
        }
      } catch (err) {
        servers.push({
          id: filePath,
          name: filePath,
          status: "error",
          transport: "file",
          toolsCount: 0,
          error: sanitizeTerminalText((err as Error).message),
        });
      }
    }

    const totalTools = servers.reduce((sum, s) => sum + s.toolsCount, 0);
    const healthy = servers.length > 0 && servers.every((s) => s.status === "connected");
    const degraded = servers.some((s) => s.status === "error");

    return {
      servers,
      totalTools,
      healthy,
      degraded,
    };
  }

  async createSession(options: SessionOptions): Promise<IAgentSession> {
    const sessionId = randomUUID();
    return new GenericSubprocessSession(sessionId, this.options, options);
  }
}
