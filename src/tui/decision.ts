/**
 * The decision modal's pure policy: its title, row model, planner and height
 * helper (REQ-68 / REQ-69 / ADR-63 / ADR-64).
 *
 * Kept out of `Dashboard.tsx` so neither this policy nor the drift guard has to
 * import a whole Ink page and its engine dependencies. The title mapping is
 * exhaustive: a new kind must be handled here or TypeScript rejects it, so it
 * can never silently inherit the gate wording. The row specs are plain data, so
 * the React row builders in `DecisionModal.tsx` and the pure planner below
 * count the exact same rows instead of maintaining two copies of the layout.
 */
import type { DecisionChoice, DecisionRequest } from "../engine/types";
import { decisionGlyph } from "./glyphs.js";
import type { ThemeToken } from "./theme.js";

/** Compile-time proof that every `DecisionKind` has a title. */
function assertNever(value: never): never {
  throw new Error(`Unhandled decision kind: ${String(value)}`);
}

/**
 * The title line for a decision request, composed from the shared decision
 * alphabet. Pure and exported so the drift guard can measure every kind
 * without mounting Ink.
 */
export function decisionTitle(req: DecisionRequest): string {
  const glyph = decisionGlyph(req.kind);
  switch (req.kind) {
    case "approve-draft":
      return `${glyph} DECISION · Approve drafted docs`;
    case "scope-extraction":
      return `${glyph} DECISION · Scope extraction failed`;
    case "draft-format":
      return `${glyph} DECISION · Draft format violated`;
    case "post-cycle-live":
      return `${glyph} CYCLE FINISHED · Next action`;
    case "question": {
      const position =
        req.questionTotal && req.questionTotal > 1
          ? ` (${(req.questionIndex ?? 0) + 1}/${req.questionTotal})`
          : "";
      return `${glyph} QUESTION FROM AGENT · Input required${position}`;
    }
    case "permission":
      return `${glyph} PERMISSION REQUESTED · ${req.phase} · iteration ${req.iteration}`;
    case "spec-deviation":
      return `${glyph} SPEC DEVIATION · ${req.phase} · iteration ${req.iteration}`;
    case "gate-blocked":
      return `${glyph} DECISION · Gate ${req.phase} · iteration ${req.iteration}`;
    default:
      return assertNever(req.kind);
  }
}

/** Rows the decision modal's double border spends (top + bottom). */
const DECISION_BORDER_ROWS = 2;
/** The modal's title row — never windowed away. */
const DECISION_TITLE_ROWS = 1;
/** Narrowest body the modal keeps before it starts dropping chrome. */
const DECISION_BODY_MIN_ROWS = 1;
/** At least one key-footer row: the modal must always say what to press. */
const DECISION_KEY_MIN_ROWS = 1;
/**
 * The smallest decision modal that still shows its title, one body row and its
 * key footer. `decisionModalHeight` computes the real cost of an actual request;
 * this is the floor the header reserves before one exists and the budget below
 * which the modal draws nothing at all.
 */
export const DECISION_MIN_ROWS =
  DECISION_BORDER_ROWS + DECISION_TITLE_ROWS + DECISION_BODY_MIN_ROWS + DECISION_KEY_MIN_ROWS;

/** One `[key] label` hint, rendered inline in a single footer row. */
export interface KeyHint {
  key: string;
  label: string;
  token: ThemeToken;
}

/** A body line: either a text line or one option of a question. */
export type DecisionBodyRowSpec =
  | {
      kind: "text";
      key: string;
      text: string;
      color: ThemeToken;
      bold: boolean;
    }
  | {
      kind: "option";
      key: string;
      index: number;
      label: string;
      description?: string;
      muted: boolean;
    };

/** One key-footer row; its hints share that terminal row. */
export interface DecisionKeyRowSpec {
  key: string;
  hints: KeyHint[];
}

/** A request message broken into one spec per line. */
function textSpecs(
  text: string,
  keyPrefix: string,
  color: ThemeToken = "text",
  bold = false,
): DecisionBodyRowSpec[] {
  return text.split("\n").map((line, index) => ({
    kind: "text",
    key: `${keyPrefix}-${index}`,
    text: line,
    color,
    bold,
  }));
}

/** The options of one question, one spec per option. */
function optionSpecs(
  options: ReadonlyArray<{ label: string; description?: string }>,
  itemKey: string,
  muted = false,
): DecisionBodyRowSpec[] {
  return options.map((option, index) => ({
    kind: "option",
    key: `${itemKey}-o${index}`,
    index,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    muted,
  }));
}

/**
 * The modal body as plain one-row specs. `DecisionModal.tsx` maps these to
 * React nodes; `decisionModalHeight` only needs their length.
 */
export function decisionBodyRowSpecs(req: DecisionRequest): DecisionBodyRowSpec[] {
  const firstItem = req.kind === "question" ? req.questionItems?.[0] : undefined;

  // A question renders its own text below, so repeating the request's message
  // there would show the same sentence twice.
  if (!firstItem) return textSpecs(req.message, "msg", "text", true);

  const rows: DecisionBodyRowSpec[] = [];
  rows.push(...textSpecs(firstItem.question, "question"));
  rows.push(...optionSpecs(firstItem.options ?? [], "first"));

  // A block that arrived whole (opencode's native channel) still only lets one
  // question be answered, but the rest stay visible instead of collapsing into
  // an unreadable "+N more".
  const followUps = req.questionItems?.slice(1) ?? [];
  followUps.forEach((item, index) => {
    rows.push(...textSpecs(item.question, `more-q${index}`, "muted"));
    rows.push(...optionSpecs(item.options ?? [], `more-${index}`, true));
  });
  if (followUps.length > 0) {
    rows.push(
      ...textSpecs(
        `+ ${followUps.length} more question(s) — answer the first, the rest follow.`,
        "more-note",
        "muted",
      ),
    );
  }
  return rows;
}

/**
 * The modal's key footer as plain one-row specs. It is paid for **before** any
 * body row, so windowing the body can never hide what to press (REQ-69).
 */
export function decisionKeyRowSpecs(req: DecisionRequest): DecisionKeyRowSpec[] {
  const row = (key: string, hints: KeyHint[]): DecisionKeyRowSpec => ({ key, hints });
  switch (req.kind) {
    case "approve-draft":
      return [
        row("keys", [
          { key: "[r] ", label: "Re-draft with latest chat   ", token: "accent" },
          { key: "[c] ", label: "OK — commit & execute   ", token: "ok" },
          { key: "[a] ", label: "Abort", token: "danger" },
        ]),
      ];
    case "scope-extraction":
      return [
        row("keys", [
          { key: "[r] ", label: "Retry extraction   ", token: "accent" },
          { key: "[c] ", label: "Use my last message   ", token: "warn" },
          { key: "[a] ", label: "Abort", token: "danger" },
        ]),
      ];
    case "draft-format":
      return [
        row("keys", [
          { key: "[r] ", label: "Retry with contract   ", token: "accent" },
          { key: "[c] ", label: "Accept as-is   ", token: "warn" },
          { key: "[a] ", label: "Abort", token: "danger" },
        ]),
      ];
    case "post-cycle-live": {
      const offers = (choice: DecisionChoice): boolean =>
        !req.choices || req.choices.includes(choice);
      const rows: DecisionKeyRowSpec[] = [];
      const recovery: KeyHint[] = [];
      if (offers("retry-promotion")) {
        recovery.push({ key: "[t] ", label: "Retry promotion (no model)   ", token: "accent" });
      }
      if (offers("repair")) {
        recovery.push({
          key: "[p] ",
          label: "Repair promotion (thinker + executor)",
          token: "thinker",
        });
      }
      if (recovery.length > 0) rows.push(row("recovery", recovery));
      rows.push(
        row("keys", [
          { key: "[c] ", label: "Exit / Finish   ", token: "ok" },
          { key: "[r] ", label: "Return to Live mode   ", token: "accent" },
          { key: "[a] ", label: "Exit", token: "danger" },
        ]),
      );
      return rows;
    }
    case "question":
      return [
        row("keys", [
          { key: "[1-9/Enter] ", label: "Pick an option   ", token: "ok" },
          { key: "[d] ", label: "Reject / skip question", token: "danger" },
        ]),
      ];
    case "permission":
      return [
        row("keys", [
          { key: "[a] ", label: "Allow Always   ", token: "accent" },
          { key: "[o] ", label: "Allow Once   ", token: "accent" },
          { key: "[d] ", label: "Deny", token: "danger" },
        ]),
      ];
    case "gate-blocked":
    case "spec-deviation":
    default:
      return [
        row("keys", [
          { key: "[r] ", label: "Retry with Thinker   ", token: "accent" },
          { key: "[c] ", label: "Force Continue   ", token: "warn" },
          { key: "[a] ", label: "Abort Run", token: "danger" },
        ]),
      ];
  }
}

/** How {@link planDecisionModal} spends a row budget. */
export interface DecisionModalPlan {
  /** Total rows the modal draws, double border included. */
  height: number;
  /** Title rows drawn (zero only when the whole modal draws nothing). */
  titleRows: number;
  /** First body row to draw, and how many of them. */
  bodyStart: number;
  bodyCount: number;
  /** Body rows the window hides: the number the `… +N` indicator reports. */
  hiddenBody: number;
  /** Key-footer rows drawn. */
  keyCount: number;
  /** Whether the `… +N` indicator row is paid for. */
  showIndicator: boolean;
}

/** The plan a capped budget below the documented floor produces. */
const EMPTY_DECISION_PLAN = (hiddenBody: number): DecisionModalPlan => ({
  height: 0,
  titleRows: 0,
  bodyStart: 0,
  bodyCount: 0,
  hiddenBody,
  keyCount: 0,
  showIndicator: false,
});

/**
 * Turn a body/footer size into an exact layout, honouring `maxRows`.
 *
 * Without a cap the modal keeps its natural height. With one, it pays the
 * double border, the title and the key footer first, buys the `… +N` indicator
 * only when it still leaves a body row, and spends the rest on the body window
 * — so it never draws more rows than `maxRows` (REQ-69).
 *
 * A capped budget below {@link DECISION_MIN_ROWS} draws nothing: a title without
 * its key footer would tell the user what happened but not what to press, so the
 * documented floor is enforced rather than silently degraded.
 */
export function planDecisionModal(
  bodyCount: number,
  keyCount: number,
  maxRows?: number,
  scroll = 0,
): DecisionModalPlan {
  if (maxRows !== undefined && maxRows < DECISION_MIN_ROWS) {
    return EMPTY_DECISION_PLAN(bodyCount);
  }

  const natural = DECISION_BORDER_ROWS + DECISION_TITLE_ROWS + bodyCount + keyCount;
  if (maxRows === undefined || natural <= maxRows) {
    return {
      height: natural,
      titleRows: DECISION_TITLE_ROWS,
      bodyStart: 0,
      bodyCount,
      hiddenBody: 0,
      keyCount,
      showIndicator: false,
    };
  }

  let interior = Math.max(0, maxRows - DECISION_BORDER_ROWS);
  const titleRows = Math.min(DECISION_TITLE_ROWS, interior);
  interior -= titleRows;
  const keys = Math.min(keyCount, Math.max(0, interior - DECISION_BODY_MIN_ROWS));
  interior -= keys;
  const showIndicator = interior - 1 >= DECISION_BODY_MIN_ROWS;
  const bodyRoom = showIndicator ? interior - 1 : interior;
  const count = Math.max(0, Math.min(bodyCount, bodyRoom));
  const start = Math.min(Math.max(0, Math.floor(scroll)), Math.max(0, bodyCount - count));
  return {
    height: DECISION_BORDER_ROWS + titleRows + count + (showIndicator ? 1 : 0) + keys,
    titleRows,
    bodyStart: start,
    bodyCount: count,
    hiddenBody: bodyCount - count,
    keyCount: keys,
    showIndicator,
  };
}

/**
 * The exact number of terminal rows a decision modal draws, double border
 * included. Pure and exported so both dashboards reserve the real cost instead
 * of a literal, and so the guard tests can compare the reservation with the
 * rows Ink actually paints (REQ-69).
 *
 * Called with no request it returns the structural floor — the rows the header
 * reserves before any decision exists.
 */
export function decisionModalHeight(req?: DecisionRequest, maxRows?: number): number {
  if (!req) return DECISION_MIN_ROWS;
  return planDecisionModal(
    decisionBodyRowSpecs(req).length,
    decisionKeyRowSpecs(req).length,
    maxRows,
  ).height;
}
