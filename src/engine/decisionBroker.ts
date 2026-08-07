import type { DecisionChoice, DecisionRequest } from "./types";
import { events } from "./engineEvents";

export interface PendingDecision {
  req: DecisionRequest;
  resolve: (c: DecisionChoice) => void;
}

/**
 * FIFO broker for decisions requested by the engine and answered by a human
 * (TUI / headless) or by the permission auto-responder.
 *
 * Multiple requests can be in flight concurrently — e.g. a `gate-blocked`
 * decision while the event stream surfaces a `permission.updated` request in
 * `--permissions ask` mode. Requests are displayed and resolved in arrival
 * order, so no pending decision can be silently overwritten (which previously
 * orphaned a promise and hung the run).
 */
export class DecisionBroker {
  private queue: PendingDecision[] = [];

  request(req: DecisionRequest): Promise<DecisionChoice> {
    return new Promise<DecisionChoice>((resolve) => {
      this.queue.push({ req, resolve });
      if (this.queue.length === 1) {
        events.emit("decision", req);
      }
    });
  }

  resolve(choice: DecisionChoice): void {
    const pd = this.queue.shift();
    if (!pd) return;
    events.emit("decisionResolved", { id: pd.req.id, choice });
    pd.resolve(choice);
    const next = this.queue[0];
    if (next) events.emit("decision", next.req);
  }

  /** Resolve every pending request with the same choice (used on abort). */
  resolveAll(choice: DecisionChoice): void {
    while (this.queue.length > 0) {
      const pd = this.queue.shift()!;
      events.emit("decisionResolved", { id: pd.req.id, choice });
      pd.resolve(choice);
    }
  }

  get pending(): boolean {
    return this.queue.length > 0;
  }

  get length(): number {
    return this.queue.length;
  }
}
