import { delimiter, join } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { AGENT_REGISTRY, AGENT_TARGETS, type AgentTarget } from "../../agents/integrator.js";
import type { IAgentRuntime } from "./types.js";
import {
  AGY_MCP_LIST_TIMEOUT_MS,
  ClaudeRuntimeAdapter,
  CodexRuntimeAdapter,
  CommandCodeRuntimeAdapter,
  GenericSubprocessRuntimeAdapter,
  OmpRuntimeAdapter,
  OpencodeRuntimeAdapter,
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
  windsurf: ["windsurf"],
  gemini: ["gemini"],
  agy: ["agy"],
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
}

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

  if (sources.flagAgent && sources.flagAgent.trim().length > 0) {
    return validateTarget(sources.flagAgent);
  }

  if (sources.projectConfig?.agent && sources.projectConfig.agent.trim().length > 0) {
    return validateTarget(sources.projectConfig.agent);
  }

  if (sources.userConfig?.agent && sources.userConfig.agent.trim().length > 0) {
    return validateTarget(sources.userConfig.agent);
  }

  const env = sources.env ?? process.env;
  if (env.HUGINN_AGENT && env.HUGINN_AGENT.trim().length > 0) {
    return validateTarget(env.HUGINN_AGENT);
  }

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
      return new GenericSubprocessRuntimeAdapter({
        id: "kimi",
        name: "Kimi Code CLI",
        command: "kimi",
        // REV-003/S1: `kimi` is not installed on the reference machine, so this
        // flag is unverified-but-conventional (kimi-code follows the `-m`
        // convention of its siblings); `RuntimeOptions.modelArgs` overrides it.
        modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
        projectPath: options.projectPath,
        homeDir: options.homeDir,
        env: options.env,
      });
    case "pi":
      return new GenericSubprocessRuntimeAdapter({
        id: "pi",
        name: "Pi coding agent",
        command: "pi",
        // REV-003/S1: not installed on the reference machine — unverified but
        // conventional (`-m`), and overridable via `RuntimeOptions.modelArgs`.
        modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
        projectPath: options.projectPath,
        homeDir: options.homeDir,
        env: options.env,
      });
    // REQ-27: `gemini`, `kimi`, `pi`, `cursor` and `windsurf` expose no listing
    // command (verified by probing `--help` where installed), so discovery is
    // honestly empty (`[]` — the `${id}/default` placeholder is gone) and the
    // picker offers free-text ids. `agy` *does* list (`agy models`) and is wired
    // below.
    case "gemini":
      return new GenericSubprocessRuntimeAdapter({
        id: "gemini",
        name: AGENT_REGISTRY.gemini?.label ?? "gemini",
        command: "gemini",
        modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
        projectPath: options.projectPath,
        homeDir: options.homeDir,
        env: options.env,
      });
    case "agy":
      return new GenericSubprocessRuntimeAdapter({
        id: "agy",
        name: AGENT_REGISTRY.agy?.label ?? "agy",
        command: "agy",
        modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
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
    case "windsurf":
      return new GenericSubprocessRuntimeAdapter({
        id: target,
        name: AGENT_REGISTRY[target]?.label ?? target,
        command: target,
        // REV-003/S1: neither CLI is installed on the reference machine, so the
        // flag is unverified-but-conventional (`--model`); overridable via
        // `RuntimeOptions.modelArgs`.
        modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
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
