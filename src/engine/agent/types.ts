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

export interface McpServerStatus {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "error";
  transport: string;
  toolsCount: number;
  tools?: McpToolInfo[];
  latencyMs?: number;
  error?: string;
}

export interface McpStatusReport {
  servers: McpServerStatus[];
  totalTools: number;
  healthy: boolean;
  degraded?: boolean;
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
