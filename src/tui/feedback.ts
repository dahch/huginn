/**
 * The TUI's single voice for user-facing feedback (REQ-31 / AC-31.1, AC-31.2).
 *
 * Every acknowledgement the Live console prints goes through the helpers below,
 * so the conversation reads as one narrator instead of a dozen ad-hoc strings:
 *
 *   ✓ <result>                       the action succeeded
 *   ⚠ <component> — <next step>      the action failed, with what to do next
 *   … <what is running>              the action started (the cards also spin)
 *
 * Failures always name the failing component, carry a next-step hint *before*
 * the raw cause, and keep the sanitized cause on its own `cause:` line instead
 * of dumping `(err as Error).message` at the user (AC-31.2). Every externally
 * sourced fragment is sanitized here, so a message can never smuggle control
 * sequences into the alternate-screen buffer (AC-31.4).
 */

import { sanitizeTerminalText } from "../util/text.js";

/** The action finished successfully. */
export const FEEDBACK_OK = "✓";
/** The action failed, or needs the user's attention. */
export const FEEDBACK_WARN = "⚠";
/** The action is running (the cards render a spinner alongside this). */
export const FEEDBACK_BUSY = "…";

/** Every feedback prefix, so a caller (or a test) can recognise one. */
export const FEEDBACK_PREFIXES = [FEEDBACK_OK, FEEDBACK_WARN, FEEDBACK_BUSY] as const;

/**
 * Next-step hints (AC-31.2). Each names the command that can actually fix the
 * failure, so an error never dead-ends in a bare stack fragment.
 */
export const NEXT_STEP = {
  /** Model discovery/picker failure: `/model <id>` or a free-text id. */
  modelSelection:
    "run `/model <id>` to choose a model, or `/model <thinker> [executor]` to set one directly",
  /** Runtime switch failure: `/agent`. */
  runtimeSwitch: "run `/agent` to open the runtime picker, then choose an installed runtime",
  /** MCP / runtime diagnostic failure: `/mcp`. */
  mcp: "run `/mcp` to inspect the MCP servers and their tools",
  /** `/status` failure: retry, or inspect the runtime through `/mcp`. */
  diagnostics: "run `/mcp` to inspect the runtime and its servers, then retry `/status`",
  /** A prompt / skill / draft failed: switch the model or the runtime. */
  session: "retry the turn, or switch with `/model <id>` and `/agent <id>`",
} as const;

/**
 * Where a model preference was about to be persisted, and how to retry
 * (AC-31.2: "say where it tried to write and how to retry").
 */
export function configSaveStep(targetPath: string): string {
  return (
    `could not write ${sanitizeTerminalText(targetPath)}: check permissions, ` +
    `then retry /model (choose "Session Only" to keep the change in memory)`
  );
}

/** `(err as Error).message`, or the stringified value, sanitized and trimmed. */
export function causeText(cause: unknown): string {
  if (cause === undefined || cause === null) return "";
  const raw = cause instanceof Error ? cause.message : String(cause);
  return sanitizeTerminalText(raw).trim();
}

/** `✓ <text>` — a completed action. */
export function okFeedback(text: string): string {
  return `${FEEDBACK_OK} ${sanitizeTerminalText(text)}`;
}

/** `⚠ <text>` — a problem the user should know about. */
export function warnFeedback(text: string): string {
  return `${FEEDBACK_WARN} ${sanitizeTerminalText(text)}`;
}

/** `… <text>` — an action that has just started. */
export function busyFeedback(text: string): string {
  return `${FEEDBACK_BUSY} ${sanitizeTerminalText(text)}`;
}

/**
 * `<component> — <next step>`, without the `⚠` prefix: for surfaces that draw
 * their own warning glyph (e.g. `ModelPickerModal`'s error row).
 */
export function failureHeadline(component: string, hint: string): string {
  return `${sanitizeTerminalText(component)} — ${sanitizeTerminalText(hint)}`;
}

/**
 * `⚠ <component> — <next step>` plus the raw sanitized cause on a `cause:` line.
 * The hint always comes first: the cause is supporting detail, never the message.
 */
export function failureFeedback(component: string, hint: string, cause?: unknown): string {
  const headline = `${FEEDBACK_WARN} ${failureHeadline(component, hint)}`;
  const cause_ = causeText(cause);
  return cause_ ? `${headline}\n  cause: ${cause_}` : headline;
}

/** True when `text` starts with one of the three feedback prefixes. */
export function hasFeedbackPrefix(text: string): boolean {
  return FEEDBACK_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * First-run guidance for an empty chat viewport (AC-31.3): a short, raven-
 * flavoured list of what the console can do, naming the palette, `/draft`,
 * `/mcp` and `/status`. Kept to six narrow rows so it fits the card on the
 * canonical 80×24 terminal without widening or overflowing it.
 */
export const EMPTY_CHAT_HINTS: readonly string[] = [
  "Huginn the raven is listening — the nest is empty for now.",
  "type / for the command palette  (↑/↓ move · Tab accept · Enter run)",
  "/draft   refine this idea into spec.md, adr.md and plan.md",
  "/mcp     inspect the MCP servers and the tools they expose",
  "/status  branch, sandbox, runtime, models and Muninn memory",
  "/help    the full cheat sheet — commands, shortcuts and aliases",
];

/**
 * The hint rows that fit in `maxRows` (one row each, since callers truncate
 * rather than wrap). Returns `[]` when the card has no room at all, so a
 * squeezed frame can never push the layout past the terminal height.
 */
export function emptyChatHints(maxRows: number): string[] {
  const rows = Math.max(0, Math.floor(maxRows));
  return EMPTY_CHAT_HINTS.slice(0, rows).map((line) => sanitizeTerminalText(line));
}
