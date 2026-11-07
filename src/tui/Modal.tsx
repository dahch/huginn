/**
 * The one frame every interactive modal shares.
 *
 * The six console modals (`HelpModal`, `SkillsModal`, `AgentPickerModal`,
 * `ProfilePickerModal`, `ModelPickerModal`, `McpInspectorModal`) used to repeat
 * their own border, padding and footer arithmetic. Two copies of a frame drift,
 * and a footer that is not paid for is a row the terminal never gets back.
 * `Modal` is the only place that spends it:
 *
 *  - `tone="alert"` draws a `double` border (the decision surface, the one
 *    alarm); everything else is a `round` box.
 *  - The title is **one** clipped, bold row; the optional subtitle is one
 *    clipped, muted row.
 *  - The key footer (`hint`) is one muted, clipped row for every console modal,
 *    so the keys a surface accepts are always advertised in the same place.
 *  - `paddingX={1}`, `flexShrink={0}` and `overflow="hidden"` are fixed: the
 *    frame never guesses the caller's layout budget.
 *
 * **Key grammar (documented here, enforced by each modal's `useInput`):**
 *  - `Esc` closes/cancels every modal — without exception.
 *  - `q` closes only the two read-only browsers (`HelpModal`, `SkillsModal`).
 *  - `Enter` confirms/selects only in the three selectors (`AgentPickerModal`,
 *    `ProfilePickerModal`, `ModelPickerModal`). A browser may use it for its
 *    own action (executing a skill), never as a generic "confirm".
 *  - `↑`/`↓` move everywhere they moved before; `k`/`j` are accepted only where
 *    they already were, never introduced by the shared frame.
 *
 * `Modal` is deliberately presentational: it never calls `useInput`. Input
 * belongs to the surface that knows what a key means, and `modalContract.test.ts`
 * proves the contract from outside.
 */
import React, { type ReactNode } from "react";
import { Box, Text } from "ink";
import { THEME } from "./theme.js";

/** Which promise the frame makes about its border. */
export type ModalTone = "default" | "alert";

/** The shared key grammar, exported so docs/tests name the same literals. */
export const MODAL_KEY_CONTRACT = {
  close: "Esc",
  quickClose: ["HelpModal", "SkillsModal"],
  confirm: ["AgentPickerModal", "ProfilePickerModal", "ModelPickerModal"],
  move: "↑/↓",
  vimMove: "k/j",
  /**
   * The three selectors filter by typing into the list; none of them takes a
   * numbered choice any more (huginn init read numbers for both for a while,
   * and a catalog of thousands has no useful numbering).
   */
  filter: "type",
  /**
   * A list longer than its budget is windowed by visibleWindow
   * (src/tui/pickerList.ts): "end" alignment for the pickers, "center" for a
   * catalog. The frame stays out of that arithmetic on purpose.
   */
  listWindow: "visibleWindow",
} as const;

export interface ModalProps {
  /** One bold, clipped title row. */
  title: ReactNode;
  /** One muted, clipped context row below the title. */
  subtitle?: ReactNode;
  /** The key footer: one muted, clipped row for the console modals. */
  hint: ReactNode;
  /** `alert` is the double-border decision surface; default is `round`. */
  tone?: ModalTone;
  /** Border colour override (defaults to `warn` for alert, `accent` otherwise). */
  borderColor?: string;
  /** Exact outer height, for a caller that already planned its rows. */
  height?: number;
  /** Outer width; the console modals fill the frame. */
  width?: number | string;
  minHeight?: number;
  /** Vertical padding is caller-owned; horizontal padding is the frame's. */
  paddingY?: number;
  children?: ReactNode;
}

export function Modal({
  title,
  subtitle,
  hint,
  tone = "default",
  borderColor,
  height,
  width = "100%",
  minHeight,
  paddingY = 0,
  children,
}: ModalProps): React.ReactElement {
  const alert = tone === "alert";
  const color = borderColor ?? (alert ? THEME.warn : THEME.accent);

  return (
    <Box
      flexDirection="column"
      borderStyle={alert ? "double" : "round"}
      borderColor={color}
      paddingX={1}
      paddingY={paddingY}
      width={width}
      height={height}
      minHeight={minHeight}
      flexShrink={0}
      overflow="hidden"
    >
      <Text bold color={color} wrap="truncate">
        {title}
      </Text>
      {subtitle !== undefined && (
        <Text color={THEME.muted} wrap="truncate">
          {subtitle}
        </Text>
      )}
      {children}
      {typeof hint === "string" || typeof hint === "number" ? (
        <Text color={THEME.muted} wrap="truncate">
          {hint}
        </Text>
      ) : (
        // The decision modal's keys are already row specs with their own colours
        // (and can be more than one row). Everything else reaches the string
        // branch above, which is the one-row contract.
        <Box flexDirection="column" flexShrink={0}>
          {hint}
        </Box>
      )}
    </Box>
  );
}
