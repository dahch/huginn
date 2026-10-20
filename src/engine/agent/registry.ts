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
import { toLegacyRuntime, toRuntimePort } from "./legacy-bridge.js";
import { createPiSdkPort } from "./drivers/pi-sdk.js";
import { createCodexSdkPort } from "./drivers/codex-sdk.js";
import { createClaudeSdkPort } from "./drivers/claude-sdk.js";
import type { RuntimeCapabilities, RuntimePort } from "./port.js";
import type { PermissionMode } from "../../config.js";
import {
  CLAUDE_PERMISSION_ARGS,
  CODEX_PERMISSION_ARGS,
  ClaudeRuntimeAdapter,
  CodexRuntimeAdapter,
  GenericSubprocessRuntimeAdapter,
  OpencodeRuntimeAdapter,
  PI_PERMISSION_ARGS,
  PiRuntimeAdapter,
} from "./adapters/index.js";
import {
  AGY_PERMISSION_ARGS,
  COMMANDCODE_PERMISSION_ARGS,
  CURSOR_PERMISSION_ARGS,
  DEVIN_PERMISSION_ARGS,
  GENERIC_TARGET_SPECS,
  KIMI_PERMISSION_ARGS,
  MCODE_PERMISSION_ARGS,
  MIMO_PERMISSION_ARGS,
  OMP_PERMISSION_ARGS,
  QWEN_PERMISSION_ARGS,
  isGenericTarget,
  type GenericTarget,
} from "./genericTargets.js";

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
 * Auto-approval flag of every subprocess runtime (Phase 2C).
 *
 * These are the CLIs' **own** switches, not a huginn protocol: they are what
 * keeps the cycle from stalling when a CLI would otherwise wait for an approval
 * that can never arrive (stdin is closed after the prompt). Each flag can shift
 * between CLI versions — re-verify with `<cli> --help` before trusting it.
 *
 * The generic rows and the dedicated adapters share the exact same array
 * instance as their spec/class (REV-3A-004), so the documented table cannot
 * drift from what is spawned.
 */
export const SUBPROCESS_PERMISSION_ARGS: Record<AgentTarget, string[]> = {
  claude: CLAUDE_PERMISSION_ARGS,
  codex: CODEX_PERMISSION_ARGS,
  pi: PI_PERMISSION_ARGS,
  cursor: CURSOR_PERMISSION_ARGS,
  agy: AGY_PERMISSION_ARGS,
  commandcode: COMMANDCODE_PERMISSION_ARGS,
  devin: DEVIN_PERMISSION_ARGS,
  kimi: KIMI_PERMISSION_ARGS,
  mcode: MCODE_PERMISSION_ARGS,
  mimo: MIMO_PERMISSION_ARGS,
  omp: OMP_PERMISSION_ARGS,
  qwen: QWEN_PERMISSION_ARGS,
  opencode: [],
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
 * Build the configured generic bridge for a CLI-only provisioning target (M4b).
 *
 * The target keeps its `AgentTarget` id (provisioning, MCP paths, display) while
 * the port layer maps it to the `generic` runtime id. Its argv is the one the
 * deleted adapter carried, so behaviour is unchanged.
 */
function buildGenericRuntime(target: GenericTarget, options: RuntimeOptions): IAgentRuntime {
  const spec = GENERIC_TARGET_SPECS[target];
  return new GenericSubprocessRuntimeAdapter({
    id: target,
    name: spec.name,
    command: spec.command,
    fallbackCommands: spec.fallbackCommands ? [...spec.fallbackCommands] : undefined,
    args: [...spec.args],
    promptViaStdin: spec.promptViaStdin,
    promptFileFlag: spec.promptFileFlag,
    promptValueFlag: spec.promptValueFlag,
    maxPromptArgLength: spec.maxPromptArgLength,
    modelArgs: options.modelArgs ?? spec.modelArgs,
    permissionArgs: options.permissionArgs ?? [...spec.permissionArgs],
    permissionArgsVerified: spec.permissionArgsVerified,
    permissions: options.permissions,
    projectPath: options.projectPath,
    homeDir: options.homeDir,
    env: options.env,
  });
}

/**
 * The CLI-shaped runtime factory: provisioning, model discovery and the
 * argv-level tests keep this shape.
 *
 * The four targets with a dedicated driver return it (`pi`, `opencode`,
 * `codex`, `claude`). Every other target — including the eight retired CLI
 * adapters — is a **configured generic runtime**, so `--agent kimi` keeps
 * working during the migration without another adapter class.
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
    case "pi":
      // The native driver (`getRuntimePort("pi")`) is not routed here on purpose:
      // the engine still speaks `IAgentRuntime`, and this path's argv behaviour is
      // covered by tests that only the engine switch can safely retire.
      return new PiRuntimeAdapter(options);
    default:
      break;
  }

  if (isGenericTarget(target)) return buildGenericRuntime(target, options);

  throw new Error(`Unknown agent target: "${String(target)}". Supported targets: ${AGENT_TARGETS.join(", ")}`);
}

/**
 * Capabilities of the single generic driver, stated honestly: it is a bridged
 * subprocess, so it has no events, no history, no resume, no catalog listing and
 * no MCP listing of its own.
 */
const GENERIC_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  inProcess: false,
  structuredEvents: false,
  streaming: false,
  permissions: "none",
  sessionHistory: false,
  sessionResume: false,
  modelCatalog: "none",
  structuredOutput: false,
  usageCost: false,
  mcpListing: false,
  interrupt: true,
};

/**
 * The `generic` runtime as a catalog entry, for `huginn runtime list`.
 *
 * There is no single binary to probe: the driver runs whichever CLI-only target
 * is selected, so availability means "at least one of them is installed".
 * `createSession` cannot pick a target on its own and says so instead of
 * silently running the wrong CLI.
 */
export function getGenericRuntimePort(options: RuntimeOptions = {}): RuntimePort {
  return {
    id: "generic",
    name: "Generic CLI bridge",
    capabilities: GENERIC_RUNTIME_CAPABILITIES,

    async isAvailable() {
      const detected = await detectAvailableAgents(options.env?.PATH ?? process.env.PATH ?? "");
      const available = detected.filter((entry) => isGenericTarget(entry.id) && entry.available);
      if (available.length === 0) {
        return {
          ok: false,
          reason:
            "no generic-target CLI is installed (cursor, agy, commandcode, devin, kimi, mcode, mimo, omp, qwen)",
        };
      }
      return { ok: true, path: available[0]?.path };
    },

    async listModels() {
      return {
        models: [],
        reason: "the generic runtime discovers models through a concrete agent target",
      };
    },

    resolveModel(reference: string) {
      const model = reference.trim();
      return model === ""
        ? { ok: false, reason: "the model reference is empty" }
        : { ok: true, model };
    },

    async createSession() {
      throw new Error(
        'the generic runtime needs a concrete agent target; use getRuntimePort("<target>")',
      );
    },
  };
}

/**
 * The runtime port for a target (or for the `generic` driver itself).
 *
 * Until a driver implements the port natively, this is the legacy adapter behind
 * {@link toRuntimePort}: identical behaviour, with capabilities stated instead
 * of implied. New drivers register here by returning their own `RuntimePort`.
 */
export function getRuntimePort(target: AgentTarget | "generic", options: RuntimeOptions = {}): RuntimePort {
  if (target === "generic") return getGenericRuntimePort(options);
  // Drivers that own their SDK; every other target is still the legacy adapter
  // behind the bridge until its driver lands.
  if (target === "pi") return createPiSdkPort();
  if (target === "codex") return createCodexSdkPort();
  if (target === "claude") return createClaudeSdkPort();
  return toRuntimePort(getAgentRuntime(target, options));
}

/**
 * The runtime the **cycle** executes.
 *
 * Deliberately separate from {@link getAgentRuntime}: that factory still returns
 * the CLI-shaped adapters, which is what provisioning, model discovery and the
 * argv-level tests rely on. Here, a target with a native driver runs it (pi,
 * codex, claude) presented through the reverse bridge until the engines consume
 * `RuntimePort` directly; every other target is the configured generic bridge.
 */
export function getEngineRuntime(target: AgentTarget, options: RuntimeOptions = {}): IAgentRuntime {
  if (target === "pi") return toLegacyRuntime(createPiSdkPort());
  if (target === "codex") return toLegacyRuntime(createCodexSdkPort());
  if (target === "claude") return toLegacyRuntime(createClaudeSdkPort());
  return getAgentRuntime(target, options);
}
