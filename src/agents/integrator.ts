import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";

/**
 * Universal Agent Integrator (REQ-15). Everything agent-specific lives in the
 * declarative `AGENT_REGISTRY`, so adding a new agent is a one-row change.
 */

export type AgentTarget =
  | "cursor"
  | "claude"
  | "opencode"
  | "windsurf"
  | "qwen"
  | "codex"
  | "agy"
  | "kimi"
  | "pi"
  | "commandcode"
  | "omp";

export type McpFormat = "mcpServers" | "opencode" | "toml";

/**
 * Targets that were once supported and have been **removed** (with their
 * successor where one exists). A persisted config naming one of them warns and
 * falls back instead of failing the run (AC-35.3); any other unknown value is
 * still rejected (SEC-001).
 */
export const REMOVED_AGENT_TARGETS: ReadonlyMap<string, string> = new Map([
  ["gemini", "agy"],
]);

/**
 * One row of the Muninn provisioning matrix (REQ-38 / AC-38.4): whether the
 * agent is installed and whether its config already registers Muninn.
 *
 * Muninn is Huginn's primary brain and is deliberately **agent-independent**:
 * the database is project-scoped, so provisioning the same server for several
 * agents shares one memory rather than forking it (AC-38.1).
 */
export interface MuninnProvisioningRow {
  id: AgentTarget;
  label: string;
  installed: boolean;
  registered: boolean;
  /** Config files that were inspected for a `muninn` entry. */
  paths: string[];
}

/**
 * Build the agent × (installed · muninn registered) matrix.
 *
 * `registersMuninn` is injected (rather than imported) to keep this module free
 * of a cycle with `commands/doctor.ts`, which owns the config parsing.
 */
export function describeMuninnProvisioning(opts: {
  projectPath: string;
  homeDir?: string;
  opencodeConfigDir?: string;
  env?: Record<string, string | undefined>;
  /** Availability from `detectAvailableAgents()`; omitted → treated as unknown. */
  detected?: Array<{ id: AgentTarget; available: boolean }>;
  registersMuninn: (filePath: string, format: McpFormat) => boolean;
}): MuninnProvisioningRow[] {
  const installedById = new Map(opts.detected?.map((d) => [d.id, d.available]));
  return listRegistry().map((spec) => {
    const paths = resolveMcpPaths(spec.id, {
      projectPath: opts.projectPath,
      homeDir: opts.homeDir ?? homedir(),
      opencodeConfigDir: opts.opencodeConfigDir,
      env: opts.env,
    });
    return {
      id: spec.id,
      label: spec.label,
      installed: installedById.get(spec.id) ?? true,
      registered: paths.some((p) => opts.registersMuninn(p, spec.format)),
      paths,
    };
  });
}

export interface AgentSpec {
  id: AgentTarget;
  label: string;
  format: McpFormat;
  /** Path templates; `{project}`, `{home}` and `{opencodeConfigDir}` expand. */
  mcpPaths: string[];
  rulesFile: string;
}

/**
 * The registry (SPEC.md AC-15.2). Paths are templates so the resolved location
 * can honour injected `homeDir`/`opencodeConfigDir` and env overrides.
 */
export const AGENT_REGISTRY: Record<AgentTarget, AgentSpec> = {
  cursor: {
    id: "cursor",
    label: "Cursor",
    format: "mcpServers",
    mcpPaths: ["{project}/.cursor/mcp.json", "{home}/.cursor/mcp.json"],
    rulesFile: ".cursorrules",
  },
  claude: {
    id: "claude",
    label: "Claude Code / Desktop",
    format: "mcpServers",
    mcpPaths: [
      "{project}/.mcp.json",
      "{home}/.claude.json",
      "{home}/.claude/claude_desktop_config.json",
    ],
    rulesFile: "CLAUDE.md",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    format: "opencode",
    mcpPaths: ["{opencodeConfigDir}/opencode.json"],
    rulesFile: "AGENTS.md",
  },
  windsurf: {
    id: "windsurf",
    label: "Windsurf",
    format: "mcpServers",
    mcpPaths: ["{home}/.codeium/windsurf/mcp_config.json"],
    rulesFile: ".windsurfrules",
  },
  qwen: {
    id: "qwen",
    label: "Qwen Code",
    format: "mcpServers",
    mcpPaths: ["{home}/.qwen/settings.json"],
    rulesFile: "QWEN.md",
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex CLI",
    format: "toml",
    mcpPaths: ["{home}/.codex/config.toml"],
    rulesFile: "AGENTS.md",
  },
  agy: {
    id: "agy",
    label: "Antigravity CLI (agy)",
    format: "mcpServers",
    mcpPaths: [
      "{home}/.gemini/config/mcp_config.json",
      "{project}/.agents/mcp_config.json",
    ],
    rulesFile: "AGENTS.md",
  },
  kimi: {
    id: "kimi",
    label: "Kimi Code CLI",
    format: "mcpServers",
    mcpPaths: ["{home}/.kimi-code/mcp.json", "{project}/.kimi/mcp.json"],
    rulesFile: "AGENTS.md",
  },
  pi: {
    id: "pi",
    label: "Pi coding agent",
    format: "mcpServers",
    mcpPaths: ["{home}/.pi/mcp.json", "{project}/.pi/mcp.json"],
    rulesFile: "AGENTS.md",
  },
  commandcode: {
    id: "commandcode",
    label: "Command Code",
    format: "mcpServers",
    mcpPaths: ["{home}/.commandcode/mcp.json", "{project}/.commandcode/mcp.json"],
    rulesFile: "AGENTS.md",
  },
  omp: {
    id: "omp",
    label: "Oh My Pi",
    format: "mcpServers",
    mcpPaths: ["{home}/.omp/mcp.json", "{project}/.omp/mcp.json"],
    rulesFile: "AGENTS.md",
  },
};

export const AGENT_TARGETS: AgentTarget[] = Object.keys(AGENT_REGISTRY) as AgentTarget[];

export const MUNINN_RULES_START = "<!-- huginn:muninn-rules:start -->";
export const MUNINN_RULES_END = "<!-- huginn:muninn-rules:end -->";

const RULES_BLOCK = [
  MUNINN_RULES_START,
  "## Muninn memory directives",
  "",
  "This project is indexed by Muninn. Before designing any change, call",
  "`muninn_context` and `muninn_inspect_symbol` to load the relevant symbols and",
  "dependency paths. Before emitting any final code, call `muninn_verify_contract`.",
  "",
  "Do not emit final code that has not been contract-verified.",
  "",
  "If you need a decision from the user to proceed, ask with a marked block:",
  "`<<<HUGINN_QUESTION>>>` + a JSON array of",
  '`{"question", "options":[{"label","description"}]}` + `<<<END_HUGINN_QUESTION>>>`',
  "on their own lines, and Huginn will present the choices.",
  MUNINN_RULES_END,
].join("\n");

export interface ResolveOptions {
  projectPath: string;
  homeDir: string;
  opencodeConfigDir?: string;
  env?: Record<string, string | undefined>;
}

export interface RegistrationOptions extends ResolveOptions {
  force?: boolean;
  /**
   * Compute the exact same report but write **nothing** (AC-38.6). A preview flag
   * must never mutate third-party configs.
   */
  dryRun?: boolean;
}

export interface MCPRegistration {
  target: AgentTarget;
  path: string;
  format: McpFormat;
  changed: boolean;
  skipped: boolean;
}

export interface RulesInjection {
  target: AgentTarget;
  path: string;
  changed: boolean;
}

export interface SetupReport {
  registrations: MCPRegistration[];
  rules: RulesInjection[];
  portable: { path: string; changed: boolean };
}

function envFor(opts: ResolveOptions): Record<string, string | undefined> {
  return opts.env ?? process.env;
}

function opencodeConfigDirFor(opts: ResolveOptions): string {
  if (opts.opencodeConfigDir) return opts.opencodeConfigDir;
  const fromEnv = envFor(opts).HUGINN_OPENCODE_CONFIG_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return join(opts.homeDir, ".config", "opencode");
}

function expandTemplate(template: string, opts: ResolveOptions): string {
  const expanded = template
    .replaceAll("{project}", opts.projectPath)
    .replaceAll("{home}", opts.homeDir)
    .replaceAll("{opencodeConfigDir}", opencodeConfigDirFor(opts));
  return normalize(expanded);
}

/**
 * Resolve the target's MCP config path(s): expand `{project}`/`{home}`/
 * `{opencodeConfigDir}` and, when `HUGINN_AGENT_<ID>_MCP_PATH` is set, use the
 * colon-separated override list instead (AC-15.7).
 */
export function resolveMcpPaths(target: AgentTarget, opts: ResolveOptions): string[] {
  const spec = AGENT_REGISTRY[target];
  const override = envFor(opts)[`HUGINN_AGENT_${target.toUpperCase()}_MCP_PATH`];
  const templates =
    override && override.trim().length > 0
      ? override
          .split(":")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : spec.mcpPaths;
  return templates.map((template) => expandTemplate(template, opts));
}

function resolveRulesPath(target: AgentTarget, opts: ResolveOptions): string {
  const spec = AGENT_REGISTRY[target];
  const env = envFor(opts);
  const override =
    env[`HUGINN_AGENT_${target.toUpperCase()}_RULES_PATH`] ?? env.HUGINN_AGENT_RULES_PATH;
  if (override && override.trim().length > 0) {
    const value = override.trim();
    return isAbsolute(value) ? normalize(value) : normalize(join(opts.projectPath, value));
  }
  return normalize(join(opts.projectPath, spec.rulesFile));
}

/** Order-insensitive structural comparison for parsed JSON/TOML values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]),
  );
}

/**
 * Write `body` to `path` atomically with an exclusive, symlink-safe temp file
 * (AC-15.6): `wx` create with a random suffix, so a pre-existing symlink at the
 * temp name is never followed (EEXIST retries once), then rename into place.
 *
 * SEC-1001: an existing target keeps its current permission bits — a config the
 * user hardened to `0o600` is never widened. New files are created with
 * `defaultMode` (callers pass `0o600` for MCP configs, `0o644` for rules files).
 * Parent directories are created with `0o700`.
 */
function writeAtomic(path: string, body: string, defaultMode: number, dryRun = false): void {
  if (dryRun) return;
  let mode = defaultMode;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // target does not exist yet → default for a new file
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
    renameSync(tmp, path);
    return;
  }
  throw new Error(`could not create a unique temp file for ${path}: ${String(lastErr)}`);
}

function readJsonIfExists(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`malformed JSON in ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function mergeJsonFile(
  path: string,
  containerKey: string,
  desired: Record<string, unknown>,
  force: boolean,
  dryRun = false,
): { changed: boolean; skipped: boolean } {
  const root = readJsonIfExists(path);
  const existingContainer = root[containerKey];
  if (
    existingContainer !== undefined &&
    (typeof existingContainer !== "object" ||
      existingContainer === null ||
      Array.isArray(existingContainer))
  ) {
    throw new Error(`"${containerKey}" in ${path} is not an object`);
  }
  const container: Record<string, unknown> = existingContainer
    ? { ...(existingContainer as Record<string, unknown>) }
    : {};
  const existing = container.muninn;
  if (existing !== undefined && deepEqual(existing, desired)) {
    return { changed: false, skipped: false };
  }
  if (existing !== undefined && !force) {
    return { changed: false, skipped: true };
  }
  container.muninn = desired;
  root[containerKey] = container;
  writeAtomic(path, `${JSON.stringify(root, null, 2)}\n`, 0o600, dryRun);
  return { changed: true, skipped: false };
}

interface TomlSection {
  header: string;
  body: string[];
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

/**
 * Parse `[mcp_servers.muninn]` structurally and return its `command`/`args`
 * values. Returns `ok: false` when a line cannot be parsed as `key = value`.
 */
function parseMuninnTable(body: string[]): { ok: boolean; command?: string; args?: string[] } {
  const out: { ok: boolean; command?: string; args?: string[] } = { ok: true };
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      out.ok = false;
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "command" || key === "args") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (key === "command" && typeof parsed === "string") out.command = parsed;
        else if (key === "args" && Array.isArray(parsed)) out.args = parsed as string[];
        else out.ok = false;
      } catch {
        out.ok = false;
      }
    }
  }
  return out;
}

/**
 * Merge `[mcp_servers.muninn]` into an existing TOML document while preserving
 * every other table/line byte-for-byte. Throws on a malformed muninn table
 * rather than writing a half-parsed file.
 */
function mergeToml(
  content: string,
  projectPath: string,
  force: boolean,
): { content: string; changed: boolean; skipped: boolean } {
  const lines = content.length === 0 ? [] : content.split("\n");
  const desiredBody = [
    'command = "huginn"',
    `args = ["mcp", "run", "--project", ${JSON.stringify(projectPath)}]`,
  ];

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[mcp_servers\.muninn\]\s*$/.test(lines[i])) {
      start = i;
      end = i + 1;
      while (end < lines.length && !isTomlTableHeader(lines[end])) end++;
      break;
    }
  }

  if (start !== -1) {
    const existing = parseMuninnTable(lines.slice(start + 1, end));
    if (!existing.ok) {
      throw new Error("malformed [mcp_servers.muninn] table");
    }
    if (
      existing.command === "huginn" &&
      Array.isArray(existing.args) &&
      deepEqual(existing.args, ["mcp", "run", "--project", projectPath])
    ) {
      return { content, changed: false, skipped: false };
    }
    if (!force) return { content, changed: false, skipped: true };
    const next = [
      ...lines.slice(0, start),
      "[mcp_servers.muninn]",
      ...desiredBody,
      ...lines.slice(end),
    ];
    return { content: ensureTrailingNewline(next.join("\n")), changed: true, skipped: false };
  }

  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === "") next.pop();
  if (next.length > 0) next.push("");
  next.push("[mcp_servers.muninn]", ...desiredBody);
  return { content: `${next.join("\n")}\n`, changed: true, skipped: false };
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function registerTomlPath(
  target: AgentTarget,
  path: string,
  projectPath: string,
  force: boolean,
  dryRun = false,
): MCPRegistration {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      content = "";
    } else {
      throw new Error(
        `[huginn] setup ${target}: could not read ${path}: ${(err as Error).message}`,
      );
    }
  }
  let merged: { content: string; changed: boolean; skipped: boolean };
  try {
    merged = mergeToml(content, projectPath, force);
  } catch (err) {
    throw new Error(
      `[huginn] setup ${target}: ${(err as Error).message} in ${path}; file left untouched`,
    );
  }
  if (merged.changed) writeAtomic(path, merged.content, 0o600, dryRun);
  return { target, path, format: "toml", changed: merged.changed, skipped: merged.skipped };
}

function registerJsonPath(
  target: AgentTarget,
  path: string,
  containerKey: string,
  desired: Record<string, unknown>,
  force: boolean,
  dryRun = false,
): MCPRegistration {
  let result: { changed: boolean; skipped: boolean };
  try {
    result = mergeJsonFile(path, containerKey, desired, force, dryRun);
  } catch (err) {
    throw new Error(
      `[huginn] setup ${target}: ${(err as Error).message}; file left untouched`,
    );
  }
  return {
    target,
    path,
    format: AGENT_REGISTRY[target].format,
    changed: result.changed,
    skipped: result.skipped,
  };
}

function desiredJsonEntry(
  format: McpFormat,
  projectPath: string,
): Record<string, unknown> {
  if (format === "opencode") {
    return {
      type: "local",
      command: ["huginn", "mcp", "run", "--project", projectPath],
      enabled: true,
    };
  }
  return { command: "huginn", args: ["mcp", "run", "--project", projectPath] };
}

/**
 * Register the `muninn` MCP server in each of the target's resolved config
 * paths. Idempotent and atomic; without `force` a differing existing `muninn`
 * entry is left untouched and reported as `skipped`.
 */
export function registerMcpForTarget(
  target: AgentTarget,
  opts: RegistrationOptions,
): MCPRegistration[] {
  const spec = AGENT_REGISTRY[target];
  const force = opts.force === true;
  const desired = desiredJsonEntry(spec.format, opts.projectPath);
  return resolveMcpPaths(target, opts).map((path) => {
    if (spec.format === "toml")
      return registerTomlPath(target, path, opts.projectPath, force, opts.dryRun === true);
    const containerKey = spec.format === "opencode" ? "mcp" : "mcpServers";
    return registerJsonPath(target, path, containerKey, desired, force, opts.dryRun === true);
  });
}

/** Always write the standard `mcpServers` portable fallback (AC-15.3). */
export function writePortableMcpConfig(
  opts: RegistrationOptions,
): { path: string; changed: boolean } {
  const path = join(opts.homeDir, ".huginn", "mcp.json");
  const desired = desiredJsonEntry("mcpServers", opts.projectPath);
  const result = mergeJsonFile(path, "mcpServers", desired, opts.force === true, opts.dryRun);
  return { path, changed: result.changed };
}

function injectRulesBlock(existing: string | undefined): { content: string; changed: boolean } {
  const original = existing ?? "";
  const startIndex = original.indexOf(MUNINN_RULES_START);
  const endIndex = original.indexOf(MUNINN_RULES_END);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = original.slice(0, startIndex);
    const after = original.slice(endIndex + MUNINN_RULES_END.length);
    const content = `${before}${RULES_BLOCK}${after}`;
    return { content, changed: content !== original };
  }
  if (original.trim().length === 0) {
    return { content: `${RULES_BLOCK}\n`, changed: true };
  }
  const separator = original.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${original}${separator}${RULES_BLOCK}\n`, changed: true };
}

/**
 * Insert or replace the marked Muninn directive block in the target's rules
 * file (AC-15.5). Surrounding user content is preserved and re-running is
 * idempotent.
 */
export function injectRulesForTarget(
  target: AgentTarget,
  opts: RegistrationOptions,
): { path: string; changed: boolean } {
  const path = resolveRulesPath(target, opts);
  let existing: string | undefined;
  try {
    existing = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      existing = undefined;
    } else {
      throw new Error(
        `[huginn] setup ${target}: could not read rules file ${path}: ${(err as Error).message}`,
      );
    }
  }
  const { content, changed } = injectRulesBlock(existing);
  if (changed) writeAtomic(path, content, 0o644, opts.dryRun);
  return { path, changed };
}

/** The registry as an ordered list, for `huginn setup --list`. */
export function listRegistry(): AgentSpec[] {
  return AGENT_TARGETS.map((id) => AGENT_REGISTRY[id]);
}

/**
 * Register and inject for one target or `all`, plus the portable fallback.
 * Malformed existing config fails closed with a descriptive error (AC-15.6).
 */
export function setup(opts: {
  agent: AgentTarget | "all";
  projectPath: string;
  homeDir?: string;
  force?: boolean;
  dryRun?: boolean;
  opencodeConfigDir?: string;
  env?: Record<string, string | undefined>;
}): SetupReport {
  const targets: AgentTarget[] = opts.agent === "all" ? AGENT_TARGETS : [opts.agent];
  const base: RegistrationOptions = {
    projectPath: opts.projectPath,
    homeDir: opts.homeDir ?? homedir(),
    opencodeConfigDir: opts.opencodeConfigDir,
    env: opts.env,
    force: opts.force,
    dryRun: opts.dryRun,
  };

  const registrations: MCPRegistration[] = [];
  const rules: RulesInjection[] = [];
  for (const target of targets) {
    registrations.push(...registerMcpForTarget(target, base));
    const rule = injectRulesForTarget(target, base);
    rules.push({ target, path: rule.path, changed: rule.changed });
  }
  const portable = writePortableMcpConfig(base);
  return { registrations, rules, portable };
}
