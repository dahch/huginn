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
} from "../mcpConfig.js";
import { sanitizeTerminalText } from "../../../util/text.js";
import { isExecutableBinary } from "../binaryUtils.js";
import { runModelListCommand } from "./modelList.js";
import type {
  CommandOptions,
  IAgentRuntime,
  IAgentSession,
  McpServerStatus,
  McpStatusReport,
  ModelCatalog,
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
  /**
   * Declarative model listing (REQ-27 / AC-27.4): argv + pure parser for a CLI
   * that can enumerate its catalog (e.g. `commandcode --list-models`). Preferred
   * over the static `models` array; without either, discovery returns `[]`.
   */
  modelListCommand?: {
    command: string;
    args: string[];
    parse: (stdout: string) => ModelInfo[];
    /** Bounded spawn deadline; defaults to the shared `MODEL_LIST_TIMEOUT_MS` (8 s). */
    timeoutMs?: number;
  };
  /**
   * Native model flag for this runtime (AC-27.5), e.g. `(m) => ["-m", m]`.
   * Appended to argv when a model is selected; `HUGINN_MODEL` is kept as an
   * extra env hint only.
   */
  modelArgs?: (model: string) => string[];
  defaultTimeoutMs?: number;
  promptViaStdin?: boolean;
  maxPromptArgLength?: number;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB bound against memory DoS (SEC-003)
const DEFAULT_MAX_PROMPT_ARG_LENGTH = 4096;

/** A model flag split into its name and (when present) its separate/inline value. */
interface ModelFlagPair {
  name: string;
  inline: boolean;
  value?: string;
}

/**
 * Splits `modelArgs(model)` into flags (`--model new`, `--model=new`) and any
 * bare positionals, so a flag's value can be replaced in place rather than the
 * whole pair being dropped.
 */
function splitModelArgs(args: string[]): { pairs: ModelFlagPair[]; positionals: string[] } {
  const pairs: ModelFlagPair[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const equalsIdx = token.indexOf("=");
    if (equalsIdx > 1) {
      pairs.push({ name: token.slice(0, equalsIdx), inline: true, value: token.slice(equalsIdx + 1) });
      continue;
    }

    const next = args[i + 1];
    if (next !== undefined && next.length > 0 && !next.startsWith("-")) {
      pairs.push({ name: token, inline: false, value: next });
      i++;
      continue;
    }
    pairs.push({ name: token, inline: false });
  }

  return { pairs, positionals };
}

/**
 * Appends the runtime's native model flag to argv (AC-27.5).
 *
 * REV-005: when the base argv already carries the flag — `["--model", "old"]` or
 * `["--model=old"]` — the *value* is replaced with the user's selection instead
 * of the flag being silently dropped, which previously ignored the choice.
 */
function withModelArgs(
  baseArgs: string[],
  modelArgs: ((model: string) => string[]) | undefined,
  model: string | undefined,
): string[] {
  if (!model || !modelArgs) return [...baseArgs];
  let args: string[];
  try {
    args = modelArgs(model);
  } catch {
    return [...baseArgs];
  }
  if (!Array.isArray(args) || args.length === 0) return [...baseArgs];

  const { pairs, positionals } = splitModelArgs(args);
  const result = [...baseArgs];
  const appended: string[] = [...positionals];

  for (const pair of pairs) {
    const idx = result.findIndex((arg) => arg === pair.name || arg.startsWith(`${pair.name}=`));
    if (idx === -1) {
      // The flag is absent → append it in the form the runtime requested.
      if (pair.inline) {
        appended.push(`${pair.name}=${pair.value ?? ""}`);
      } else {
        appended.push(pair.name);
        if (pair.value !== undefined) appended.push(pair.value);
      }
      continue;
    }

    if (pair.value === undefined) continue; // bare flag: nothing to replace
    if (result[idx].includes("=")) {
      result[idx] = `${pair.name}=${pair.value}`; // `--flag=old` → `--flag=new`
    } else if (idx + 1 < result.length && !result[idx + 1].startsWith("-")) {
      result[idx + 1] = pair.value; // `--flag old` → `--flag new`
    } else {
      result.splice(idx + 1, 0, pair.value); // `--flag <other flag>` → `--flag new …`
    }
  }

  if (appended.length === 0) return result;

  // Positional-args fallback: skip when the exact sequence is already present.
  if (!appended.some((arg) => arg.startsWith("-"))) {
    const sequence = appended.join("\u0000");
    if (sequence && baseArgs.join("\u0000").includes(sequence)) return result;
  }

  return [...result, ...appended];
}

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
    const baseArgs = withModelArgs(
      this.runtimeOptions.args ?? [],
      this.runtimeOptions.modelArgs,
      options?.model,
    );
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
            // AC-27.5: the native `modelArgs` flag is the real channel; this env
            // var is retained only as an additional hint for wrapper scripts.
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

  /**
   * Truthful discovery (REQ-27 / AC-27.4, REV-002/REV-010): a declarative
   * `modelListCommand` is preferred, then a caller-supplied static `models`
   * array. Every other case returns an empty catalog **with a reason** so an
   * empty result is never indistinguishable from a failure:
   *
   * - no listing mechanism → `no model-listing command for this runtime`
   * - spawn failed / non-zero exit / timeout / empty output → the CLI's own error
   * - unparseable output → `could not parse …`
   *
   * The previous `${id}/default` placeholder is deliberately gone, so the picker
   * offers free-text entry instead of a fabricated model.
   */
  async getModelCatalog(): Promise<ModelCatalog> {
    const listCommand = this.options.modelListCommand;
    if (listCommand) {
      const result = await runModelListCommand(listCommand.command, listCommand.args, {
        env: this.options.env,
        timeoutMs: listCommand.timeoutMs,
      });
      if (result.error || result.stdout === undefined) {
        return { models: [], reason: result.error ?? "model listing produced no output" };
      }
      try {
        const parsed = listCommand.parse(result.stdout);
        const models = Array.isArray(parsed) ? parsed : [];
        if (models.length === 0) {
          return { models: [], reason: `\`${listCommand.command} ${listCommand.args.join(" ")}\` listed no models` };
        }
        return { models };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { models: [], reason: `could not parse model listing: ${sanitizeTerminalText(detail)}` };
      }
    }

    if (this.options.models && this.options.models.length > 0) {
      return { models: [...this.options.models] };
    }

    return { models: [], reason: "no model-listing command for this runtime" };
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return (await this.getModelCatalog()).models;
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
