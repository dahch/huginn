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
 * Extract a question block from agent output.
 *
 * Never throws: a block that is present but malformed is *reported* (AC-37.4)
 * rather than dropped silently, and the raw payload is sanitized before it can
 * reach the screen.
 */
export function parseQuestionBlock(text: string): ParsedQuestionBlock {
  const marker = new RegExp(`^\\s*${QUESTION_BLOCK_START}\\s*$`, "m");
  if (!marker.test(text)) return { questions: [], cleanedText: text };

  // A block must be delimited by both markers; an unclosed one would otherwise
  // silently truncate the reply (REV-008).
  const endMarker = new RegExp(`^\\s*${QUESTION_BLOCK_END}\\s*$`, "m");
  const endMatch = endMarker.exec(text);
  if (!endMatch) {
    return {
      questions: [],
      cleanedText: text.replace(marker, "").trim(),
      warning: "the agent opened a question block and never closed it",
    };
  }

  const startMatch = marker.exec(text)!;
  const payload = text.slice(startMatch.index + startMatch[0].length, endMatch.index).trim();
  // Strip *every* block, so a second one cannot leak raw markers/JSON (REV-009).
  const cleanedText = text
    .replace(
      new RegExp(`${QUESTION_BLOCK_START}[\\s\\S]*?${QUESTION_BLOCK_END}`, "g"),
      "",
    )
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
  return text.includes(QUESTION_BLOCK_START);
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
