import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PhaseName } from "./engine/types";
import { AGENT_TARGETS, REMOVED_AGENT_TARGETS } from "./agents/integrator";

export interface RunConfig {
  projectPath: string;
  planPath: string;
  specPath: string;
  adrPath: string;
  thinker: string;
  executor: string;
  agent?: string;
  mode: "auto" | "supervised";
  permissions: "auto" | "ask" | "deny";
  maxRetries: number;
  fromIteration?: number;
  onlyPhase?: PhaseName;
  tui: boolean;
  port: number;
  serverTimeoutMs: number;
  phaseTimeoutMs: number;
  ignorePlanChanges: boolean;
  chooseModel?: boolean;
  sandbox: boolean;
}

/**
 * Persistent user/project configuration (REQ-14). The three documented keys are
 * typed; unknown keys are preserved verbatim so forward-compatible configs and
 * third-party tooling never lose data on a round-trip.
 */
export interface UserConfig {
  thinker?: string;
  executor?: string;
  agent?: string;
  mode?: "auto" | "supervised";
  [key: string]: unknown;
}

/**
 * Injectable inputs for model resolution. All layers are optional so the
 * resolver stays pure and unit-testable without touching the environment.
 */
export interface ModelSources {
  flagThinker?: string;
  flagExecutor?: string;
  flagAgent?: string;
  projectConfig?: UserConfig;
  userConfig?: UserConfig;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_THINKER_MODEL = "anthropic/claude-opus-4-5";
export const DEFAULT_EXECUTOR_MODEL = "opencode/gpt-5.1-codex";

export const ENV_THINKER_MODEL = "HUGINN_THINKER_MODEL";
export const ENV_EXECUTOR_MODEL = "HUGINN_EXECUTOR_MODEL";
export const DEFAULT_AGENT = "opencode";
export const ENV_AGENT = "HUGINN_AGENT";

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Which precedence layer supplied a resolved model value (REQ-14.2). */
export type ModelSourceName = "flag" | "project" | "user" | "env" | "default";

/** A resolved model value paired with the layer it came from. */
export interface ResolvedModel {
  value: string;
  source: ModelSourceName;
}

/** Per-role source attribution returned by {@link describeModelSources}. */
export interface ModelSourceDescriptions {
  thinker: ResolvedModel;
  executor: ResolvedModel;
}

/**
 * Single source of truth for the REQ-14.2 precedence. Every candidate is
 * normalised through {@link firstNonEmpty} so blank strings fall through, then
 * the first non-empty layer wins and the caller learns *which* layer it was.
 * Both the value resolver and the source descriptor are built on this so the
 * precedence is never duplicated.
 */
function resolveModelWithSource(
  flag: string | undefined,
  projectValue: string | undefined,
  userValue: string | undefined,
  envValue: string | undefined,
  fallback: string,
): ResolvedModel {
  const fromFlag = firstNonEmpty(flag);
  if (fromFlag !== undefined) return { value: fromFlag, source: "flag" };
  const fromProject = firstNonEmpty(projectValue);
  if (fromProject !== undefined) return { value: fromProject, source: "project" };
  const fromUser = firstNonEmpty(userValue);
  if (fromUser !== undefined) return { value: fromUser, source: "user" };
  const fromEnv = firstNonEmpty(envValue);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  return { value: fallback, source: "default" };
}

/**
 * Resolve the thinker/executor model strings with the REQ-14.2 precedence:
 * CLI flag → project config → user config → environment → documented default,
 * reporting the winning layer for each role. Pure: when `sources.env` is
 * omitted `process.env` is read; otherwise the environment is never touched.
 */
export function describeModelSources(sources: ModelSources): ModelSourceDescriptions {
  const env = sources.env ?? process.env;
  return {
    thinker: resolveModelWithSource(
      sources.flagThinker,
      sources.projectConfig?.thinker,
      sources.userConfig?.thinker,
      env[ENV_THINKER_MODEL],
      DEFAULT_THINKER_MODEL,
    ),
    executor: resolveModelWithSource(
      sources.flagExecutor,
      sources.projectConfig?.executor,
      sources.userConfig?.executor,
      env[ENV_EXECUTOR_MODEL],
      DEFAULT_EXECUTOR_MODEL,
    ),
  };
}

/**
 * Resolve the effective thinker/executor model strings with the REQ-14.2
 * precedence (see {@link describeModelSources} for the layer attribution).
 */
export function resolveModelsFromConfig(sources: ModelSources): {
  thinker: string;
  executor: string;
} {
  const described = describeModelSources(sources);
  return { thinker: described.thinker.value, executor: described.executor.value };
}

/** Absolute path of the project config file: `<project>/.huginn/config.json`. */
export function getProjectConfigPath(projectPath: string): string {
  return join(projectPath, ".huginn", "config.json");
}

/** Absolute path of the user config file: `<home>/.huginn/config.json`. */
export function getUserConfigPath(homeDir?: string): string {
  const base = homeDir || process.env.HUGINN_HOME || homedir();
  return join(base, ".huginn", "config.json");
}

/**
 * Keys that could mutate the prototype chain instead of sitting as inert data
 * properties (SEC-902). JSON.parse happily produces an own `__proto__` key, so
 * they must never be copied onto the returned config object.
 */
const DANGEROUS_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Runtime-validate a parsed config value. Known keys are type-checked (and
 * warned about when invalid); unknown keys pass through untouched. The result
 * is built on a null prototype and dangerous keys are rejected outright so a
 * malicious `__proto__`/`constructor` key can never pollute the prototype
 * (SEC-902).
 */
function sanitizeConfig(value: unknown, path: string): UserConfig {
  const out = Object.create(null) as UserConfig;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.warn(`[huginn] config ${path} is not a JSON object; ignoring`);
    return out;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_CONFIG_KEYS.has(key)) {
      console.warn(`[huginn] config ${path}: refusing dangerous key "${key}"`);
      continue;
    }
    if (key === "thinker" || key === "executor") {
      if (typeof raw === "string") out[key] = raw;
      else console.warn(`[huginn] config ${path}: "${key}" must be a string; ignoring`);
    } else if (key === "agent") {
      const candidate = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if ((AGENT_TARGETS as readonly string[]).includes(candidate)) {
        out.agent = candidate;
      } else if (REMOVED_AGENT_TARGETS.has(candidate)) {
        // A removed target (e.g. `gemini`, superseded by `agy`) is reported
        // specifically, so the user learns what to switch to rather than just
        // being told the list (AC-35.3).
        console.warn(
          `[huginn] config ${path}: agent "${candidate}" was removed ` +
            `(superseded by "${REMOVED_AGENT_TARGETS.get(candidate)}"); falling back to auto-detection`,
        );
      } else {
        console.warn(
          `[huginn] config ${path}: "agent" must be one of [${AGENT_TARGETS.join(", ")}]; ignoring`,
        );
      }
    } else if (key === "mode") {
      if (raw === "auto" || raw === "supervised") out.mode = raw;
      else console.warn(`[huginn] config ${path}: "mode" must be "auto" or "supervised"; ignoring`);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Read and validate a single JSON config file. Missing → `{}`; malformed JSON
 * or unreadable files warn and yield `{}` (fail-open on reads, never throws).
 */
function readConfigFile(path: string): UserConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[huginn] could not read config ${path}: ${(err as Error).message}; ignoring`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[huginn] malformed JSON in ${path}: ${(err as Error).message}; ignoring`);
    return {};
  }
  return sanitizeConfig(parsed, path);
}

/**
 * Read the user and project config layers *separately* (no merging) so callers
 * such as `huginn config show` can attribute a resolved value to the exact file
 * it came from. Both files fail open to `{}`.
 */
export function loadConfigLayers(
  projectPath: string,
  homeDir?: string,
): { user: UserConfig; project: UserConfig } {
  return {
    user: readConfigFile(getUserConfigPath(homeDir)),
    project: readConfigFile(getProjectConfigPath(projectPath)),
  };
}

/**
 * Load the effective config for a project: user config first, then the project
 * config overriding it key-by-key (REQ-14.1). Malformed files are ignored with
 * a warning so a broken project file falls back to the user config.
 */
export function loadUserConfig(projectPath: string, homeDir?: string): UserConfig {
  const { user, project } = loadConfigLayers(projectPath, homeDir);
  return { ...user, ...project };
}

/**
 * Write `body` to `path` atomically with an exclusive, symlink-safe temp file
 * (SEC-901): the temp is created in the same directory with a random suffix
 * and the `wx` (O_CREAT|O_EXCL) flag so a pre-existing symlink at that name is
 * never followed — `openSync` fails with EEXIST and we retry once with a new
 * suffix. The write is then `renameSync`d into place, replacing the name rather
 * than following any symlink already pointing at `path`.
 */
function writeFileAtomic(path: string, body: string, mode: number): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number;
    try {
      fd = openSync(tmp, "wx", mode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        lastErr = err;
        continue;
      }
      throw err;
    }
    try {
      writeSync(fd, body, null, "utf8");
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    closeSync(fd);
    try {
      chmodSync(tmp, mode);
    } catch {
      // best-effort: some filesystems/platforms reject explicit modes
    }
    renameSync(tmp, path);
    return;
  }
  throw new Error(`[huginn] could not create a unique temp file for ${path}: ${String(lastErr)}`);
}

/**
 * Atomically persist a config file at an explicit path (REQ-14.3): create the
 * containing directory (`.huginn/`) with mode `0o700`, refuse a symlinked
 * directory (SEC-901), merge with existing keys (unknown keys preserved), write
 * an exclusive temp with mode `0o600`, then `renameSync` into place. Shared by
 * the project- and user-scoped savers below.
 */
function writeConfigAtomic(path: string, config: UserConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink()) {
    throw new Error(`[huginn] refusing to write config: ${dir} is a symlink`);
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort: some filesystems/platforms reject explicit modes
  }
  const merged: UserConfig = { ...readConfigFile(path), ...config };
  writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
}

/**
 * Atomically persist the project config (REQ-14.3) to
 * `<project>/.huginn/config.json`, preserving unknown keys.
 */
export function saveUserConfig(projectPath: string, config: UserConfig): void {
  writeConfigAtomic(getProjectConfigPath(projectPath), config);
}

/**
 * Atomically persist the user-scoped config (REQ-14.3, `config set --global`)
 * to `<home>/.huginn/config.json`, with the same symlink-safe hardening and
 * unknown-key preservation as {@link saveUserConfig}.
 */
export function saveGlobalUserConfig(config: UserConfig, homeDir?: string): void;
export function saveGlobalUserConfig(homeDir: string | undefined, config: UserConfig): void;
export function saveGlobalUserConfig(
  arg1?: UserConfig | string,
  arg2?: string | UserConfig,
): void {
  let homeDir: string | undefined;
  let config: UserConfig = {};

  if (typeof arg1 === "string" || arg1 === undefined) {
    // Legacy / alternate signature: saveGlobalUserConfig(homeDir?: string, config?: UserConfig)
    homeDir = arg1;
    if (typeof arg2 === "object" && arg2 !== null) {
      config = arg2 as UserConfig;
    }
  } else if (typeof arg1 === "object" && arg1 !== null) {
    // Primary signature: saveGlobalUserConfig(config: UserConfig, homeDir?: string)
    config = arg1;
    if (typeof arg2 === "string") {
      homeDir = arg2;
    }
  }

  writeConfigAtomic(getUserConfigPath(homeDir), config);
}
