import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RunConfig } from "../config";
import { events } from "./engineEvents";
import type { DecisionChoice, DecisionRequest } from "./types";
import { respondPermission } from "../server/client";

export interface SubscriptionHandle {
  close(): void;
}

async function respond(
  client: OpencodeClient,
  sessionID: string,
  permissionID: string,
  response: "once" | "always" | "reject",
) {
  try {
    await respondPermission(client, sessionID, permissionID, response);
  } catch (err) {
    events.emit("log", { level: "error", message: `failed to respond to permission: ${(err as Error).message}` });
  }
}

/**
 * Subscribes to the server event stream:
 * - auto-approves / denies permission requests per config
 * - surfaces `permission.ask` requests through the engine decision flow
 * - forwards streaming text deltas to the TUI
 */
export function subscribeToEvents(
  client: OpencodeClient,
  cfg: RunConfig,
  requestDecision: (req: DecisionRequest) => Promise<DecisionChoice>,
): SubscriptionHandle {
  let closed = false;
  const streamPromise = client.event.subscribe();

  (async () => {
    try {
      const sse = await streamPromise;
      for await (const ev of sse.stream as AsyncGenerator<any>) {
        if (closed) break;
        if (!ev || typeof ev.type !== "string") continue;
        switch (ev.type) {
          case "permission.updated": {
            const p = ev.properties as {
              id: string;
              sessionID: string;
              title: string;
              messageID?: string;
              pattern?: string | string[];
            };
            if (cfg.permissions === "auto") {
              events.emit("log", { level: "info", message: `auto-approved permission: ${p.title}` });
              await respond(client, p.sessionID, p.id, "always");
            } else if (cfg.permissions === "deny") {
              events.emit("log", { level: "warn", message: `auto-denied permission: ${p.title}` });
              await respond(client, p.sessionID, p.id, "reject");
            } else {
              const choice = await requestDecision({
                id: crypto.randomUUID(),
                kind: "permission",
                iteration: 0,
                phase: "EXECUTE",
                attempt: 1,
                message: `Permission requested: ${p.title}`,
                permissionId: p.id,
                permissionSessionId: p.sessionID,
              });
              await respond(client, p.sessionID, p.id, choice === "deny" ? "reject" : choice === "continue" ? "always" : "once");
            }
            break;
          }
          case "message.part.updated": {
            const props = ev.properties as { part?: { type?: string; text?: string }; delta?: string };
            const part = props.part;
            if (props.delta && part?.type === "text") {
              events.emit("phaseStream", { text: props.delta });
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      if (!closed) {
        events.emit("log", { level: "warn", message: `event stream ended: ${(err as Error).message}` });
      }
    }
  })();

  return {
    close() {
      closed = true;
    },
  };
}
