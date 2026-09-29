import type { AgentTarget } from "../../agents/integrator.js";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

/**
 * Result of a model-discovery attempt (REQ-27 / AC-27.4, REV-002/REV-010): an
 * empty catalog must never be indistinguishable from a failure, so every path
 * that yields no models may attach a short, already-sanitized `reason` (missing
 * binary, non-zero exit, timeout, empty output, no listing command, …). A reason
 * is informational — `models` may be non-empty in principle, though discovery
 * currently never does that.
 */
export interface ModelCatalog {
  models: ModelInfo[];
  reason?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

/**
 * Lifecycle state of a single MCP server (REQ-30 / AC-30.1).
 *
 * `connected` means a **real probe** reported the server as reachable. Servers
 * that were merely *discovered in a config file* are `unknown`: Huginn never
 * holds an MCP client for subprocess runtimes, so claiming `connected` for them
 * would be a fabrication (the previous always-green badge).
 */
export type McpServerState = "connected" | "disconnected" | "unknown" | "error";

/**
 * Lifecycle state a CLI *listing* reports for one server (REQ-32 / AC-32.2).
 *
 * Deliberately narrower than {@link McpServerState}: `enabled` means "configured
 * in the agent's own config" (a listing word, never a probe result), and only
 * `connected` may be described as live. `unknown` is the honest default for a
 * status Huginn does not recognise.
 */
export type McpListingStatus = "connected" | "enabled" | "disabled" | "pending" | "unknown";

/**
 * One server as enumerated by the active agent's own CLI (REQ-32 / AC-32.1).
 *
 * This is the agent's *own* answer to "what do you have?" — the only source that
 * can legitimately name servers Huginn cannot see (per-agent config files) and
 * attribute them to that agent (AC-32.3).
 */
export interface McpServerListing {
  name: string;
  transport?: string;
  status: McpListingStatus;
  /** Whatever per-server detail the listing exposed (command, scope, auth, URL). */
  detail?: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  status: McpServerState;
  transport: string;
  toolsCount: number;
  tools?: McpToolInfo[];
  latencyMs?: number;
  error?: string;
  /**
   * Per-server detail quoted from the agent's own listing (`commandcode`'s
   * scope/auth, `claude`/`qwen`'s command line, …) — shown verbatim so the panel
   * can go deeper where the CLI does and say so where it cannot (AC-32.5).
   */
  detail?: string;
}

export interface McpStatusReport {
  servers: McpServerStatus[];
  totalTools: number;
  /**
   * True only when every reported server was *verified* reachable by a real
   * probe (AC-30.1). A report whose servers were merely discovered in config
   * files is `healthy: false` even though nothing failed.
   */
  healthy: boolean;
  /**
   * True when at least one server was found in configuration but never probed
   * (ADR-30.1) — the truthfulness signal behind `MCP: ⚪ n unverified`.
   */
  unverified?: boolean;
  /** True when a probe (or a config entry) reported a real failure. */
  degraded?: boolean;
  /**
   * Sanitized failure reason. Set by the timeout helper and by runtimes whose
   * probe threw, so the badge can render `MCP: 🟡 error` instead of an
   * indistinguishable `⚪ 0 active` (AC-30.2).
   */
  error?: string;
}

export interface SessionOptions {
  title: string;
  directory?: string;
  model?: string;
  agent?: string;
}

export interface PromptOptions {
  model?: string;
  agent?: string;
  timeoutMs?: number;
  directory?: string;
}

export interface CommandOptions {
  command: string;
  arguments?: string;
  model?: string;
  agent?: string;
  timeoutMs?: number;
  directory?: string;
}

export interface PromptResult {
  messageId: string;
  text: string;
  raw?: unknown;
}

export interface IAgentSession {
  id: string;
  prompt(text: string, options?: PromptOptions): Promise<PromptResult>;
  runCommand?(command: string, args: string, options?: CommandOptions): Promise<PromptResult>;
  abort(): Promise<void>;
}

export interface IAgentRuntime {
  id: AgentTarget;
  name: string;
  /**
   * Whether **this runtime's session keeps the conversation server-side**
   * (Phase 4A).
   *
   * - `true` — the backend owns the history: every prompt after the first rides
   *   on the session's own accumulated turns and only needs the new text
   *   (`opencode`, whose HTTP server holds the session).
   * - `false` — the runtime is **one-shot/stateless**: each prompt spawns a
   *   fresh process with no memory of the previous ones, so a caller that wants
   *   context must send a self-contained body (system prompt + transcript +
   *   current turn). Every subprocess CLI is in this group (`claude`, `codex`,
   *   `commandcode`, `devin`, `mcode`, `mimo`, `kimi`, `pi`, `qwen`, `agy`,
   *   `omp`, `cursor`) — see {@link GenericSubprocessRuntimeAdapter}, which
   *   declares `false` for all of them.
   *
   * `undefined` is read as "does not keep history" by the live engine: re-sending
   * context is always safe (the worst case is duplicated context), whereas
   * assuming a history that does not exist silently drops the conversation. Only
   * a runtime that *knows* its backend persists the session should declare
   * `true`.
   */
  readonly sessionHistory?: boolean;
  isAvailable(): Promise<boolean>;
  getAvailableModels(): Promise<ModelInfo[]>;
  /**
   * Optional richer form of {@link IAgentRuntime.getAvailableModels} (REQ-27 /
   * AC-27.4): the catalog plus a `reason` when it came back empty. Runtimes that
   * implement it let the picker distinguish "no listing mechanism", "CLI
   * failed" and "nothing discovered" instead of showing one generic empty state.
   */
  getModelCatalog?(): Promise<ModelCatalog>;
  /**
   * Optional enumeration of the servers *this agent* has configured (REQ-32 /
   * AC-32.1): implemented by runtimes whose CLI can list them
   * (`opencode`/`claude`/`qwen`/`agy`/`commandcode mcp list`). Runtimes without a
   * listing command resolve `[]` and let the caller fall back to config-file
   * discovery. Never throws and never fabricates: an empty array means "nothing
   * was enumerated", not "you have no servers".
   */
  listMcpServers?(): Promise<McpServerListing[]>;
  getMcpStatus(): Promise<McpStatusReport>;
  createSession(options: SessionOptions): Promise<IAgentSession>;
  startDaemon?(): Promise<void>;
  stopDaemon?(): Promise<void>;
}
