import { delimiter, join } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  AGENT_REGISTRY,
  AGENT_TARGETS,
  REMOVED_AGENT_TARGETS,
  type AgentTarget,
} from "../../agents/integrator.js";
import type { IAgentRuntime } from "./types.js";
import type { PermissionMode } from "../../config.js";
import {
  AGY_MCP_LIST_TIMEOUT_MS,
  ClaudeRuntimeAdapter,
  CodexRuntimeAdapter,
  CommandCodeRuntimeAdapter,
  DEVIN_PERMISSION_ARGS,
  DevinRuntimeAdapter,
  GenericSubprocessRuntimeAdapter,
  KIMI_PERMISSION_ARGS,
  KimiRuntimeAdapter,
  MCODE_PERMISSION_ARGS,
  MIMO_PERMISSION_ARGS,
  McodeRuntimeAdapter,
  MimoRuntimeAdapter,
  OmpRuntimeAdapter,
  OpencodeRuntimeAdapter,
  PI_PERMISSION_ARGS,
  PiRuntimeAdapter,
  QwenRuntimeAdapter,
  parseAgyMcpList,
  parseAgyModels,
} from "./adapters/index.js";

export const AGENT_BINARIES: Record<AgentTarget, string[]> = {
  opencode: ["opencode"],
  claude: ["claude"],
  codex: ["codex"],
  omp: ["omp"],
  commandcode: ["commandcode", "command-code"],
  qwen: ["qwen", "qwen-code"],
  kimi: ["kimi", "kimi-code"],
  pi: ["pi"],
  cursor: ["cursor"],
  devin: ["devin"],
  agy: ["agy"],
  // Phase 3B: both CLIs install a single `mcode`/`mimo` binary shim (the
  // MiniMax Code launcher under `~/.minimax-code/bin` and the MiMo Code
  // executable under `~/.mimocode/bin`), so there is no secondary name to try.
  mcode: ["mcode"],
  mimo: ["mimo"],
};

export interface RuntimeOptions {
  projectPath?: string;
  homeDir?: string;
  client?: OpencodeClient;
  baseUrl?: string;
  port?: number;
  serverTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  /**
   * Overrides the runtime's native model flag (AC-27.5). Defaults to the flag
   * documented by each CLI; injectable so a wrapper (or a test) can pin the
   * argv without forking the registry.
   */
  modelArgs?: (model: string) => string[];
  /**
   * Overrides the runtime's auto-approval flag(s) (Phase 2C). Defaults to the
   * CLI's own switch (see {@link SUBPROCESS_PERMISSION_ARGS}); injectable for
   * the same reason as `modelArgs`.
   */
  permissionArgs?: string[];
  /**
   * Huginn's `--permissions` mode (Phase 2C). A subprocess runtime closes stdin
   * after the prompt, so `ask`/`deny` cannot be honoured: the CLI refuses to
   * start one in those modes (REV-2C-001) rather than running it more
   * permissively than requested. opencode ignores this option — its permissions
   * are enforced through the engine's event subscriber (`src/engine/permissions.ts`).
   */
  permissions?: PermissionMode;
}

/**
 * REV-2C-001: the message used to fail closed when `ask`/`deny` is requested for
 * a subprocess runtime, which has no channel back to huginn mid-turn. Shared by
 * the CLI gate (`run`/`runLive`) and `LiveEngine.switchRuntime` so both refuse
 * with the same words.
 */
export function subprocessPermissionMessage(
  runtimeId: string,
  permissions: PermissionMode,
): string {
  return (
    `[huginn] --permissions ${permissions} is not supported for the "${runtimeId}" subprocess runtime ` +
    `(it cannot ask huginn mid-turn). Use "auto" (default) or choose the opencode runtime.`
  );
}

/**
 * Auto-approval flag of every subprocess runtime (Phase 2C), used by the
 * runtimes whose adapter is constructed inline here. The class-based adapters
 * (`claude`, `codex`, `omp`, `commandcode`, `qwen`, `devin`, `kimi`, `pi`)
 * carry the same value as an exported constant next to their runtime —
 * `devin`/`kimi`/`pi` reuse {@link DEVIN_PERMISSION_ARGS} /
 * {@link KIMI_PERMISSION_ARGS} / {@link PI_PERMISSION_ARGS} directly so the
 * documented table and the adapter cannot drift (REV-3A-004).
 *
 * These are the CLIs' **own** switches, not a huginn protocol: they are what
 * keeps the cycle from stalling when a CLI would otherwise wait for an approval
 * that can never arrive (stdin is closed after the prompt). Each flag can shift
 * between CLI versions — re-verify with `<cli> --help` before trusting it.
 */
export const SUBPROCESS_PERMISSION_ARGS: Partial<Record<AgentTarget, string[]>> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  qwen: ["-y"],
  omp: ["--auto-approve"],
  commandcode: ["--yolo"],
  // Phase 3C: kimi's prompt mode (`-p <prompt>`) *rejects* every permission
  // switch ("Cannot combine --prompt with --auto" / `--yolo` / `--plan`) and
  // forces the session's permission mode to `auto` (Never Ask) itself, so the
  // correct flag list is empty — the previous `["--auto"]` made every prompt
  // fail. Same array instance as the adapter, so the table cannot drift.
  kimi: KIMI_PERMISSION_ARGS,
  pi: PI_PERMISSION_ARGS,
  cursor: ["-f"],
  // Phase 3A: `devin --permission-mode dangerous` auto-approves every tool
  // (verified with `devin --help`) and replaces the old `windsurf` target. The
  // flags live next to the adapter; this is the same array instance, so the
  // adapter can never diverge from the table.
  devin: DEVIN_PERMISSION_ARGS,
  agy: ["--dangerously-skip-permissions"],
  // Phase 3B: `mcode exec --permission full` (verified live — the `smart`
  // default still decides per action, `full` auto-approves) and `mimo run
  // --yolo` (the `run` subcommand's own auto-approval switch; its *global*
  // `--trust`/`--never-ask` are rejected by `run`). Same array instances as the
  // adapters, so the table cannot drift.
  mcode: MCODE_PERMISSION_ARGS,
  mimo: MIMO_PERMISSION_ARGS,
};

export interface AgentResolutionSources {
  flagAgent?: string;
  projectConfig?: { agent?: string };
  userConfig?: { agent?: string };
  env?: Record<string, string | undefined>;
}

import { isExecutableBinary } from "./binaryUtils.js";
export { isExecutableBinary };

function findBinaryPath(candidates: string[], pathEnv: string): string | undefined {
  const dirs = pathEnv.split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const bin of candidates) {
      const full = join(dir, bin);
      if (isExecutableBinary(full)) {
        return full;
      }
    }
  }
  return undefined;
}

/**
 * Narrow an arbitrary string to a registered {@link AgentTarget}. The single
 * allowlist check shared by `resolveAgent`, the CLI and the init wizard, so
 * none of them re-implements the `AGENT_TARGETS` membership test.
 */
export function isAgentTarget(value: string): value is AgentTarget {
  return (AGENT_TARGETS as readonly string[]).includes(value);
}

/**
 * Scan PATH to discover installed CLI binaries for all known agent targets.
 */
export async function detectAvailableAgents(
  pathEnv: string = process.env.PATH ?? "",
): Promise<Array<{ id: AgentTarget; available: boolean; path?: string }>> {
  const results: Array<{ id: AgentTarget; available: boolean; path?: string }> = [];

  for (const target of AGENT_TARGETS) {
    const candidates = AGENT_BINARIES[target] ?? [target];
    const foundPath = findBinaryPath(candidates, pathEnv);
    results.push({
      id: target,
      available: foundPath !== undefined,
      path: foundPath,
    });
  }

  return results;
}

/**
 * Resolve the effective AgentTarget with strict precedence:
 * CLI flag --agent -> project config -> user config -> HUGINN_AGENT env -> first detected available agent -> fallback to opencode.
 */
export async function resolveAgent(sources: AgentResolutionSources = {}): Promise<AgentTarget> {
  const validateTarget = (val: string): AgentTarget => {
    const candidate = val.trim().toLowerCase();
    if (!isAgentTarget(candidate)) {
      throw new Error(`Unknown agent target: "${val}". Supported targets: ${AGENT_TARGETS.join(", ")}`);
    }
    return candidate;
  };

  /**
   * A *persisted* agent that was **removed** (e.g. `gemini`, superseded by `agy`)
   * must not break the run: warn and fall through to detection, so an old
   * `.huginn/config.json` keeps working (AC-35.3). An arbitrary unknown value is
   * still rejected, so a hostile config cannot name an arbitrary binary (SEC-001).
   */
  const fromStoredConfig = (val: string | undefined, where: string): AgentTarget | undefined => {
    const candidate = val?.trim().toLowerCase();
    if (!candidate) return undefined;
    if (isAgentTarget(candidate)) return candidate;
    if (REMOVED_AGENT_TARGETS.has(candidate)) {
      console.warn(
        `[huginn] ⚠ the agent "${candidate}" in ${where} was removed ` +
          `(superseded by "${REMOVED_AGENT_TARGETS.get(candidate)}"); falling back to auto-detection.`,
      );
      return undefined;
    }
    throw new Error(`Unknown agent target: "${val}". Supported targets: ${AGENT_TARGETS.join(", ")}`);
  };

  if (sources.flagAgent && sources.flagAgent.trim().length > 0) {
    return validateTarget(sources.flagAgent);
  }

  const projectAgent = fromStoredConfig(sources.projectConfig?.agent, "the project config");
  if (projectAgent) return projectAgent;

  const userAgent = fromStoredConfig(sources.userConfig?.agent, "the user config");
  if (userAgent) return userAgent;

  const env = sources.env ?? process.env;
  // REV-3A-005: route `HUGINN_AGENT` through the same softening as a persisted
  // config, so a *removed* value (e.g. `windsurf`, now `devin`) warns and falls
  // through to detection instead of crashing the run. An arbitrary unknown value
  // is still rejected by `fromStoredConfig` (SEC-001) — only the removed-target
  // case is degraded.
  const envAgent = fromStoredConfig(env.HUGINN_AGENT, "the HUGINN_AGENT environment variable");
  if (envAgent) return envAgent;

  const detected = await detectAvailableAgents(env.PATH ?? process.env.PATH ?? "");
  const firstAvailable = detected.find((d) => d.available);
  if (firstAvailable) {
    return firstAvailable.id;
  }

  return "opencode";
}

/**
 * Factory for creating an IAgentRuntime adapter for the requested AgentTarget.
 */
export function getAgentRuntime(target: AgentTarget, options: RuntimeOptions = {}): IAgentRuntime {
  if (!AGENT_TARGETS.includes(target)) {
    throw new Error(`Unknown agent target: "${String(target)}". Supported targets: ${AGENT_TARGETS.join(", ")}`);
  }

  switch (target) {
    case "opencode":
      return new OpencodeRuntimeAdapter(options);
    case "claude":
      return new ClaudeRuntimeAdapter(options);
    case "codex":
      return new CodexRuntimeAdapter(options);
    case "omp":
      return new OmpRuntimeAdapter(options);
    case "commandcode":
      return new CommandCodeRuntimeAdapter(options);
    case "qwen":
      return new QwenRuntimeAdapter(options);
    case "kimi":
      // Phase 3C: `KimiRuntimeAdapter` owns kimi's real non-interactive shape
      // (`-p <prompt>` as a flag *value*, no stdin/`--prompt-file` channel), its
      // empty permission-flag list and `kimi provider list --json` discovery.
      return new KimiRuntimeAdapter(options);
    case "pi":
      // Phase 3C: `PiRuntimeAdapter` owns pi's print mode (`-p` + prompt on
      // stdin), its verified `--model` flag, `pi --list-models` discovery and
      // the assumed (`--approve`) project-trust flag.
      return new PiRuntimeAdapter(options);
    // REQ-27 / REQ-35.3: `cursor` exposes no listing command (verified by
    // probing `--help` where installed), so discovery is honestly empty (`[]` —
    // the `${id}/default` placeholder is gone) and the picker offers free-text
    // ids. `agy` (`agy models`), `devin` (`devin models list`), `pi`
    // (`pi --list-models`) and `kimi` (`kimi provider list --json`) *do* list and
    // are wired in their own adapters. (`gemini` was removed entirely: its
    // non-interactive form needs `-p <arg>` and it is superseded by `agy`.)
    case "devin":
      return new DevinRuntimeAdapter(options);
    // Phase 3B. `mcode` is a commandcode-style single-shot CLI: `exec
    // --input -` + `--permission full`, with **no** model listing (`mcode
    // provider list` enumerates providers only, each with an empty `models`
    // array) and no `mcp` command at all — both are honestly absent rather than
    // fabricated. `mimo` is the opencode-style one: `run` reads the prompt from
    // stdin, plus `mimo models` / `mimo mcp list`.
    case "mcode":
      return new McodeRuntimeAdapter(options);
    case "mimo":
      return new MimoRuntimeAdapter(options);
    case "agy":
      return new GenericSubprocessRuntimeAdapter({
        id: "agy",
        name: AGENT_REGISTRY.agy?.label ?? "agy",
        command: "agy",
        modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
        permissionArgs: options.permissionArgs ?? SUBPROCESS_PERMISSION_ARGS.agy,
        permissions: options.permissions,
        modelListCommand: {
          command: "agy",
          args: ["models"],
          parse: parseAgyModels,
        },
        // REQ-32 / AC-32.1: `agy mcp list` prints its own name/type/status table
        // (statuses are `enabled`/`disabled` — configuration words, never a probe
        // result), so its rows are mapped honestly and are never called live.
        mcpListCommand: {
          command: "agy",
          args: ["mcp", "list"],
          parse: parseAgyMcpList,
          timeoutMs: AGY_MCP_LIST_TIMEOUT_MS,
        },
        projectPath: options.projectPath,
        homeDir: options.homeDir,
        env: options.env,
      });
    case "cursor":
      return new GenericSubprocessRuntimeAdapter({
        id: target,
        name: AGENT_REGISTRY[target]?.label ?? target,
        command: target,
        // REV-003/S1: `cursor` is not installed on the reference machine, so the
        // flag is unverified-but-conventional (`--model`); overridable via
        // `RuntimeOptions.modelArgs`.
        modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
        // Phase 2C: `cursor -f` is verified; the flag is announced as
        // auto-approved.
        permissionArgs: options.permissionArgs ?? SUBPROCESS_PERMISSION_ARGS[target],
        permissionArgsVerified: true,
        permissions: options.permissions,
        projectPath: options.projectPath,
        homeDir: options.homeDir,
        env: options.env,
      });
    default: {
      const _exhaustiveCheck: never = target;
      throw new Error(`Unknown agent target: "${String(target)}". Supported targets: ${AGENT_TARGETS.join(", ")}`);
    }
  }
}
