import type { PhaseResult, DecisionRequest, Verdict, DecisionChoice } from "./types";
import type { HarnessState } from "../state/schema";

export type LiveStage = "refine" | "draft" | "approve" | "execute";

export interface EngineEvents {
  iterationStart: { iteration: number; totalIterations: number; title: string; modules?: string[] };
  iterationEnd: { iteration: number; title: string };
  phaseStart: { iteration: number; totalIterations?: number; iterationTitle?: string; phase: string; attempt: number; model: string; startedAt?: string };
  phaseStream: { text: string };
  phaseEnd: { result: PhaseResult; durationMs?: number };
  decision: DecisionRequest;
  decisionResolved: { id: string; choice: DecisionChoice };
  stateUpdated: HarnessState;
  log: { level: "info" | "warn" | "error"; message: string; timestamp?: string };
  verdict: { iteration: number; phase: string; verdict: Verdict; attempt: number; durationMs?: number };
  liveStage: { stage: LiveStage; message?: string };
  liveChat: { role: "user" | "assistant" | "system"; text: string };
  done: { reason: "completed" | "aborted" | "error"; error?: string };
}

type Listener<T> = (payload: T) => void;

export class Emitter<K extends keyof EngineEvents> {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  on<Ev extends keyof EngineEvents>(event: Ev, fn: Listener<EngineEvents[Ev]>): () => void {
    const set = this.listeners.get(event as string) ?? new Set();
    set.add(fn as Listener<unknown>);
    this.listeners.set(event as string, set);
    return () => set.delete(fn as Listener<unknown>);
  }

  emit<Ev extends keyof EngineEvents>(event: Ev, payload: EngineEvents[Ev]): void {
    const set = this.listeners.get(event as string);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<EngineEvents[Ev]>)(payload);
      } catch (err) {
        console.error(`[harness] listener for "${event as string}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const events = new Emitter<keyof EngineEvents>();
