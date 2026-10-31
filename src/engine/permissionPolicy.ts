import type {
  PermissionDecision,
  PermissionHandler,
} from "./agent/port.js";
import type { DecisionChoice, DecisionRequest } from "./types";

/**
 * The single mapping from the run's `--permissions` mode to the port's
 * permission channel.
 *
 * Both engines use it, so `--permissions ask` keeps its exact meaning for
 * opencode while the driver stays driver-neutral. An omitted handler in a
 * driver must deny; this function never returns `undefined`, so the choice is
 * always explicit.
 */
export function permissionHandlerFor(
  mode: "auto" | "ask" | "deny",
  ask: (request: DecisionRequest) => Promise<DecisionChoice>,
): PermissionHandler {
  return async (request) => {
    if (mode === "auto") return "allow-always";
    if (mode === "deny") return "deny";
    const choice = await ask({
      id: request.id,
      kind: "permission",
      iteration: 0,
      phase: "EXECUTE",
      attempt: 1,
      message: `Permission requested: ${request.title}`,
      permissionId: request.id,
    });
    const decision: PermissionDecision =
      choice === "deny" || choice === "abort"
        ? "deny"
        : choice === "continue"
          ? "allow-always"
          : "allow-once";
    return decision;
  };
}
