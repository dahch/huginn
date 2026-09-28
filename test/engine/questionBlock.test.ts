import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatQuestionAnswer,
  hasQuestionBlock,
  normalizeQuestion,
  parseQuestionBlock,
  QUESTION_BLOCK_END,
  QUESTION_BLOCK_START,
} from "../../src/engine/questionBlock.js";
import { DecisionBroker } from "../../src/engine/decisionBroker.js";
import { events } from "../../src/engine/engineEvents.js";

const wrap = (payload: string): string =>
  `Here is my answer.\n${QUESTION_BLOCK_START}\n${payload}\n${QUESTION_BLOCK_END}\nWaiting for you.`;

describe("agent-agnostic question protocol (REQ-37 / ADR-36)", () => {
  afterEach(() => {
    events.clear();
  });

  it("extracts a block, strips it from the displayed text, and keeps the questions", () => {
    const parsed = parseQuestionBlock(
      wrap(
        JSON.stringify([
          {
            question: "Which database should I use?",
            header: "Storage",
            options: [
              { label: "Postgres", description: "production-ready" },
              { label: "SQLite", description: "zero-config" },
            ],
          },
        ]),
      ),
    );

    expect(parsed.warning).toBeUndefined();
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0]!.question).toBe("Which database should I use?");
    expect(parsed.questions[0]!.header).toBe("Storage");
    expect(parsed.questions[0]!.options?.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
    // The user must never see the protocol marker.
    expect(parsed.cleanedText).toBe("Here is my answer.\n\nWaiting for you.");
    expect(parsed.cleanedText).not.toContain(QUESTION_BLOCK_START);
  });

  it("returns the text untouched when there is no block", () => {
    const parsed = parseQuestionBlock("just a normal reply");
    expect(parsed.questions).toEqual([]);
    expect(parsed.cleanedText).toBe("just a normal reply");
    expect(hasQuestionBlock("just a normal reply")).toBe(false);
    expect(hasQuestionBlock(`${QUESTION_BLOCK_START} x`)).toBe(true);
  });

  it("reports a malformed block instead of dropping it silently (AC-37.4)", () => {
    const parsed = parseQuestionBlock(wrap("{ not json"));
    expect(parsed.questions).toEqual([]);
    expect(parsed.warning).toMatch(/not valid JSON/i);
    // The raw payload is sanitized before it can reach the screen.
    expect(parsed.cleanedText).not.toContain(QUESTION_BLOCK_START);
  });

  it("reports a block with no usable question", () => {
    const parsed = parseQuestionBlock(wrap(JSON.stringify([{ options: [] }])));
    expect(parsed.questions).toEqual([]);
    expect(parsed.warning).toMatch(/no usable question/i);
  });

  it("keeps the rest of the reply when the block is never closed (REV-008)", () => {
    const parsed = parseQuestionBlock(
      `Here is my answer.\n${QUESTION_BLOCK_START}\n[{"question":"Which?"}]\nand more text`,
    );
    expect(parsed.questions).toEqual([]);
    expect(parsed.warning).toMatch(/never closed/i);
    // The reply must not be silently truncated: everything survives.
    expect(parsed.cleanedText).toContain("Here is my answer.");
    expect(parsed.cleanedText).toContain("and more text");
    expect(parsed.cleanedText).not.toContain(QUESTION_BLOCK_START);
  });

  it("strips every block so a second one cannot leak raw markers (REV-009)", () => {
    const block = `${QUESTION_BLOCK_START}\n${JSON.stringify([{ question: "Q?" }])}\n${QUESTION_BLOCK_END}`;
    const parsed = parseQuestionBlock(`before\n${block}\nmiddle\n${block}\nafter`);
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.cleanedText).not.toContain(QUESTION_BLOCK_START);
    expect(parsed.cleanedText).not.toContain(QUESTION_BLOCK_END);
    expect(parsed.cleanedText).toContain("before");
    expect(parsed.cleanedText).toContain("after");
  });

  it("clamps an oversized payload instead of flooding the modal (REV-010)", () => {
    const parsed = parseQuestionBlock(
      wrap(JSON.stringify([{ question: "Q?".repeat(50_000) }])),
    );
    expect(parsed.questions).toEqual([]);
    expect(parsed.warning).toMatch(/oversized/i);
  });

  it("degrades an option-less question to free text rather than inventing options", () => {
    const parsed = parseQuestionBlock(wrap(JSON.stringify([{ question: "Anything else?" }])));
    expect(parsed.questions[0]!.question).toBe("Anything else?");
    expect(parsed.questions[0]!.options).toBeUndefined();
  });

  it("sanitizes every field and rejects prototype-pollution keys", () => {
    const raw = normalizeQuestion({
      question: "q\u001b[31m",
      options: ["a\u001b[2J", { label: "b", description: "d\u009bX" }],
      __proto__: { polluted: true },
    });
    expect(raw?.question).toBe("q");
    expect(raw?.options?.map((o) => o.label)).toEqual(["a", "b"]);
    expect(raw?.options?.[1]?.description).toBe("dX");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("formats the follow-up turn with the chosen answers", () => {
    const answer = formatQuestionAnswer(
      [{ question: "Which database?" }],
      ["Postgres"],
    );
    expect(answer).toContain("Which database? → Postgres");
    expect(answer).toMatch(/continue with the task/i);
    // No answer → the agent is told to use its judgement rather than being blocked.
    expect(formatQuestionAnswer([{ question: "Which database?" }], [])).toMatch(/best judgement/i);
  });

  it("carries the chosen option through the decision broker (AC-37.3)", async () => {
    const broker = new DecisionBroker();
    const requested = broker.request({
      id: "q1",
      kind: "question",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message: "Which database?",
      questionItems: [{ question: "Which database?", options: [{ label: "Postgres" }] }],
    });

    // The TUI answers with the label it rendered.
    broker.resolve("continue", ["Postgres"]);

    await expect(requested).resolves.toBe("continue");
    expect(broker.takeAnswers()).toEqual(["Postgres"]);
    // Taking them clears them, so a later decision cannot inherit the last answer.
    expect(broker.takeAnswers()).toEqual([]);
  });
});
