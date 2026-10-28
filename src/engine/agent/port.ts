import type { RuntimeId } from "../../agents/integrator.js";
import type {
  McpServerListing,
  McpStatusReport,
  ModelCatalog,
  PromptResult,
} from "./types.js";

// The runtime id is defined next to the provisioning targets so the mapping
// between the two concepts lives in one place (M4b).
export type { RuntimeId } from "../../agents/integrator.js";

/**
 * What a driver can actually do, declared instead of guessed.
 *
 * The rule every surface must follow: a capability that is false is never
 * advertised, and a surface never waits for an event its driver cannot emit.
 */
export interface RuntimeCapabilities {
  /** The agent loop runs inside the huginn process (no bridge process). */
  readonly inProcess: boolean;
  /** Emits typed {@link RuntimeEvent}s, not just the final text. */
  readonly structuredEvents: boolean;
  /** Emits incremental `text` events while the turn runs. */
  readonly streaming: boolean;
  /**
   * `none` — the driver has no channel back mid-turn, so `--permissions ask|deny`
   * cannot be honoured and must fail closed. `gate` — allow/deny decided up front
   * from the configured policy. `interactive` — the driver can ask per tool call.
   */
  readonly permissions: "none" | "gate" | "interactive";
  /** The backend keeps the conversation; later turns ride on it. */
  readonly sessionHistory: boolean;
  /** A session can be reopened by id after the process or run restarts. */
  readonly sessionResume: boolean;
  /** `dynamic` — the driver can enumerate or be asked for its catalog. */
  readonly modelCatalog: "none" | "static" | "dynamic";
  /** The driver can return a schema-validated JSON answer. */
  readonly structuredOutput: boolean;
  /** The driver reports token usage or cost. */
  readonly usageCost: boolean;
  /** The driver can enumerate the MCP servers it has configured. */
  readonly mcpListing: boolean;
  /** A running turn can be interrupted. */
  readonly interrupt: boolean;
}

/** Why a driver cannot run here, in words a human can act on. */
export interface Availability {
  readonly ok: boolean;
  readonly reason?: string;
  /** Resolved binary path, when the driver knows it. */
  readonly path?: string;
}

/** A permission question a driver wants answered before it runs a tool. */
export interface PermissionRequest {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
}

export type PermissionDecision = "allow-once" | "allow-always" | "deny";

/** Answer `request`, never throw: an unanswered permission must deny. */
export type PermissionHandler = (request: PermissionRequest) => Promise<PermissionDecision>;

/** Everything a driver can report while a turn runs. */
export type RuntimeEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool.start"; readonly name: string; readonly detail?: string }
  | { readonly type: "tool.end"; readonly name: string; readonly ok: boolean; readonly detail?: string }
  | { readonly type: "permission.request"; readonly request: PermissionRequest }
  | {
      readonly type: "usage";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly costUsd?: number;
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "done"; readonly result: PromptResult };

export type EventSink = (event: RuntimeEvent) => void;

export interface RuntimeSessionOptions {
  readonly title: string;
  readonly directory?: string;
  readonly model?: string;
  readonly agent?: string;
  /** Where this session reports progress; omit when the caller only wants the result. */
  readonly sink?: EventSink;
}

export interface RuntimePromptRequest {
  readonly text: string;
  readonly model?: string;
  readonly agent?: string;
  readonly timeoutMs?: number;
  readonly directory?: string;
}

export interface RuntimeSession {
  readonly id: string;
  /** True only when {@link RuntimeCapabilities.sessionResume} is true. */
  readonly resumable: boolean;
  prompt(request: RuntimePromptRequest): Promise<PromptResult>;
  interrupt(reason?: string): Promise<void>;
  /** Release whatever the session holds. Idempotent. */
  close(): Promise<void>;
}

export type ModelResolution =
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly reason: string };

/**
 * One driver, as the cycle sees it.
 *
 * Everything above this line is driver-neutral: the engine never learns whether
 * a runtime is an HTTP daemon, a spawned CLI or an in-process agent loop.
 */
export interface RuntimePort {
  readonly id: RuntimeId;
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  /** Whether this driver can run here, and why not when it cannot. */
  isAvailable(): Promise<Availability>;
  /** The driver's model catalog; an empty list is always explained. */
  listModels(): Promise<ModelCatalog>;
  /**
   * Map huginn's canonical `provider/model` reference onto what this driver
   * accepts, or explain why it cannot.
   */
  resolveModel(reference: string): ModelResolution;
  createSession(options: RuntimeSessionOptions): Promise<RuntimeSession>;
  /**
   * The servers this driver's agent has configured, through its own CLI when it
   * has one. `undefined` means the driver has no listing; `[]` means it asked
   * and nothing was enumerated (the caller may fall back to config discovery).
   */
  listMcpServers?(): Promise<McpServerListing[]>;
  /**
   * The driver's config/probe view of its MCP servers. Optional for the same
   * reason as {@link listMcpServers}: a driver that cannot see MCP says so by
   * omitting it, never by fabricating a healthy report.
   */
  mcpStatus?(): Promise<McpStatusReport>;
  /** Stop any daemon or pooled resource the driver owns. */
  dispose?(): Promise<void>;
}
