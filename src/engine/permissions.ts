import type { EventFileEdited, EventMessagePartUpdated, EventTodoUpdated, OpencodeClient } from "@opencode-ai/sdk";
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
 * - forwards streaming text, reasoning tokens, tool executions, and file edits to the TUI
 */
export function subscribeToEvents(
  client: OpencodeClient,
  cfg: RunConfig,
  requestDecision: (req: DecisionRequest) => Promise<DecisionChoice>,
): SubscriptionHandle {
  let closed = false;
  const streamPromise = client.event.subscribe();
  const seenToolStatus = new Map<string, string>();
  const streamedTextLen = new Map<string, number>();

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
            const props = ev.properties as EventMessagePartUpdated["properties"];
            const part = props.part;
            if (!part) break;

            if (part.type === "text" || part.type === "reasoning") {
              // Emit only the new suffix of the accumulated text. `message.part.updated`
              // also fires for non-text changes (metadata, time.end, …) where the part
              // carries the full text so far; length-tracking keeps output non-duplicating
              // while still surfacing bulk text delivered without a `delta`.
              const start = streamedTextLen.get(part.id) ?? 0;
              if (part.text.length > start) {
                streamedTextLen.set(part.id, part.text.length);
                events.emit("phaseStream", { text: part.text.slice(start) });
              }
            } else if (part.type === "tool") {
              const prevStatus = seenToolStatus.get(part.id);
              const curStatus = part.state.status;

              if (curStatus && curStatus !== prevStatus) {
                seenToolStatus.set(part.id, curStatus);
                if (curStatus === "running") {
                  const title = part.state.title || (part.state.input ? JSON.stringify(part.state.input).slice(0, 80) : "");
                  const msg = `⚡ [tool: ${part.tool}] ${title}`;
                  events.emit("phaseStream", { text: `\n${msg}\n` });
                  events.emit("log", { level: "info", message: msg });
                } else if (curStatus === "completed") {
                  const msg = `✓ [tool: ${part.tool}] completed`;
                  events.emit("phaseStream", { text: `${msg}\n` });
                } else if (curStatus === "error") {
                  const msg = `✗ [tool: ${part.tool}] error: ${part.state.error ?? "unknown error"}`;
                  events.emit("phaseStream", { text: `\n${msg}\n` });
                  events.emit("log", { level: "warn", message: msg });
                }
              }
            }
            break;
          }
          case "file.edited": {
            const props = ev.properties as EventFileEdited["properties"];
            if (props.file) {
              events.emit("log", { level: "info", message: `📝 Edited: ${props.file}` });
              events.emit("phaseStream", { text: `\n📝 Edited file: ${props.file}\n` });
            }
            break;
          }
          case "todo.updated": {
            const props = ev.properties as EventTodoUpdated["properties"];
            for (const todo of props.todos) {
              events.emit("log", { level: "info", message: `📋 Task: ${todo.content} (${todo.status})` });
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
