import type { AgentTarget } from "../../agents/integrator.js";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description?: string;
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
  getMcpStatus(): Promise<McpStatusReport>;
  createSession(options: SessionOptions): Promise<IAgentSession>;
  startDaemon?(): Promise<void>;
  stopDaemon?(): Promise<void>;
}
