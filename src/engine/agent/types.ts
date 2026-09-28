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

export interface McpServerStatus {
  id: string;
  name: string;
  status: McpServerState;
  transport: string;
  toolsCount: number;
  tools?: McpToolInfo[];
  latencyMs?: number;
  error?: string;
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
  isAvailable(): Promise<boolean>;
  getAvailableModels(): Promise<ModelInfo[]>;
  /**
   * Optional richer form of {@link IAgentRuntime.getAvailableModels} (REQ-27 /
   * AC-27.4): the catalog plus a `reason` when it came back empty. Runtimes that
   * implement it let the picker distinguish "no listing mechanism", "CLI
   * failed" and "nothing discovered" instead of showing one generic empty state.
   */
  getModelCatalog?(): Promise<ModelCatalog>;
  getMcpStatus(): Promise<McpStatusReport>;
  createSession(options: SessionOptions): Promise<IAgentSession>;
  startDaemon?(): Promise<void>;
  stopDaemon?(): Promise<void>;
}
