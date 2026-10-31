import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Box, render } from "ink";
import { DecisionModal } from "../../src/tui/Dashboard";
import type { DecisionRequest } from "../../src/engine/types";

type MockStdin = PassThrough & { isTTY: boolean; setRawMode: () => MockStdin; ref: () => MockStdin; unref: () => MockStdin };

function createMockStdin(): MockStdin {
  const stdin = new PassThrough() as MockStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

/** Renders the modal and returns what Ink wrote (it flushes on unmount). */
async function renderModal(req: DecisionRequest): Promise<string> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 100;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const instance = render(React.createElement(DecisionModal, { req }), {
    stdout,
    stdin: createMockStdin(),
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  return output;
}

/**
 * Renders the modal inside a fixed-height frame, the way the live dashboard
 * stacks it under the conversation cards. `flexShrink` used to let Yoga squash
 * the modal and silently drop option rows past the reserved height.
 */
async function renderInFrame(req: DecisionRequest, rows = 30): Promise<string> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 100;
  stdout.rows = rows;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const tree = React.createElement(
    Box,
    { flexDirection: "column", width: 100, height: rows, paddingX: 1 },
    React.createElement(Box, { height: Math.max(1, rows - 15) }),
    React.createElement(DecisionModal, { req }),
    React.createElement(Box, { height: 1 }),
    React.createElement(Box, { height: 1 }),
  );
  const instance = render(tree, { stdout, stdin: createMockStdin(), patchConsole: false });
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  return output;
}

const question = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
  id: "q1",
  kind: "question",
  iteration: 0,
  phase: "LIVE",
  attempt: 1,
  message: "Which database should I use?",
  questionItems: [
    {
      question: "Which database should I use?",
      options: [
        { label: "Postgres", description: "production-ready" },
        { label: "SQLite", description: "zero-config" },
      ],
    },
  ],
  ...overrides,
});

describe("DecisionModal — clarifying questions (REQ-37 / AC-37.3)", () => {
  it("renders every option with its number and description", async () => {
    // Regression: the option rows were built as <Box> nodes and rendered inside a
    // <Text>, which Ink never draws — the list was invisible (REV-001).
    const output = await renderModal(question());

    expect(output).toContain("Which database should I use?");
    expect(output).toContain("Postgres");
    expect(output).toContain("production-ready");
    expect(output).toContain("SQLite");
    expect(output).toContain("zero-config");
    expect(output).toContain("[1]");
    expect(output).toContain("[2]");
  });

  it("tells the user how to answer, and does not offer options it cannot answer", async () => {
    const output = await renderModal(question());
    expect(output).toMatch(/\[1-9\/Enter\]/);
    expect(output).toContain("Reject / skip question");
  });

  it("says how many further questions follow when a block carries several (REV-005)", async () => {
    const output = await renderModal(
      question({
        message: "First?\nSecond?",
        questionItems: [
          { question: "First?", options: [{ label: "A" }] },
          { question: "Second?", options: [{ label: "B" }] },
        ],
      }),
    );
    expect(output).toContain("First?");
    expect(output).toMatch(/1 more question/i);
  });

  it("degrades an option-less question to a plain accept/skip prompt", async () => {
    const output = await renderModal(
      question({ questionItems: [{ question: "Anything else?" }] }),
    );
    expect(output).toContain("Anything else?");
    expect(output).toContain("Reject / skip question");
  });

  it("keeps every option visible inside the live frame's fixed height", async () => {
    // Regression: the modal was flexShrink:1 with a hardcoded 6-row reservation,
    // so Yoga squashed it and dropped the last options off the screen.
    const options = Array.from({ length: 6 }, (_, index) => ({
      label: `Option-${index + 1}`,
    }));
    const output = await renderInFrame(question({ questionItems: [{ question: "Pick one", options }] }));

    for (let index = 1; index <= 6; index += 1) {
      expect(output).toContain(`Option-${index}`);
    }
  });

  it("shows which question of a block is on screen while paging through them", async () => {
    const output = await renderModal(
      question({
        message: "Second question?",
        questionItems: [{ question: "Second question?", options: [{ label: "Yes" }] }],
        questionIndex: 1,
        questionTotal: 3,
      }),
    );
    expect(output).toContain("(2/3)");
    expect(output).toContain("Second question?");
  });

  it("keeps the text of follow-up questions visible even when only the first is selectable", async () => {
    const output = await renderModal(
      question({
        questionItems: [
          { question: "First?", options: [{ label: "A" }] },
          { question: "Second?", options: [{ label: "B" }] },
        ],
      }),
    );
    expect(output).toContain("Second?");
    expect(output).toContain("B");
  });
});
