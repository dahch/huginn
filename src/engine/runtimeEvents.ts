import type { EventSink, RuntimeEvent } from "./agent/port.js";
import { events } from "./engineEvents";
import { sanitizeTerminalText } from "../util/text.js";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RuntimeSinkOptions {
  /** `capabilities.streaming`: only then are text deltas forwarded. */
  readonly streaming: boolean;
  readonly iteration?: number;
  readonly phase?: string;
  /** Called for every `usage` event, so the caller can accumulate without a second mapper. */
  readonly onUsage?: (event: Extract<RuntimeEvent, { type: "usage" }>) => void;
}

/** Add one usage event onto an accumulator (missing metrics count as zero). */
export function addUsage(total: UsageTotals, event: Extract<RuntimeEvent, { type: "usage" }>): UsageTotals {
  return {
    inputTokens: total.inputTokens + (event.inputTokens ?? 0),
    outputTokens: total.outputTokens + (event.outputTokens ?? 0),
    costUsd: total.costUsd + (event.costUsd ?? 0),
  };
}

/**
 * The one boundary where driver output becomes terminal output.
 *
 * Total and never-throwing: a malformed event must not be able to abort a phase
 * body mid-way, because the read-only guard samples the tree hash only after the
 * body returns. A one-shot driver's single `text` event is *not* forwarded when
 * `streaming` is false — it would duplicate the report panel the dashboard
 * already shows.
 *
 * `done` emits nothing: `phaseEnd`/`verdict` already terminate the row, and
 * re-emitting the result text would show the report twice.
 */
export function createRuntimeSink(options: RuntimeSinkOptions): EventSink {
  let total: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  return (event: RuntimeEvent): void => {
    try {
      switch (event.type) {
        case "text":
          if (options.streaming && event.text) {
            events.emit("phaseStream", { text: sanitizeTerminalText(event.text) });
          }
          break;
        case "reasoning":
          if (options.streaming && event.text) {
            events.emit("phaseStream", { text: `💭 ${sanitizeTerminalText(event.text)}` });
          }
          break;
        case "tool.start": {
          const name = sanitizeTerminalText(event.name);
          const detail = event.detail ? ` ${sanitizeTerminalText(event.detail)}` : "";
          const message = `⚡ [tool: ${name}]${detail}`;
          events.emit("phaseStream", { text: `\n${message}\n` });
          emitLog("info", message);
          break;
        }
        case "tool.end": {
          const name = sanitizeTerminalText(event.name);
          if (event.ok) {
            events.emit("phaseStream", { text: `✓ [tool: ${name}] completed\n` });
          } else {
            const message = `✗ [tool: ${name}] error: ${sanitizeTerminalText(event.detail ?? "unknown error")}`;
            events.emit("phaseStream", { text: `\n${message}\n` });
            emitLog("warn", message);
          }
          break;
        }
        case "permission.request":
          // The answer never travels over the sink: only `onPermission` returns a
          // value, and a void channel must not be able to unblock a tool.
          emitLog("info", `permission requested: ${event.request.title}`);
          break;
        case "usage":
          total = addUsage(total, event);
          options.onUsage?.(event);
          events.emit("usage", {
            iteration: options.iteration,
            phase: options.phase,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            costUsd: event.costUsd,
            total: { ...total },
          });
          break;
        case "error":
          emitLog("error", event.message);
          break;
        case "done":
          break;
      }
    } catch {
      // A sink failure is never a phase failure.
    }
  };
}

function emitLog(level: "info" | "warn" | "error", message: string): void {
  events.emit("log", {
    level,
    message: sanitizeTerminalText(message),
    timestamp: new Date().toISOString(),
  });
}
