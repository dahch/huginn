/**
 * The live view's side panel (Phase 7B / REQ-12).
 *
 * A compact, opencode-style column beside the conversation that answers "what am
 * I actually running?" at a glance: the active agent and its models, the MCP
 * enumeration attributed to that agent, the git branch and its state, the
 * worktree sandbox, Muninn's counts and the size of the conversation — plus one
 * stage-appropriate tip.
 *
 * Its data rows are grouped into `SESSION`, `REPO` and `MEMORY` sections, and the
 * tip is anchored to the bottom of the box instead of floating under the last
 * row. A section with no data is not drawn at all.
 *
 * Three rules shape it:
 *  - **Wide terminals only.** Below {@link SIDE_PANEL_MIN_COLUMNS} columns (or
 *    when the frame has no rows to spare) the panel does not render at all and
 *    the layout is exactly what it was before: the header already carries the
 *    same facts in one line.
 *  - **It never touches the frame budget.** The panel lives *inside* the region
 *    the conversation and the stream already own, so it can never push the
 *    composer, the palette or the footer off the screen — the very thing the row
 *    budget in `LiveDashboard` exists to prevent (REV-6001).
 *  - **No fabricated data** (NFR-10). Every line comes from `getDiagnostics()`
 *    or from state the dashboard already holds; a section whose data is missing
 *    is simply not rendered, and every dynamic value is sanitized and clamped to
 *    the columns the box really has, so no line can widen past the terminal.
 */

import React from "react";
import { Box, Text } from "ink";
import { headerValue } from "./RavenHeader.js";
import { Card, cardChrome } from "./Card.js";
import { THEME, type ThemeToken } from "./theme.js";
import {
  contextStat,
  gitStat,
  memoryStat,
  sandboxLabel,
  type ContextStat,
  type GitSummary,
  type MemorySummary,
} from "./sessionContext.js";

/** Columns from which the panel is shown — narrower terminals keep the old layout. */
export const SIDE_PANEL_MIN_COLUMNS = 100;
/** Columns the panel occupies, border included. */
export const SIDE_PANEL_WIDTH = 36;
/** Blank columns between the cards column and the panel. */
export const SIDE_PANEL_GAP_COLUMNS = 1;
/** Columns the conversation must keep beside the panel, or the panel stands down. */
export const SIDE_PANEL_MIN_CARD_COLUMNS = 44;
/** Rows the panel needs before it is worth showing (border + a few lines). */
export const SIDE_PANEL_MIN_ROWS = 8;
/** Columns the panel's card chrome spends (border + `paddingX={1}`, each side). */
export const SIDE_PANEL_BORDER_COLUMNS = cardChrome("secondary").columns;
/** Rows the panel's card border spends (top + bottom). */
export const SIDE_PANEL_BORDER_ROWS = cardChrome("secondary").borderRows;
/** Columns a row's label claims, so every value starts at the same one. */
export const PANEL_LABEL_COLUMNS = 9;
/** The panel's own title row. */
export const PANEL_TITLE = "LIVE CONTEXT";
/** The tip row's prefix (a tip is a reminder, never a state claim). */
export const PANEL_TIP_PREFIX = "TIP  ";

/** Everything the panel renders. Missing fields drop their row, never print a placeholder. */
export interface PanelData {
  /** The live stage's label (`REFINE`, `DRAFT`…). */
  stageLabel: string;
  /** The theme token that label is painted with. */
  stageToken: ThemeToken;
  /** `true` while a turn is in flight — the spinner joins the stage row. */
  busy: boolean;
  /** The animated spinner frame shown while {@link busy}. */
  spinner: string;
  /** Active agent/runtime name. */
  agentName: string;
  /** The attributed MCP badge text (`mcpBadgeText(formatMcpBadge(...))`). */
  mcpText: string;
  /** The badge's severity token (`mcpStatusToken`). */
  mcpToken: ThemeToken;
  git?: GitSummary | null;
  memory?: MemorySummary | null;
  context?: ContextStat | null;
  /** One useful reminder for the current stage. */
  tip?: string;
}

/** One rendered panel row. */
export type PanelLine =
  | { kind: "title"; text: string }
  | { kind: "section"; label: string }
  | { kind: "row"; label: string; value: string; token: ThemeToken }
  | { kind: "badge"; text: string; token: ThemeToken }
  | { kind: "divider" }
  | { kind: "note"; text: string };

/** The geometry the live view's row needs to lay the panel out. */
export interface SidePanelPlan {
  /** `false` below the width threshold, when short of rows, or when the cards would starve. */
  visible: boolean;
  /** Columns the panel occupies (0 when hidden). */
  width: number;
  /** Columns a panel row may fill — the value budget of every line. */
  contentWidth: number;
  /** Columns the cards column keeps; the whole content width when the panel is hidden. */
  cardsWidth: number;
  /** Rows the panel occupies (0 when hidden). */
  height: number;
  columns: number;
  availableHeight: number;
}

export interface SidePanelRequest {
  /** Terminal columns. */
  columns: number;
  /** Rows the main region (the cards) has — the panel's height when it shows. */
  availableHeight: number;
  /** Columns the caller's own container already spends (its `paddingX`). */
  inset?: number;
}

/**
 * A sanitized non-negative integer. `NaN`/`Infinity` columns would otherwise
 * turn `cardsWidth` into `NaN` and hand the caller a width Ink cannot lay out,
 * so a non-finite frame is treated as a zero-column one.
 */
function wholeColumns(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/**
 * Decide whether the panel renders, and how wide the two columns beside each
 * other are. Width-first, exactly like the brand header: below the threshold the
 * layout is untouched, and the panel additionally stands down when the frame is
 * too short or when showing it would leave the conversation less than
 * {@link SIDE_PANEL_MIN_CARD_COLUMNS} columns (AC-29.3, REV-6001).
 */
export function sidePanelPlan(request: SidePanelRequest): SidePanelPlan {
  const columns = wholeColumns(request.columns, 0);
  const availableHeight = wholeColumns(request.availableHeight, 0);
  const inset = wholeColumns(request.inset, 2);
  const contentColumns = Math.max(0, columns - inset);
  const cardsWidth = Math.max(0, contentColumns - SIDE_PANEL_WIDTH - SIDE_PANEL_GAP_COLUMNS);
  const visible =
    columns >= SIDE_PANEL_MIN_COLUMNS &&
    availableHeight >= SIDE_PANEL_MIN_ROWS &&
    cardsWidth >= SIDE_PANEL_MIN_CARD_COLUMNS;

  return {
    visible,
    width: visible ? SIDE_PANEL_WIDTH : 0,
    contentWidth: visible ? SIDE_PANEL_WIDTH - SIDE_PANEL_BORDER_COLUMNS : 0,
    cardsWidth: visible ? cardsWidth : contentColumns,
    height: visible ? availableHeight : 0,
    columns,
    availableHeight,
  };
}

/**
 * The panel's lines, in priority order: the title, then the `SESSION` rows
 * (stage, agent, conversation size), the attributed MCP badge, the `REPO` rows
 * (git state and its sandbox), the `MEMORY` rows (Muninn counts), and finally
 * the tip. A section header is emitted only when the section has at least one
 * row, so an absent section never leaves a label with nothing under it.
 * Everything is clipped to `contentWidth`, so a long model id or a hostile
 * branch name can neither widen the box nor wrap into a row the layout did not
 * reserve.
 */
export function panelLines(data: PanelData, contentWidth: number): PanelLine[] {
  const width = Math.max(0, Math.floor(contentWidth));
  const valueWidth = Math.max(0, width - PANEL_LABEL_COLUMNS);
  const row = (label: string, value: string, token: ThemeToken): PanelLine => ({
    kind: "row",
    label,
    value: headerValue(value, valueWidth),
    token,
  });
  const section = (label: string, rows: PanelLine[]): PanelLine[] =>
    rows.length > 0 ? [{ kind: "section", label }, ...rows] : [];

  const session: PanelLine[] = [
    row("stage", `${data.stageLabel}${data.busy ? ` ${data.spinner}` : ""}`, data.stageToken),
  ];
  if (data.agentName) session.push(row("agent", data.agentName, "warn"));
  // The models live in the header only: repeating them here cost two rows and
  // told the same story twice.
  if (data.mcpText) {
    session.push({ kind: "badge", text: headerValue(data.mcpText, width), token: data.mcpToken });
  }
  const context = contextStat(data.context);
  if (context) session.push(row("ctx", context, "muted"));

  const repo: PanelLine[] = [];
  const git = gitStat(data.git);
  if (git) {
    repo.push(row("git", git, data.git!.clean ? "ok" : "danger"));
    const sandbox = sandboxLabel(data.git);
    if (sandbox) repo.push(row("sandbox", sandbox, "info"));
  }

  const memory: PanelLine[] = [];
  const memoryText = memoryStat(data.memory);
  if (memoryText) {
    memory.push(row("muninn", memoryText, data.memory?.error ? "danger" : "muted"));
  }

  const lines: PanelLine[] = [
    { kind: "title", text: PANEL_TITLE },
    ...section("SESSION", session),
    ...section("REPO", repo),
    ...section("MEMORY", memory),
  ];
  if (data.tip) {
    lines.push({ kind: "divider" });
    lines.push({ kind: "note", text: headerValue(data.tip, width - PANEL_TIP_PREFIX.length) });
  }
  return lines;
}

/**
 * The lines that fit in `maxRows`. A dangling divider is dropped, and so is a
 * section header left with no row under it: either would read as a bug rather
 * than as a separator or a heading.
 */
export function slicePanelLines(lines: PanelLine[], maxRows: number): PanelLine[] {
  const budget = Math.max(0, Math.floor(maxRows));
  const visible = lines.slice(0, budget);
  while (visible.length > 0) {
    const last = visible[visible.length - 1]!;
    if (last.kind === "divider" || last.kind === "section") visible.pop();
    else break;
  }
  return visible;
}

/** One panel row, clipped to the box's content width. */
function PanelLineView({ line, width }: { line: PanelLine; width: number }): React.ReactElement {
  switch (line.kind) {
    case "title":
      return (
        <Text bold color={THEME.accentStrong} wrap="truncate">
          {line.text}
        </Text>
      );
    case "section":
      return (
        <Box height={1} overflow="hidden">
          <Text color={THEME.muted} wrap="truncate">
            {line.label}
          </Text>
        </Box>
      );
    case "divider":
      return (
        <Text color={THEME.border} wrap="truncate">
          {"─".repeat(Math.max(0, width))}
        </Text>
      );
    case "badge":
      return (
        <Text color={THEME[line.token]} wrap="truncate">
          {line.text}
        </Text>
      );
    case "note":
      return (
        <Box height={1} overflow="hidden" flexDirection="row">
          <Text bold color={THEME.accent}>
            {PANEL_TIP_PREFIX}
          </Text>
          <Text color={THEME.muted} wrap="truncate">
            {line.text}
          </Text>
        </Box>
      );
    default:
      return (
        <Box height={1} overflow="hidden" flexDirection="row">
          <Text color={THEME.muted}>
            {headerValue(line.label, PANEL_LABEL_COLUMNS).padEnd(PANEL_LABEL_COLUMNS)}
          </Text>
          <Text color={THEME[line.token]} wrap="truncate">
            {line.value}
          </Text>
        </Box>
      );
  }
}

/**
 * The side panel itself. It renders exactly `plan.height` rows and never a line
 * wider than `plan.width`, so the caller's row can hand it the columns the cards
 * do not need without any further arithmetic.
 */
export function InfoPanel({
  plan,
  data,
}: {
  plan: SidePanelPlan;
  data: PanelData;
}): React.ReactElement | null {
  if (!plan.visible) return null;
  const lines = slicePanelLines(
    panelLines(data, plan.contentWidth),
    Math.max(0, plan.height - SIDE_PANEL_BORDER_ROWS),
  );
  // The tip block is the divider plus the note. A flexible spacer before it is
  // what anchors it to the bottom of the box; it is only claimed when the tip
  // actually survived the row budget (otherwise the spacer would push nothing
  // and the panel would lose the row it could have shown).
  const noteIndex = lines.findIndex((line) => line.kind === "note");
  const tipStart = noteIndex > 0 && lines[noteIndex - 1]?.kind === "divider" ? noteIndex - 1 : noteIndex;
  const dataLines = tipStart >= 0 ? lines.slice(0, tipStart) : lines;
  const tipLines = tipStart >= 0 ? lines.slice(tipStart) : [];
  return (
    <Box marginLeft={SIDE_PANEL_GAP_COLUMNS} flexShrink={0}>
      <Card tone="secondary" width={plan.width} height={plan.height}>
        {dataLines.map((line, index) => (
          <PanelLineView key={`panel-${index}`} line={line} width={plan.contentWidth} />
        ))}
        {tipLines.length > 0 && <Box flexGrow={1} />}
        {tipLines.map((line, index) => (
          <PanelLineView key={`panel-tip-${index}`} line={line} width={plan.contentWidth} />
        ))}
      </Card>
    </Box>
  );
}
