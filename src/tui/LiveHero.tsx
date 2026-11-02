/**
 * The live view's empty-state hero (Phase 7B / REQ-12).
 *
 * An empty conversation used to show a five-line hint block inside a card that
 * was otherwise blank — the "dead console" complaint behind REQ-12. The hero
 * replaces it with the raven brand, the first-run guidance and (when the card is
 * tall enough) one discreet tip box, in the raven's own voice.
 *
 * It renders *inside* the conversation card, so it costs the frame no rows at
 * all: every row it draws is a card body row the layout already paid for, and it
 * is sliced to the rows that body really has, so a short terminal degrades the
 * hero instead of overflowing (AC-31.3, REV-6001).
 *
 * The brand art is the same one the header uses (`buildRavenArtRows`), so the
 * two cannot drift (REQ-29), and the guidance copy is `EMPTY_CHAT_HINTS`, so the
 * hero cannot advertise a command the console does not have.
 */

import React from "react";
import { Box, Text } from "ink";
import {
  COMPACT_BRAND_WIDTH,
  RAVEN_ART_ROWS,
  RAVEN_ART_WIDTH,
  WORDMARK_WIDTH,
  buildRavenArtRows,
  type RavenArtRow,
} from "./RavenHeader.js";
import type { RavenMood } from "../brand.js";
import { EMPTY_CHAT_HINTS, emptyChatHints } from "./feedback.js";
import { THEME, ravenMoodToken } from "./theme.js";

/** Rows the one-line brand fallback spends. */
export const HERO_BRAND_ROWS = 1;
/** The brand text when even the wordmark does not fit the card. */
export const HERO_BRAND_TEXT = "HUGINN LIVE";
/** Guidance rows the hero insists on before it spends rows on art at all. */
export const HERO_MIN_COPY_ROWS = 2;
/** Rows the tip box spends (`TIP …` plus its rounded border). */
export const HERO_TIP_ROWS = 3;
/** Blank rows between the guidance and the tip box. */
export const HERO_TIP_GAP_ROWS = 1;
/** The tip box never grows past this many columns. */
export const HERO_TIP_WIDTH = 52;
/** Below this width a tip box is not worth its rows (and must not be 0 columns). */
export const HERO_TIP_MIN_COLUMNS = 20;
/** The tip box's own label. */
export const HERO_TIP_LABEL = "TIP";
/** Columns the guidance is indented by, so it reads as copy under the brand. */
export const HERO_COPY_INDENT = 2;

export type HeroVariant = "full" | "wordmark" | "compact" | "text";

export interface HeroRequest {
  /** Body rows the conversation card has for the hero. */
  rows: number;
  /** Columns available inside the card (border and padding already removed). */
  columns: number;
  /** The stage's tip; `""` hides the tip box. */
  tip?: string;
  /** The raven's mood; only the beak glyph changes (defaults to `idle`). */
  mood?: RavenMood;
  /** The thinking animation's closed-eye frame (ignored for other moods). */
  blink?: boolean;
}

export interface HeroPlan {
  /** Which brand treatment fits (the header's own degradation order). */
  variant: HeroVariant;
  /** The art rows to draw (`[]` for the one-line brand fallback). */
  artRows: RavenArtRow[];
  /** The guidance rows that fit, first-run copy in order. */
  copyRows: string[];
  /** `true` when the tip box fits under the guidance. */
  showTip: boolean;
  /** Columns the tip box occupies. */
  tipWidth: number;
  /** Rows the hero will draw — never more than `rows`, `0` when it cannot draw. */
  rows: number;
}

/**
 * Lay the hero out for a card body of `rows` × `columns`.
 *
 * Degradation is width-first and matches `ravenHeaderPlan` exactly — mark +
 * wordmark → wordmark only → the one-row `<(o  HUGINN` → one-line brand — and
 * then row-first: a five-row art block only earns its rows when the guidance
 * keeps {@link HERO_MIN_COPY_ROWS} of its own underneath, so a short card
 * falls back to the compact row instead of losing its copy. The tip box is the
 * *last* claim, shown only when every guidance row still fits above it. Nothing
 * is ever fabricated to fill a row: a hero with one row of room shows the brand
 * and nothing else.
 *
 * Pure, so the component and the layout tests share one arithmetic.
 */
export function heroPlan(request: HeroRequest): HeroPlan {
  const rows = Math.max(0, Math.floor(request.rows));
  const columns = Math.max(0, Math.floor(request.columns));
  const tip = (request.tip ?? "").trim();
  const mood = request.mood ?? "idle";
  const blink = request.blink === true;

  let variant: HeroVariant =
    columns >= RAVEN_ART_WIDTH
      ? "full"
      : columns >= WORDMARK_WIDTH
        ? "wordmark"
        : columns >= COMPACT_BRAND_WIDTH
          ? "compact"
          : "text";
  // A five-row block that would starve the first-run guidance steps down to the
  // same one-row rung the header uses, never straight to plain text. Requiring
  // the *whole* hint list (not just the minimum) keeps an 80×24 frame, whose
  // header now pays for its art, from showing a bird at the cost of its advice.
  const fullCopyRows = Math.max(HERO_MIN_COPY_ROWS, EMPTY_CHAT_HINTS.length);
  if ((variant === "full" || variant === "wordmark") && rows < RAVEN_ART_ROWS + fullCopyRows) {
    variant = columns >= COMPACT_BRAND_WIDTH ? "compact" : "text";
  }

  const used = Math.min(
    rows,
    variant === "text" ? HERO_BRAND_ROWS : variant === "compact" ? 1 : RAVEN_ART_ROWS,
  );
  const copyBudget = rows - used;
  const tipBudget = HERO_TIP_GAP_ROWS + HERO_TIP_ROWS;
  const showTip =
    tip.length > 0 &&
    columns >= HERO_TIP_MIN_COLUMNS &&
    copyBudget >= EMPTY_CHAT_HINTS.length + tipBudget;
  const copyRows = emptyChatHints(Math.max(0, copyBudget - (showTip ? tipBudget : 0)));

  return {
    variant,
    // A branch that did not fit is never drawn: the wordmark alone reads better
    // than a mark squeezed against it (mirrors `ravenHeaderPlan`).
    artRows: variant === "text" ? [] : buildRavenArtRows(variant, mood, blink),
    copyRows,
    showTip,
    tipWidth: Math.min(columns, HERO_TIP_WIDTH),
    rows: used + copyRows.length + (showTip ? tipBudget : 0),
  };
}

/**
 * The empty-state hero. Renders nothing when the card has no body rows at all,
 * and otherwise exactly `plan.rows` rows, each clipped to the card's width.
 */
export function LiveHero({
  rows,
  columns,
  tip = "",
  mood = "idle",
  blink = false,
}: {
  rows: number;
  columns: number;
  tip?: string;
  mood?: RavenMood;
  blink?: boolean;
}): React.ReactElement | null {
  const plan = heroPlan({ rows, columns, tip, mood, blink });
  if (plan.rows === 0) return null;
  const markColor = THEME[ravenMoodToken(mood)];

  return (
    <Box flexDirection="column" overflow="hidden">
      {plan.artRows.length > 0 ? (
        plan.artRows.map((art, index) => (
          <Box key={`hero-art-${index}`} height={1} overflow="hidden" flexDirection="row">
            {art.mark.length > 0 && (
              <Text bold color={markColor} wrap="truncate">
                {art.mark}
              </Text>
            )}
            <Text bold color={THEME.brand} wrap="truncate">
              {art.wordmark}
            </Text>
          </Box>
        ))
      ) : (
        <Box height={1} overflow="hidden">
          <Text bold color={THEME.brand} wrap="truncate">
            {HERO_BRAND_TEXT}
          </Text>
        </Box>
      )}

      {plan.copyRows.map((line, index) => (
        <Box key={`hero-copy-${index}`} height={1} overflow="hidden" paddingLeft={HERO_COPY_INDENT}>
          <Text color={index === 0 ? THEME.accentStrong : THEME.muted} wrap="truncate">
            {line}
          </Text>
        </Box>
      ))}

      {plan.showTip && tip.trim().length > 0 && (
        <Box
          marginTop={HERO_TIP_GAP_ROWS}
          borderStyle="round"
          borderColor={THEME.border}
          paddingX={1}
          width={plan.tipWidth}
          height={HERO_TIP_ROWS}
          flexShrink={0}
          overflow="hidden"
        >
          <Text wrap="truncate">
            <Text bold color={THEME.accent}>
              {`${HERO_TIP_LABEL}  `}
            </Text>
            <Text color={THEME.muted}>{tip.trim()}</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
