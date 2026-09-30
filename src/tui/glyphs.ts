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
import type { Verdict } from "../engine/types";

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
  SECURE_CHECK: "#",
  REVIEW: "@",
  DOC_SYNC: "~",
  COMMIT_ALL: ".",
};

/** The glyph for a phase name (any `FIX_*` or unknown phase gets the fix glyph). */
export function phaseGlyph(phase: string): string {
  return PHASE_GLYPHS[phase] ?? "+";
}
