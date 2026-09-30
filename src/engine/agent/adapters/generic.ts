import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentTarget } from "../../../agents/integrator.js";
import { resolveMcpPaths } from "../../../agents/integrator.js";
import type { PermissionMode } from "../../../config.js";
import {
  isReservedKey,
  loadProjectMcpConfig,
  parseMcpServerEntry,
} from "../mcpConfig.js";
import { sanitizeTerminalText } from "../../../util/text.js";
import { events } from "../../engineEvents.js";
import { isExecutableBinary } from "../binaryUtils.js";
import { listMcpServersViaCommand, type McpListCommandSpec } from "./mcpList.js";
import { runModelListCommand } from "./modelList.js";
import type {
  CommandOptions,
  IAgentRuntime,
  IAgentSession,
  McpServerListing,
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
   * Declarative MCP enumeration (REQ-32 / AC-32.1): argv + pure parser for a CLI
   * that can list its own servers (`<cli> mcp list`). Routimes without one leave
   * this unset, and `listMcpServers()` honestly resolves `[]` so the caller falls
   * back to config-file discovery.
   */
  mcpListCommand?: McpListCommandSpec;
  /**
   * Native model flag for this runtime (AC-27.5), e.g. `(m) => ["-m", m]`.
   * Appended to argv when a model is selected; `HUGINN_MODEL` is kept as an
   * extra env hint only.
   */
  modelArgs?: (model: string) => string[];
  /**
   * The CLI's own **auto-approval** flag(s) (Phase 2C), e.g.
   * `["--dangerously-skip-permissions"]` for Claude Code or
   * `["--permission-mode", "dangerous"]` for Devin.
   *
   * A subprocess runtime closes stdin right after the prompt (SEC-002), so it
   * can never consult huginn for an approval: without this flag a CLI that
   * decides an action needs permission blocks until the phase timeout and the
   * cycle hangs. The flag is the CLI's own switch (not a huginn protocol) and
   * may change between CLI versions — re-verify it against `<cli> --help`.
   */
  permissionArgs?: string[];
  /**
   * Whether {@link permissionArgs} is a **verified** auto-approval switch
   * (Phase 2C, REV-2C-002). Defaults to `true`. Runtimes whose flag is only
   * assumed — the binary is unverified or a flag's semantics are dubious
   * (`pi --approve` means "trust project-local files") — set it to `false`, and
   * the once-per-runtime notice then says the flag is assumed rather than
   * claiming the CLI is auto-approved.
   */
  permissionArgsVerified?: boolean;
  /**
   * Whether the CLI is launched auto-approved (Phase 2C). Defaults to `true`,
   * which is the only workable mode for a one-shot subprocess; set it to
   * `false` only to opt a runtime back into interactive prompts (which will
   * stall the cycle if the CLI asks for something).
   */
  autoApprovePermissions?: boolean;
  /**
   * Huginn's `--permissions` mode, carried here **for transparency only**. A
   * subprocess runtime supports `auto` and cannot honour `ask`/`deny` (there is
   * no channel back to huginn), so the CLI fails closed before a session is ever
   * created (REV-2C-001); the adapter's notice is therefore only ever emitted
   * for `auto`.
   */
  permissions?: PermissionMode;
  defaultTimeoutMs?: number;
  promptViaStdin?: boolean;
  /**
   * Byte budget for the argv prompt channel ({@link promptValueFlag} or the
   * positional fallback). Measured in **UTF-8 bytes** (SEC-302), matching the
   * kernel's own `MAX_ARG_STRLEN` — not the JavaScript string's UTF-16 `length`.
   * Defaults to {@link DEFAULT_MAX_PROMPT_ARG_LENGTH}.
   */
  maxPromptArgLength?: number;
  /**
   * The CLI's own "read the prompt from a file" flag (REV-3A-001), e.g.
   * `--prompt-file` for Devin.
   *
   * Only meaningful when {@link promptViaStdin} is `false`. A CLI that
   * *requires* the prompt as an argument (`devin -p`) still rejects prompts far
   * larger than `ARG_MAX` (`MAX_ARG_STRLEN`, ~128 KB per argument on Linux), and
   * a real huginn prompt embeds the spec/ADR/plan, so the positional path's
   * {@link maxPromptArgLength} cap would make the runtime fail in production
   * even though small-prompt tests pass.
   *
   * When this flag is set, the prompt is written to a unique, mode-`0o600` temp
   * file under `os.tmpdir()` and `[promptFileFlag, tmpPath]` is appended to the
   * argv instead — there is **no length limit** on this path, and the prompt
   * never appears in the argv (nor in `ps`). The temp file is removed when the
   * prompt settles: on `close`, `error`, timeout and abort.
   */
  promptFileFlag?: string;
  /**
   * The CLI's own flag that takes the prompt **as its value** (Phase 3C), e.g.
   * `--prompt=` for kimi (`kimi --prompt=<text>`).
   *
   * Only meaningful when {@link promptViaStdin} is `false` and
   * {@link promptFileFlag} is unset — i.e. the CLI offers *neither* a stdin
   * channel nor a prompt-file flag, which is exactly kimi's case: its prompt
   * mode is `-p, --prompt <prompt>` (verified: a bare `kimi -p` fails with
   * "option '-p, --prompt <prompt>' argument missing", `kimi -p -` sends the
   * literal text `-`, and no `--prompt-file` exists).
   *
   * Two argv shapes (SEC-304):
   * - a flag that **ends with `=`** produces a single inline token
   *   (`--prompt=<text>`). node:util `parseArgs` — the parser kimi uses (its
   *   errors read `Option '-p' argument is ambiguous`, it is *not* Commander) —
   *   resolves `--prompt=<text>` for **any** text, including one that begins
   *   with `-`. Prefer this shape.
   * - any other flag produces two tokens (`[...baseArgs, flag, text]`), the shape
   *   every `--flag value` parser accepts, but one `parseArgs` rejects as
   *   ambiguous ("Option '-p' argument is ambiguous") when the value begins with
   *   `-`; a runtime wired this way must keep its prompt from starting with a
   *   dash. No `--` end-of-options delimiter is ever inserted here: the text
   *   *is* the flag's value, so an embedded `--` would simply become part of the
   *   prompt (`parseArgs` does not treat `--` as a separator mid-value).
   *
   * This is the documented last resort (SEC-002): the prompt travels on the
   * argv, where any local user can read it from `ps`, and each argument is
   * bounded by the kernel's `MAX_ARG_STRLEN` (~128 KB on Linux, 256 KB on
   * macOS) — hence {@link maxPromptArgLength}, measured in **UTF-8 bytes**
   * (SEC-302: the kernel limits by bytes, so a non-ASCII prompt can exceed the
   * budget while its UTF-16 `length` looks small), whose default positional cap
   * (4096) is far too small for a huginn prompt that embeds the spec/ADR/plan.
   * A runtime that can use {@link promptViaStdin} or {@link promptFileFlag}
   * must prefer it; this flag exists only so a CLI with no other channel can be
   * driven at all.
   */
  promptValueFlag?: string;
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

/**
 * Appends the runtime's auto-approval flags to argv (Phase 2C).
 *
 * Unlike `--model`, these flags are never *replaced*: an auto-approval switch
 * has no meaningful value to override, so a flag the base argv already carries
 * (`--auto-approve`, `--flag=value`, and a separate value in the case of
 * `["--permission-mode", "dangerous"]`) is left untouched and simply not
 * duplicated. Exported for the argv unit tests.
 */
export function withPermissionArgs(
  baseArgs: string[],
  permissionArgs: string[] | undefined,
): string[] {
  if (!permissionArgs || permissionArgs.length === 0) return [...baseArgs];

  const result = [...baseArgs];
  const appended: string[] = [];
  const present = (flag: string) =>
    [...result, ...appended].some((arg) => arg === flag || arg.startsWith(`${flag}=`));

  for (let i = 0; i < permissionArgs.length; i++) {
    const token = permissionArgs[i];
    if (!token.startsWith("-") || token === "-") {
      // A bare value (only meaningful right after its flag) — keep it.
      appended.push(token);
      continue;
    }
    if (present(token)) {
      // Already on the command line: drop the flag *and* its separate value.
      const value = permissionArgs[i + 1];
      if (value !== undefined && !value.startsWith("-")) i++;
      continue;
    }
    appended.push(token);
  }

  return appended.length === 0 ? result : [...result, ...appended];
}

/**
 * The **effective** auto-approval flags for a subprocess runtime (Phase 2C): the
 * wired flags, or an empty list when auto-approval was explicitly opted out of
 * (`autoApprovePermissions: false`). Single pure helper shared by the session's
 * argv construction and the once-per-runtime notice so the log can never diverge
 * from what is actually spawned (REV-2C-005). Exported for the unit tests.
 */
export function effectivePermissionArgs(
  options: Pick<GenericSubprocessOptions, "autoApprovePermissions" | "permissionArgs">,
): string[] {
  if (options.autoApprovePermissions === false) return [];
  return options.permissionArgs ?? [];
}

/**
 * Builds the argv tokens that carry the prompt as the **value** of the CLI's own
 * flag (SEC-304).
 *
 * A flag ending in `=` is emitted as a single inline token (`--prompt=<text>`):
 * node:util `parseArgs` (kimi's parser — not Commander) resolves that shape even
 * when the text begins with `-`, whereas the two-token form (`-p <text>`) is
 * reported as ambiguous for such a value. Any other flag keeps the two-token
 * shape. Exported for the argv unit tests.
 */
export function buildPromptValueArgs(flag: string, text: string): string[] {
  return flag.endsWith("=") ? [`${flag}${text}`] : [flag, text];
}

/**
 * Truthfulness guard for config-discovered servers (REQ-30 / AC-30.1).
 *
 * This adapter holds **no MCP client**: it can read `.huginn/mcp.json` and the
 * agent's own config files, but it can never talk to the servers they declare.
 * A declaration is therefore evidence of *configuration*, never of liveness, so
 * anything that would be reported as `connected` becomes `unknown`; the badge
 * then shows `⚪ n unverified` instead of the previously fabricated always-green
 * `🟢 n active`. Explicit failure states declared in the file (or produced by an
 * unreadable/invalid file) are kept: they are honest already.
 */
export function asUnverifiedServer(entry: McpServerStatus): McpServerStatus {
  if (entry.status === "error" || entry.status === "disconnected") return entry;
  return { ...entry, status: "unknown" };
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

  /**
   * The auto-approval flags every prompt of this session is launched with
   * (Phase 2C). Empty when the runtime has none wired, or when auto-approval
   * was explicitly opted out of — in that case the CLI's own permission
   * behaviour applies and it may block on an approval nobody can answer.
   */
  private autoApproveArgs(): string[] {
    return effectivePermissionArgs(this.runtimeOptions);
  }

  async prompt(text: string, options?: PromptOptions): Promise<PromptResult> {
    if (this.aborted) {
      throw new Error(`Session ${this.id} was aborted`);
    }
    if (this.isPrompting) {
      throw new Error(`Session ${this.id} already has a prompt in progress`);
    }

    const command = this.runtimeOptions.command;
    // Phase 2C: the model flag is replaced (AC-27.5) while the auto-approval
    // flags are only ever added once — a CLI that asks for permission cannot be
    // answered (stdin is closed after the prompt), so it must never be given the
    // chance to ask.
    const baseArgs = withPermissionArgs(
      withModelArgs(
        this.runtimeOptions.args ?? [],
        this.runtimeOptions.modelArgs,
        options?.model,
      ),
      this.autoApproveArgs(),
    );
    const cwd = options?.directory ?? this.sessionOptions.directory ?? this.runtimeOptions.projectPath ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? this.runtimeOptions.defaultTimeoutMs ?? 120000;

    // SEC-002: Do NOT pass full prompt text as an argv positional command line argument.
    // Prefer streaming prompt text safely via child.stdin.write(text); child.stdin.end().
    // If promptViaStdin is explicitly set to false, hand the prompt over through
    // the CLI's own channel: a prompt *file* when the CLI has one
    // (`promptFileFlag`), otherwise a flag *value* (`promptValueFlag`, the last
    // resort — see `GenericSubprocessOptions`), and only failing both as a
    // positional after a `--` end-of-options delimiter.
    const useStdin = this.runtimeOptions.promptViaStdin !== false;
    const promptFileFlag = this.runtimeOptions.promptFileFlag;
    const promptValueFlag = this.runtimeOptions.promptValueFlag;
    let childArgs: string[];
    // REV-3A-001: the directory holding the temp prompt file (when
    // `promptFileFlag` is wired) is owned by this prompt and removed as soon as
    // the prompt settles.
    let promptDir: string | undefined;

    // Guard the whole async arg-prep path below (the temp prompt file is written
    // with `await`) so two prompts can never overlap on one session.
    this.isPrompting = true;
    try {
      if (useStdin) {
        childArgs = [...baseArgs];
      } else if (promptFileFlag) {
        // A CLI that needs the prompt as an argument but rejects prompts larger
        // than `ARG_MAX` (devin `-p`): hand it the prompt through a private temp
        // file via its own `--prompt-file` flag. No length cap on this path.
        promptDir = await mkdtemp(join(tmpdir(), "huginn-prompt-"));
        const promptFile = join(promptDir, "prompt.txt");
        try {
          await writeFile(promptFile, text, { encoding: "utf8", mode: 0o600 });
        } catch (err) {
          rmSync(promptDir, { recursive: true, force: true });
          promptDir = undefined;
          throw new Error(`Could not write the temporary prompt file: ${(err as Error).message}`);
        }
        childArgs = [...baseArgs, promptFileFlag, promptFile];
      } else {
        const maxLen = this.runtimeOptions.maxPromptArgLength ?? DEFAULT_MAX_PROMPT_ARG_LENGTH;
        // SEC-302: the kernel's `MAX_ARG_STRLEN` bounds the argument in *bytes*,
        // not UTF-16 code units, so a multi-byte prompt must be measured with
        // `Buffer.byteLength` — `text.length` would under-count it (and would
        // let an over-limit non-ASCII prompt through to the spawn).
        const promptBytes = Buffer.byteLength(text, "utf8");
        if (promptBytes > maxLen) {
          throw new Error(
            `Prompt length (${promptBytes} bytes) exceeds maximum command line argument limit (${maxLen})`,
          );
        }
        childArgs = promptValueFlag
          ? // Phase 3C/SEC-304: the CLI takes the prompt as the *value* of its own
            // flag (kimi). A flag ending in `=` yields one unambiguous
            // `--prompt=<text>` token; otherwise the two-token `-p <text>` shape
            // (see `buildPromptValueArgs`). No `--` delimiter here: the text *is*
            // the flag's value, so it would just become part of the prompt.
            [...baseArgs, ...buildPromptValueArgs(promptValueFlag, text)]
          : baseArgs.includes("--")
            ? [...baseArgs, text]
            : [...baseArgs, "--", text];
      }
    } catch (err) {
      this.isPrompting = false;
      throw err;
    }

    return new Promise<PromptResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let settled = false;

      // REV-3A-001: best-effort removal of the per-prompt temp file. Called from
      // every settle path (close/error/timeout/abort) and from a failed spawn.
      const removePromptFile = () => {
        if (!promptDir) return;
        try {
          rmSync(promptDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
        promptDir = undefined;
      };

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
        removePromptFile();
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
        removePromptFile();
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
  /**
   * Phase 4A: a subprocess CLI is **one-shot**. `prompt()` spawns a brand-new
   * process, prints the prompt into its stdin (or its own prompt flag) and the
   * process exits — nothing survives to the next call, not even the session id
   * (the generic session is a UUID this adapter mints locally). Callers that want
   * context across turns must therefore send a self-contained body; the live
   * engine does exactly that for every runtime whose `sessionHistory` is not
   * `true`.
   */
  readonly sessionHistory = false;
  /**
   * A subprocess buffers its stdout and resolves once, so there is no incremental
   * channel: the panel shows the phase report instead of pretending to wait
   * (REQ-51 / AC-51.3).
   */
  readonly streamsOutput = false;
  protected options: GenericSubprocessOptions;
  /** Guards the once-per-runtime permission log (Phase 2C). */
  private permissionNoticeEmitted = false;

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

  /**
   * Enumerates the servers *this agent* has, through the agent's own CLI
   * (REQ-32 / AC-32.1).
   *
   * A runtime with a verified listing command (`mcpListCommand`) spawns it under
   * a bounded deadline; one without (`omp`, `kimi`, `pi`, `cursor`, `codex`,
   * `mcode`) resolves `[]` — an explicit "I have no way to enumerate", which the
   * status helper turns into config-file discovery rather than an empty truth.
   * Never throws: a failed spawn is an empty listing, not a crash.
   */
  async listMcpServers(): Promise<McpServerListing[]> {
    const spec = this.options.mcpListCommand;
    if (!spec) return [];
    return listMcpServersViaCommand(spec, { env: this.options.env });
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
            const entry = asUnverifiedServer(parseMcpServerEntry(name, val));
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
                // AC-30.1: a declaration in a config file is not a liveness proof.
                status: "unknown",
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
                servers.push(asUnverifiedServer(parseMcpServerEntry(name, val)));
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
    // AC-30.1: an unverified (`unknown`) server is never healthy — only a real
    // probe may claim that — so a config-only report is honest-but-not-green.
    const healthy = servers.length > 0 && servers.every((s) => s.status === "connected");
    const unverified = servers.some((s) => s.status === "unknown");
    const degraded = servers.some((s) => s.status === "error");

    return {
      servers,
      totalTools,
      healthy,
      unverified,
      degraded,
    };
  }

  async createSession(options: SessionOptions): Promise<IAgentSession> {
    this.announcePermissionMode();
    const sessionId = randomUUID();
    return new GenericSubprocessSession(sessionId, this.options, options);
  }

  /**
   * Phase 2C transparency, emitted once per runtime (the first session it
   * creates — not on every prompt): subprocess runtimes can only ever run
   * auto-approved, so the user must be able to see *which* switch was used.
   *
   * REV-2C-002: the flag is only described as "auto-approved" when it is
   * verified; an assumed flag (`permissionArgsVerified: false`) is announced as
   * a `warn` that it is unverified and the CLI may still prompt. `ask`/`deny`
   * are handled fail-closed by the CLI (REV-2C-001), so nothing is ever claimed
   * for them here.
   */
  private announcePermissionMode(): void {
    if (this.permissionNoticeEmitted) return;
    this.permissionNoticeEmitted = true;

    if ((this.options.permissions ?? "auto") !== "auto") return;

    const flags = effectivePermissionArgs(this.options);
    if (flags.length === 0) return;

    const flagText = flags.join(" ");
    if (this.options.permissionArgsVerified === false) {
      events.emit("log", {
        level: "warn",
        message: `[huginn] ${this.id}: assuming ${flagText}; not verified — the CLI may still prompt`,
      });
      return;
    }

    events.emit("log", {
      level: "info",
      message: `[huginn] ${this.id}: running with ${flagText} (auto-approved permissions)`,
    });
  }
}
