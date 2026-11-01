/**
 * The decision modal's React surface (REQ-68 / REQ-69 / ADR-63 / ADR-64).
 *
 * The policy — title, plain one-row specs, planner and height — lives in
 * `decision.ts`. This module only turns those specs into Ink nodes and owns the
 * body scroll state. It imports neither dashboard, so both pages depend on a
 * narrow module instead of on each other's whole engine graph.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import type { DecisionRequest } from "../engine/types";
import { THEME } from "./theme.js";
import {
  decisionBodyRowSpecs,
  decisionKeyRowSpecs,
  decisionTitle,
  planDecisionModal,
  type DecisionBodyRowSpec,
  type KeyHint,
} from "./decision.js";

/** One footer row: every key hint inline on that single terminal row. */
function keyHintsRow(hints: KeyHint[], rowKey: string): ReactNode {
  return (
    <Text key={rowKey} wrap="truncate">
      {hints.flatMap((hint, index) => [
        <Text key={`${rowKey}-k${index}`} bold color={THEME[hint.token]}>
          {hint.key}
        </Text>,
        <Text key={`${rowKey}-l${index}`}>{hint.label}</Text>,
      ])}
    </Text>
  );
}

/** One body row spec rendered as exactly one terminal row. */
function bodyRow(spec: DecisionBodyRowSpec): ReactNode {
  if (spec.kind === "text") {
    return (
      <Text key={spec.key} color={THEME[spec.color]} bold={spec.bold} wrap="truncate">
        {spec.text}
      </Text>
    );
  }
  return (
    <Text key={spec.key} wrap="truncate" color={spec.muted ? THEME.muted : undefined}>
      {spec.muted ? (
        `    (${spec.index + 1}) ${spec.label}`
      ) : (
        <>
          <Text bold color={THEME.ok}>{`  [${spec.index + 1}] `}</Text>
          <Text>{spec.label}</Text>
          {spec.description ? (
            <Text color={THEME.muted}> — {spec.description}</Text>
          ) : null}
        </>
      )}
    </Text>
  );
}

/**
 * The modal body as an array of **one entry per terminal row** (REQ-69).
 *
 * The modal (and `decisionModalHeight`) count, slice and window the body through
 * the shared specs, so this renderer and the reservation can never disagree.
 */
export function decisionBodyRows(req: DecisionRequest): ReactNode[] {
  return decisionBodyRowSpecs(req).map(bodyRow);
}

/**
 * The modal's key footer, one entry per terminal row. It is paid for **before**
 * any body row, so windowing the body can never hide what to press (REQ-69).
 */
export function decisionKeyRows(req: DecisionRequest): ReactNode[] {
  return decisionKeyRowSpecs(req).map((row) => keyHintsRow(row.hints, row.key));
}

/**
 * The decision modal renders its title through the pure formatter in
 * `src/tui/decision.ts` (REQ-68 / ADR-63).
 *
 * Row contract (REQ-69): the modal charges its rows before the composer, but it
 * can never charge more than the frame has. `maxRows` caps the whole box
 * (double border included), the body is windowed with `↑/↓` when it does not
 * fit, and the title and key footer are paid before any body row. It keeps
 * `borderStyle="double"` and `THEME.warn` on purpose: this is the only surface
 * with a double border, so the alert is unmistakable. Below `DECISION_MIN_ROWS`
 * it draws nothing rather than a title without its key footer.
 */
export function DecisionModal({ req, maxRows }: { req: DecisionRequest; maxRows?: number }) {
  const body = decisionBodyRows(req);
  const keys = decisionKeyRows(req);
  const [scroll, setScroll] = useState(0);
  const plan = planDecisionModal(body.length, keys.length, maxRows, scroll);
  const maxScroll = Math.max(0, body.length - plan.bodyCount);

  // A new request starts at the top of its own body.
  useEffect(() => {
    setScroll(0);
  }, [req.id]);

  useInput((_input, key) => {
    if (maxScroll === 0) return;
    if (key.upArrow) {
      setScroll((value) => Math.max(0, Math.min(value, maxScroll) - 1));
    } else if (key.downArrow) {
      setScroll((value) => Math.min(maxScroll, Math.min(value, maxScroll) + 1));
    }
  });

  if (plan.height === 0) return null;

  const visibleBody = body.slice(plan.bodyStart, plan.bodyStart + plan.bodyCount);
  const visibleKeys = keys.slice(0, plan.keyCount);
  return (
    <Box
      marginTop={0}
      borderStyle="double"
      borderColor={THEME.warn}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
      height={plan.height}
    >
      {plan.titleRows > 0 && (
        <Text bold color={THEME.warn} wrap="truncate">
          {decisionTitle(req)}
        </Text>
      )}
      {visibleBody}
      {plan.showIndicator && (
        <Text color={THEME.muted} wrap="truncate">
          {`… +${plan.hiddenBody} · ↑/↓`}
        </Text>
      )}
      {visibleKeys}
    </Box>
  );
}
