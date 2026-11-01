/**
 * The one table of phase/status glyphs (REQ-52 / ADR-51).
 *
 * The pipeline grid, the last-result pill and `.harness/PROGRESS.md` used to
 * carry their own emoji (`⏳ ✅ 🟡 🔴 ⏭️`, `🔍 ⚡ 🚦 …`) — double-width, multi-toned
 * and easy to drift, they broke the monospace grid the rest of the theme is built
 * on. Everything a surface draws now comes from here: printable, **single-width**
 * ASCII/box-drawing characters whose colour the caller resolves through the
 * semantic theme tokens.
 *
 * Out of scope, deliberately: the gate marker literals huginn's own prompts and
 * parsers agree on (`### Overall gate: 🟢/🟡/🔴`) and the stream markers a runtime
 * emits. Those are contracts and producer output, not display glyphs.
 */
import type { DecisionKind, Verdict } from "../engine/types";

/** Status glyphs, one per state a phase row can be in. */
export const STATUS_GLYPHS = {
  /** Not started. */
  pending: "·",
  /** The first frame of the animated spinner (callers advance their own). */
  running: "⠋",
  /** Verdict `pass`. */
  pass: "✓",
  /** Verdict `warning`. */
  warning: "!",
  /** Verdict `blocked`. */
  blocked: "✕",
  /** Verdict `skipped`. */
  skipped: "–",
} as const;

export type StatusGlyph = keyof typeof STATUS_GLYPHS;

/**
 * Decision-modal glyphs (REQ-68 / ADR-63).
 *
 * The decision modal and the feedback channel used to speak pictographs (`📋`,
 * `❓`, a double-width warning sign) while the rest of the product used the single-width
 * status alphabet, so the one surface that demands the user's attention was
 * also the one that broke the monospace grid. These four marks are the decision
 * alphabet: one printable, single-column, **ASCII** character per intent,
 * with colour left to the modal's own theme token. ASCII is part of the
 * contract because a non-ASCII single-column mark (`✓`, `·`, `–`) still mints
 * a new code point for no gain; the feedback channel keeps its own `✓`/`…`
 * voice, and the gate/fidelity literals and stream markers a runtime emits are
 * still out of scope. The marks are deliberately non-letter characters: the
 * modal's own key hints use `r`, `c`, `a`, `o`, `d`, `t`, `p` and digits, so an
 * `A`/`D` title would read like another key to press.
 */
export const DECISION_GLYPHS = {
  /** A drafted document awaits approval. */
  approve: "+",
  /** The agent is asking for input. */
  question: "?",
  /** The run failed or needs attention. */
  warn: "!",
  /** The cycle finished and offers a next action. */
  done: "*",
} as const;

export type DecisionGlyph = (typeof DECISION_GLYPHS)[keyof typeof DECISION_GLYPHS];

/** Compile-time proof that every {@link DecisionKind} has a glyph. */
function assertNever(value: never): never {
  throw new Error(`Unhandled decision kind: ${String(value)}`);
}

/** The decision glyph for a {@link DecisionKind} (permission/gate share `warn`). */
export function decisionGlyph(kind: DecisionKind): DecisionGlyph {
  switch (kind) {
    case "approve-draft":
      return DECISION_GLYPHS.approve;
    case "question":
      return DECISION_GLYPHS.question;
    case "post-cycle-live":
      return DECISION_GLYPHS.done;
    case "gate-blocked":
    case "permission":
    case "spec-deviation":
    case "scope-extraction":
    case "draft-format":
      return DECISION_GLYPHS.warn;
    default:
      return assertNever(kind);
  }
}

/** The status glyph for a verdict. */
export function verdictGlyph(verdict: Verdict): string {
  switch (verdict) {
    case "pass":
      return STATUS_GLYPHS.pass;
    case "warning":
      return STATUS_GLYPHS.warning;
    case "blocked":
      return STATUS_GLYPHS.blocked;
    case "skipped":
      return STATUS_GLYPHS.skipped;
  }
}

/**
 * Phase-kind glyphs, for the `PROGRESS.md` rows (the pipeline grid shows the
 * *status* of a phase, not its kind). `FIX_*` shares one glyph: those rows are
 * already distinguished by their `└─` indent.
 */
const PHASE_GLYPHS: Record<string, string> = {
  SPEC_AUDIT: "?",
  EXECUTE: ">",
  VALIDATE_STEP: "=",
  TEST_MODULE: "%",
  VERIFY: "V",
  SECURE_CHECK: "#",
  REVIEW: "@",
  DOC_SYNC: "~",
  COMMIT_ALL: ".",
  REPAIR_PROMOTION: "&",
};

/** The glyph for a phase name (any `FIX_*` or unknown phase gets the fix glyph). */
export function phaseGlyph(phase: string): string {
  return PHASE_GLYPHS[phase] ?? "+";
}
