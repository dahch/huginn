import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Box } from "ink";
import { render } from "./inkRender";
import stringWidth from "string-width";
import {
  DecisionModal,
  decisionBodyRows,
  decisionKeyRows,
} from "../../src/tui/DecisionModal";
import {
  DECISION_MIN_ROWS,
  decisionModalHeight,
  decisionTitle,
} from "../../src/tui/decision";
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

const EMOJI = /\p{Extended_Pictographic}/u;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

const baseRequest: DecisionRequest = {
  id: "d1",
  kind: "gate-blocked",
  iteration: 3,
  phase: "EXECUTE",
  attempt: 1,
  message: "A decision is required.",
};

/** The rendered title row, with Ink's colour/cursor sequences stripped. */
function titleRow(output: string, title: string): string | undefined {
  return output
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .find((line) => line.includes(title));
}

/** REQ-68 / ADR-63 — the decision modal speaks the product's single-width alphabet. */
describe("DecisionModal — decision alphabet (REQ-68)", () => {
  const cases: Array<[string, DecisionRequest, string]> = [
    [
      "approve-draft",
      { ...baseRequest, kind: "approve-draft", phase: "LIVE", iteration: 0 },
      "+ DECISION · Approve drafted docs",
    ],
    [
      "scope-extraction",
      { ...baseRequest, kind: "scope-extraction", phase: "LIVE", iteration: 0 },
      "! DECISION · Scope extraction failed",
    ],
    [
      "draft-format",
      { ...baseRequest, kind: "draft-format", phase: "LIVE", iteration: 0 },
      "! DECISION · Draft format violated",
    ],
    [
      "post-cycle-live",
      { ...baseRequest, kind: "post-cycle-live", phase: "LIVE", iteration: 1 },
      "* CYCLE FINISHED · Next action",
    ],
    [
      "question",
      {
        ...baseRequest,
        kind: "question",
        phase: "LIVE",
        iteration: 0,
        questionIndex: 1,
        questionTotal: 3,
      },
      "? QUESTION FROM AGENT · Input required (2/3)",
    ],
    [
      "permission",
      { ...baseRequest, kind: "permission", phase: "EXECUTE", iteration: 3 },
      "! PERMISSION REQUESTED · EXECUTE · iteration 3",
    ],
    [
      "spec-deviation",
      { ...baseRequest, kind: "spec-deviation", phase: "VALIDATE_STEP", iteration: 2 },
      "! SPEC DEVIATION · VALIDATE_STEP · iteration 2",
    ],
    ["gate-blocked", baseRequest, "! DECISION · Gate EXECUTE · iteration 3"],
  ];

  it("renders every title kind as a single-width, emoji-free line", async () => {
    for (const [kind, req, expected] of cases) {
      expect(decisionTitle(req), kind).toBe(expected);
      const output = await renderModal(req);
      const row = titleRow(output, expected);
      expect(row, `${kind} must render its title: ${JSON.stringify(output)}`).toBeDefined();
      expect(row).not.toMatch(EMOJI);
      // One terminal row, one column per code point: no double-width glyph.
      expect(stringWidth(row!)).toBe(row!.length);
    }
  });

  it("resolves every DecisionKind through the shared table", () => {
    const kinds: DecisionRequest["kind"][] = [
      "gate-blocked",
      "permission",
      "question",
      "spec-deviation",
      "approve-draft",
      "scope-extraction",
      "draft-format",
      "post-cycle-live",
    ];
    for (const kind of kinds) {
      const title = decisionTitle({ ...baseRequest, kind });
      expect(title).not.toMatch(EMOJI);
      expect(stringWidth(title)).toBe(title.length);
    }
  });

  it("renders the permission branch with its allow/deny keys and the shared warn mark", async () => {
    // The permission prompt is the one decision that can run arbitrary work, so
    // its keys must stay visible and its title must use the same measured mark.
    const req: DecisionRequest = { ...baseRequest, kind: "permission", message: "Run `rm -rf build`?" };
    const title = decisionTitle(req);
    const output = await renderModal(req);

    expect(title).toBe("! PERMISSION REQUESTED · EXECUTE · iteration 3");
    expect(titleRow(output, title)).toBeDefined();
    expect(output).toContain("Allow Always");
    expect(output).toContain("Allow Once");
    expect(output).toContain("Deny");
  });
});

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

// ── the modal's row contract (REQ-69) ───────────────────────────────────────

/** The rendered frame's lines, trailing blanks dropped (Ink rewrites in place). */
function frameLines(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Renders the modal capped at `maxRows`, keeping stdin so keys can be sent. */
async function renderCapped(
  req: DecisionRequest,
  maxRows?: number,
): Promise<{
  output: () => string;
  stdin: MockStdin;
  /** Drops the frames written so far, so a test can read only the next one. */
  resetOutput: () => void;
  unmount: () => void;
}> {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 100;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  const instance = render(
    React.createElement(DecisionModal, { req, maxRows }),
    { stdout, stdin, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  return {
    output: () => output,
    stdin,
    resetOutput: () => {
      output = "";
    },
    unmount: () => instance.unmount(),
  };
}

/** A question with descriptions and two follow-up questions — the tall case. */
const tallQuestion = (): DecisionRequest =>
  question({
    message: "Which database should I use?\nPick one to continue.",
    questionItems: [
      {
        question: "Which database should I use?",
        options: [
          { label: "Postgres", description: "production-ready" },
          { label: "SQLite", description: "zero-config" },
          { label: "DuckDB", description: "analytics-first" },
        ],
      },
      { question: "Which migration tool?", options: [{ label: "Prisma" }, { label: "Drizzle" }] },
      { question: "Where do backups go?", options: [{ label: "S3" }, { label: "Local" }] },
    ],
  });

describe("decisionModalHeight — the modal pays only what it occupies (REQ-69)", () => {
  it("is the exact number of rows Ink draws, border included", async () => {
    const requests: DecisionRequest[] = [
      baseRequest,
      { ...baseRequest, kind: "permission" },
      { ...baseRequest, kind: "approve-draft" },
      { ...baseRequest, kind: "post-cycle-live", choices: ["retry-promotion", "repair"] },
      question(),
      tallQuestion(),
    ];
    for (const req of requests) {
      const rendered = await renderCapped(req);
      rendered.unmount();
      const expected = decisionModalHeight(req);
      expect(frameLines(rendered.output()).length, `${req.kind} natural height`).toBe(expected);
      // The double border is the alert signal and always costs its two rows.
      expect(expected).toBeGreaterThanOrEqual(5);
    }
  });

  it("never draws more than maxRows and keeps the title and the key footer", async () => {
    const req = tallQuestion();
    const natural = decisionModalHeight(req);
    expect(natural).toBeGreaterThan(13);

    for (const maxRows of [6, 7, 8, 10, 12, natural - 1]) {
      const rendered = await renderCapped(req, maxRows);
      rendered.unmount();
      const lines = frameLines(rendered.output());
      // Windowed: the modal spends its whole budget, never a row more.
      expect(lines.length, `maxRows=${maxRows}`).toBe(maxRows);
      expect(lines.length, `maxRows=${maxRows}`).toBe(decisionModalHeight(req, maxRows));
      // The title, the key footer and the alert border survive the window.
      expect(rendered.output()).toContain(decisionTitle(req));
      expect(rendered.output()).toContain("[1-9/Enter]");
      expect(rendered.output()).toContain("Reject / skip question");
      expect(lines[0]).toMatch(/^╔/);
      expect(lines[lines.length - 1]).toMatch(/^╚/);
      // The indicator names how many body rows the window hides, in one column.
      expect(rendered.output()).toContain("… +");
      expect(stringWidth("…")).toBe(1);
    }
  });

  it("does not window a request that already fits, and never invents rows", async () => {
    const req = baseRequest;
    const natural = decisionModalHeight(req);
    expect(decisionModalHeight(req, natural)).toBe(natural);
    expect(decisionModalHeight(req, natural + 10)).toBe(natural);
  });

  it("draws nothing below its documented minimum row floor", () => {
    // A capped budget below DECISION_MIN_ROWS cannot pay for the title, one body
    // row and the key footer together, so it draws nothing rather than a title
    // that never says what to press.
    for (const maxRows of [1, 2, 3, 4]) {
      expect(decisionModalHeight(question(), maxRows), `maxRows=${maxRows}`).toBe(0);
    }
    expect(decisionModalHeight(question(), DECISION_MIN_ROWS)).toBe(DECISION_MIN_ROWS);
    for (const maxRows of [DECISION_MIN_ROWS, 6, 7, 8]) {
      expect(decisionModalHeight(question(), maxRows)).toBeLessThanOrEqual(maxRows);
    }
  });

  it("reports the structural floor when no request exists yet", () => {
    // The run dashboard's header reserves this before a decision is pending.
    expect(decisionModalHeight()).toBe(DECISION_MIN_ROWS);
  });

  it("counts the whole body even when it must window it", () => {
    const tall = tallQuestion();
    // Six body rows (question + 3 options + 2 follow-ups + note) at least; the
    // height stays bounded by the budget no matter how tall the body is.
    for (const maxRows of [6, 9, 14, 18]) {
      expect(decisionModalHeight(tall, maxRows)).toBeLessThanOrEqual(maxRows);
    }
  });

  it("counts every message line as its own row, so a newline cannot steal a row", async () => {
    // A question without question items falls back to the raw message. Its
    // newlines must be body rows the budget knows about, not rows Ink invents.
    const multiline: DecisionRequest = {
      ...baseRequest,
      kind: "question",
      message: "First line\nSecond line\nThird line",
      questionItems: undefined,
    };
    expect(decisionBodyRows(multiline)).toHaveLength(3);

    const rendered = await renderCapped(multiline);
    rendered.unmount();
    const lines = frameLines(rendered.output());
    expect(lines.length).toBe(decisionModalHeight(multiline));
    expect(rendered.output()).toContain("First line");
    expect(rendered.output()).toContain("Third line");
    // The key footer still owns its row: it is paid for before the body.
    expect(rendered.output()).toContain("[1-9/Enter]");
  });

  it("pays only the recovery key rows the request actually offers", async () => {
    const postCycle = (choices?: DecisionRequest["choices"]): DecisionRequest => ({
      ...baseRequest,
      kind: "post-cycle-live",
      phase: "LIVE",
      iteration: 0,
      ...(choices ? { choices } : {}),
    });

    // The base keys row is always paid; the recovery row only when offered.
    expect(decisionKeyRows(postCycle(["retry", "continue", "abort"]))).toHaveLength(1);
    expect(decisionKeyRows(postCycle(["retry-promotion"]))).toHaveLength(2);
    expect(decisionKeyRows(postCycle(["retry-promotion", "repair"]))).toHaveLength(2);

    const offered = await renderCapped(postCycle(["retry-promotion", "repair"]));
    offered.unmount();
    expect(offered.output()).toContain("[t]");
    expect(offered.output()).toContain("[p]");
    expect(frameLines(offered.output()).length).toBe(
      decisionModalHeight(postCycle(["retry-promotion", "repair"])),
    );

    const plain = await renderCapped(postCycle(["retry", "continue", "abort"]));
    plain.unmount();
    expect(plain.output()).toContain("Return to Live mode");
    expect(plain.output()).not.toContain("[t] ");
    expect(plain.output()).not.toContain("[p] ");
  });

  it("draws nothing below its structural floor instead of a title without keys", async () => {
    const req = question();
    const below = await renderCapped(req, DECISION_MIN_ROWS - 1);
    below.unmount();
    expect(frameLines(below.output())).toHaveLength(0);
    expect(below.output()).not.toContain(decisionTitle(req));
    expect(below.output()).not.toContain("[1-9/Enter]");

    // At the floor the title, a body row and the key footer all survive.
    const floor = await renderCapped(req, DECISION_MIN_ROWS);
    floor.unmount();
    const lines = frameLines(floor.output());
    expect(lines).toHaveLength(DECISION_MIN_ROWS);
    expect(floor.output()).toContain(decisionTitle(req));
    expect(floor.output()).toContain("[1-9/Enter]");
  });
});

describe("DecisionModal window — hidden body rows stay reachable (REQ-69)", () => {
  const eightOptions = (): DecisionRequest =>
    question({
      questionItems: [
        {
          question: "Pick one",
          options: Array.from({ length: 8 }, (_, index) => ({ label: `Option-${index + 1}` })),
        },
      ],
    });

  it("windows a body it cannot fit and hides the tail behind the indicator", async () => {
    const req = eightOptions();
    const rendered = await renderCapped(req, 8);
    rendered.unmount();
    const output = rendered.output();

    expect(output).toContain("Option-1");
    expect(output).not.toContain("Option-8");
    expect(output).toContain("… +6");
  });

  it("scrolls the body with ↓ so an option past the window becomes reachable", async () => {
    const req = eightOptions();
    const rendered = await renderCapped(req, 8);
    // Six ↓ presses walk the window to the bottom of the body.
    for (let index = 0; index < 6; index += 1) {
      rendered.stdin.write("\u001B[B");
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 80));
    rendered.unmount();
    const output = rendered.output();

    expect(output).toContain("Option-8");
    expect(output).toContain("[1-9/Enter]");
    // The window really moved: the first option is now above it.
    expect(frameLines(output).join("\n")).not.toContain("Option-1");
  });

  it("scrolls back with ↑ so the window is never stuck at the tail", async () => {
    const req = eightOptions();
    const rendered = await renderCapped(req, 8);
    for (let index = 0; index < 6; index += 1) {
      rendered.stdin.write("\u001B[B");
      await new Promise((r) => setTimeout(r, 20));
    }
    // Read only the frame the ↑ produces, not the tail frames before it.
    rendered.resetOutput();
    rendered.stdin.write("\u001B[A");
    await new Promise((r) => setTimeout(r, 80));
    rendered.unmount();
    const output = rendered.output();

    expect(output).toContain("Option-5");
    expect(output).toContain("Option-7");
    expect(output).not.toContain("Option-8");
  });
});
