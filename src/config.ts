import type { PhaseName } from "./engine/types";

export interface RunConfig {
  projectPath: string;
  planPath: string;
  specPath: string;
  adrPath: string;
  thinker: string;
  executor: string;
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
}
