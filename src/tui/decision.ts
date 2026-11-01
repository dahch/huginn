/**
 * The decision modal's pure title formatter (REQ-68 / ADR-63).
 *
 * Kept out of `Dashboard.tsx` so the drift guard can assert the title of every
 * `DecisionKind` without importing the whole Ink dashboard and its engine
 * dependencies. The mapping is exhaustive: a new kind must be handled here or
 * TypeScript rejects it, so it can never silently inherit the gate wording.
 */
import type { DecisionRequest } from "../engine/types";
import { decisionGlyph } from "./glyphs.js";

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
