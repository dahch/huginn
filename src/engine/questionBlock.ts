import { sanitizeTerminalText } from "../util/text.js";
import type { QuestionItem } from "./types.js";

/**
 * Agent-agnostic question protocol (REQ-37 / AC-37.1 / ADR-36).
 *
 * Only opencode can surface a mid-turn question, and only through its own event
 * stream: every subprocess CLI closes stdin after the prompt, so it cannot ask at
 * all. A *marked block* in the agent's output needs no protocol support from the
 * CLI, so any runtime can ask:
 *
 * ```
 * <<<HUGINN_QUESTION>>>
 * [{"question": "Which database?", "options": [{"label": "Postgres"}, {"label": "SQLite"}]}]
 * <<<END_HUGINN_QUESTION>>>
 * ```
 *
 * Huginn parses it out, strips it from what the user sees, presents the options,
 * and resumes the turn with the chosen answer(s).
 */
export const QUESTION_BLOCK_START = "<<<HUGINN_QUESTION>>>";
export const QUESTION_BLOCK_END = "<<<END_HUGINN_QUESTION>>>";

/**
 * The markers, as models actually emit them.
 *
 * The documented literal is `<<<HUGINN_QUESTION>>>`, and a model that "remembers"
 * it may still render the separator as a space (`<<<END HUGINN QUESTION>>>`) or
 * change the case. Those variants are the same token to a reader and a different
 * token to `includes()`, which is how a perfectly usable question turned into raw
 * JSON on screen. Matching is normalized; the payload contract is not.
 */
const START_MARKER = /<<<\s*HUGINN[\s_-]*QUESTION\s*>>>/i;
const END_MARKER = /<<<\s*END[\s_-]*HUGINN[\s_-]*QUESTION\s*>>>/i;

/** Both markers, for stripping every block out of a reply (REV-009). */
const ANY_BLOCK = new RegExp(
  `${START_MARKER.source}[\\s\\S]*?${END_MARKER.source}`,
  "gi",
);

/** Bounds on an untrusted payload, so a quoted file cannot flood the modal (REV-010). */
const MAX_QUESTION_PAYLOAD_BYTES = 64 * 1024;
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 8;
const MAX_LABEL_CHARS = 160;

export interface ParsedQuestionBlock {
  /** The questions the agent asked (empty when there were none). */
  questions: QuestionItem[];
  /** The agent's output with the block removed, ready to display. */
  cleanedText: string;
  /** Set when a block was present but could not be used (AC-37.4). */
  warning?: string;
}

/** Normalize one raw question into a safe `QuestionItem`, or undefined. */
export function normalizeQuestion(raw: unknown): QuestionItem | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const question = typeof record.question === "string" ? record.question : "";
  if (question.trim().length === 0) return undefined;

  const rawOptions = Array.isArray(record.options) ? record.options.slice(0, MAX_OPTIONS) : [];
  const options = rawOptions
    .map((option) => {
      if (typeof option === "string") return { label: sanitizeTerminalText(option) };
      if (typeof option !== "object" || option === null) return undefined;
      const entry = option as Record<string, unknown>;
      const label = typeof entry.label === "string" ? entry.label : "";
      if (!label.trim()) return undefined;
      const description = typeof entry.description === "string" ? entry.description : undefined;
      return {
        label: sanitizeTerminalText(label).slice(0, MAX_LABEL_CHARS),
        ...(description
          ? { description: sanitizeTerminalText(description).slice(0, MAX_LABEL_CHARS) }
          : {}),
      };
    })
    .filter((option): option is { label: string; description?: string } => option !== undefined);

  return {
    question: sanitizeTerminalText(question).slice(0, MAX_LABEL_CHARS),
    ...(typeof record.header === "string" && record.header.trim()
      ? { header: sanitizeTerminalText(record.header) }
      : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(record.multiple === true ? { multiple: true } : {}),
    ...(record.custom === true ? { custom: true } : {}),
  };
}

/**
 * Parse a payload into questions, or undefined when it is not that shape.
 * Shared by the normal path and the recovery path, so both accept exactly the
 * same payloads.
 */
function tryParseQuestions(payload: string): QuestionItem[] | undefined {
  if (payload.length > MAX_QUESTION_PAYLOAD_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const rawQuestions = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, MAX_QUESTIONS);
  const questions = rawQuestions
    .map((raw) => normalizeQuestion(raw))
    .filter((question): question is QuestionItem => question !== undefined);
  return questions.length > 0 ? questions : undefined;
}

/**
 * A reply that ends on the closing marker without ever opening the block.
 *
 * The payload sits in the paragraph immediately before the marker — exactly
 * where a well-formed block would have put it. It is accepted only when that
 * paragraph really is the questions array; otherwise the reply is left intact
 * and the marker is reported, so a stray token cannot swallow the agent's prose.
 */
function recoverUnopenedBlock(text: string, endMatch: RegExpExecArray): ParsedQuestionBlock {
  const beforeEnd = text.slice(0, endMatch.index);
  const paragraphBreak = beforeEnd.lastIndexOf("\n\n");
  const candidate = beforeEnd.slice(paragraphBreak === -1 ? 0 : paragraphBreak).trim();

  if (candidate.startsWith("[") || candidate.startsWith("{")) {
    const questions = tryParseQuestions(candidate);
    if (questions) {
      const prose = paragraphBreak === -1 ? "" : beforeEnd.slice(0, paragraphBreak);
      return {
        questions,
        cleanedText: prose.replace(ANY_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim(),
      };
    }
  }

  return {
    questions: [],
    cleanedText: text
      .replace(ANY_BLOCK, "")
      .replace(new RegExp(END_MARKER.source, "gi"), "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    warning: "the agent closed a question block that was never opened",
  };
}

/**
 * Extract a question block from agent output.
 *
 * Never throws: a block that is present but malformed is *reported* (AC-37.4)
 * rather than dropped silently, and the raw payload is sanitized before it can
 * reach the screen.
 */
export function parseQuestionBlock(text: string): ParsedQuestionBlock {
  // The markers are located by position, never anchored to their own line.
  // Models routinely glue the payload to the opening marker (or the closing one
  // to the payload), and a line-anchored match turned a perfectly usable
  // question into a silent no-op: `hasQuestionBlock` said true while this
  // function returned zero questions and no warning, leaving the raw JSON on
  // screen (AC-37.4). Tolerating the layout still requires both markers.
  const startMatch = START_MARKER.exec(text);
  const endMatch = END_MARKER.exec(text);

  if (!startMatch) {
    // A closing marker with no opener is the same failure the other way round:
    // the payload is right there, immediately before it, and dropping the reply
    // into "raw JSON on screen" helps nobody. Recover the paragraph that ends at
    // the marker when it parses as the questions payload; otherwise report it.
    if (endMatch) return recoverUnopenedBlock(text, endMatch);
    return { questions: [], cleanedText: text };
  }

  const payloadStart = startMatch.index + startMatch[0].length;

  // A block must be delimited by both markers; an unclosed one would otherwise
  // silently truncate the reply (REV-008). The closing marker is searched from
  // the payload, so an earlier one (a second block's) cannot close this block.
  const endAfterStart = new RegExp(END_MARKER.source, "gi");
  endAfterStart.lastIndex = payloadStart;
  const closing = endAfterStart.exec(text);
  const endIndex = closing ? closing.index : -1;
  if (endIndex === -1) {
    return {
      questions: [],
      cleanedText: (text.slice(0, startMatch.index) + text.slice(payloadStart)).trim(),
      warning: "the agent opened a question block and never closed it",
    };
  }

  const payload = text.slice(payloadStart, endIndex).trim();
  // Strip *every* block, so a second one cannot leak raw markers/JSON (REV-009).
  const cleanedText = text
    .replace(ANY_BLOCK, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (payload.length > MAX_QUESTION_PAYLOAD_BYTES) {
    return {
      questions: [],
      cleanedText,
      warning: `the agent emitted an oversized question block (${payload.length} bytes)`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {
      questions: [],
      cleanedText,
      warning: `the agent emitted a question block that is not valid JSON: ${sanitizeTerminalText(
        payload.slice(0, 200),
      )}`,
    };
  }

  const rawQuestions = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, MAX_QUESTIONS);
  const questions = rawQuestions
    .map((raw) => normalizeQuestion(raw))
    .filter((question): question is QuestionItem => question !== undefined);

  if (questions.length === 0) {
    return {
      questions: [],
      cleanedText,
      warning: `the agent emitted a question block with no usable question: ${sanitizeTerminalText(
        payload.slice(0, 200),
      )}`,
    };
  }

  return { questions, cleanedText };
}

/** True when the text carries a question block at all. */
export function hasQuestionBlock(text: string): boolean {
  // Tolerant for the same reason the parser is: a marker rendered with spaces is
  // the same intent, and this predicate must never disagree with the parser
  // (that disagreement is what produced a silent no-op).
  return START_MARKER.test(text) || END_MARKER.test(text);
}

/**
 * The follow-up turn that hands the choices back to the agent (AC-37.1). Written
 * as a plain user message so it works on every runtime.
 */
export function formatQuestionAnswer(questions: QuestionItem[], labels: string[]): string {
  const lines = questions.map((question, index) => {
    const answer = labels[index] ?? labels[0] ?? "";
    return `- ${question.question} → ${answer || "(no preference — use your best judgement)"}`;
  });
  return [
    "Answering your clarifying question(s):",
    ...lines,
    "",
    "Continue with the task using these answers.",
  ].join("\n");
}
