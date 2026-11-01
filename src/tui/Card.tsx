/**
 * The TUI's single chrome-cost table (REQ-70).
 *
 * Every framed surface used to repeat the same arithmetic — "two border rows,
 * two padding columns", "the title row", "the log card's three rows" — in the
 * dashboard that laid it out and in the card that rendered it. Two copies of a
 * cost drift apart, and a row budget that is one row short pushes the composer
 * off the screen.
 *
 * {@link CARD_CHROME} is now the only place those costs live. A card declares a
 * tone; the dashboards ask {@link cardChrome} what that tone really spends and
 * reserve exactly that much. The hierarchy is also a promise:
 *
 *  - `primary`   — the conversation: a `round` box, the surface the eye lands on.
 *  - `secondary` — the stream, the pipeline and the side panel: a quieter
 *                  `single` box.
 *  - `tertiary`  — the logs: no box at all, just a title row and a `│ ` rule
 *                  beside every entry.
 *
 * `Card` itself only draws chrome: a box, one clipped title row, and
 * `overflow="hidden"`. It never scrolls, measures children or decides a height —
 * the caller has already paid for the rows through `cardChrome(tone)`.
 */

import React, { type ReactNode } from "react";
import { Box, Text } from "ink";
import { THEME, type ThemeToken } from "./theme.js";

/** Which rung of the chrome hierarchy a surface occupies. */
export type CardTone = "primary" | "secondary" | "tertiary";

/** The exact cost of one tone's chrome, outside the card's body. */
export interface CardChrome {
  readonly tone: CardTone;
  /** Ink's border style, or `undefined` for the borderless tertiary card. */
  readonly borderStyle: "round" | "single" | undefined;
  /** Rows the border spends (top + bottom). */
  readonly borderRows: number;
  /** The title row above the body. */
  readonly titleRows: number;
  /** Every row the chrome spends outside the body. */
  readonly rows: number;
  /** Every column the chrome spends outside the body (border + padding, or `│ `). */
  readonly columns: number;
}

/**
 * The one table. `primary` and `secondary` spend two border rows and four
 * columns (a border plus `paddingX={1}` each side); `tertiary` spends one title
 * row and two columns for the `│ ` rule, with no box at all.
 */
export const CARD_CHROME: Readonly<Record<CardTone, CardChrome>> = {
  primary: {
    tone: "primary",
    borderStyle: "round",
    borderRows: 2,
    titleRows: 1,
    rows: 3,
    columns: 4,
  },
  secondary: {
    tone: "secondary",
    borderStyle: "single",
    borderRows: 2,
    titleRows: 1,
    rows: 3,
    columns: 4,
  },
  tertiary: {
    tone: "tertiary",
    borderStyle: undefined,
    borderRows: 0,
    titleRows: 1,
    rows: 1,
    columns: 2,
  },
};

/** The exact chrome cost of a tone. */
export function cardChrome(tone: CardTone): CardChrome {
  return CARD_CHROME[tone];
}

/**
 * The border colour the hierarchy promises:
 *  - a focused card always uses `borderFocus`;
 *  - an unfocused `primary` keeps its accent (`accentToken` names the stage's
 *    token when there is one) so the conversation stays the loudest surface;
 *  - an unfocused `secondary` steps back to the quiet `border`.
 */
function borderColorFor(
  tone: CardTone,
  focused: boolean,
  accentToken: ThemeToken,
): string | undefined {
  if (focused) return THEME.borderFocus;
  if (tone === "primary") return THEME[accentToken];
  if (tone === "secondary") return THEME.border;
  return undefined;
}

/**
 * One TUI card: chrome, one clipped title row and a clipped body.
 *
 * `height`/`width`/`minHeight` are the caller's — the caller already computed
 * them from {@link cardChrome} — so this component never has to guess how many
 * rows or columns its body gets.
 */
export function Card({
  tone,
  title,
  titleRight,
  focused = false,
  height,
  width,
  minHeight,
  accentToken = "accent",
  children,
}: {
  tone: CardTone;
  /** The title text; omit it for a card that carries its title in the body. */
  title?: ReactNode;
  /** The title's right-hand cell (scroll position, byte count, spinner…). */
  titleRight?: ReactNode;
  /** A focused card paints `THEME.borderFocus`, whatever its tone. */
  focused?: boolean;
  height?: number;
  width?: number | string;
  minHeight?: number;
  /** The unfocused `primary` border token (defaults to `accent`). */
  accentToken?: ThemeToken;
  children?: ReactNode;
}): React.ReactElement {
  const chrome = cardChrome(tone);
  const borderColor = borderColorFor(tone, focused, accentToken);
  const titleColor = focused
    ? THEME.borderFocus
    : tone === "tertiary"
      ? THEME.muted
      : THEME[accentToken];

  return (
    <Box
      borderStyle={chrome.borderStyle}
      borderColor={chrome.borderStyle ? borderColor : undefined}
      flexDirection="column"
      paddingX={chrome.borderStyle ? 1 : 0}
      height={height}
      width={width}
      minHeight={minHeight}
      overflow="hidden"
    >
      {title !== undefined && (
        // Exactly one clipped row: a wrapped title would steal a row the caller
        // never reserved. Both cells truncate for the same reason.
        <Box justifyContent="space-between" height={chrome.titleRows} overflow="hidden">
          <Text bold color={titleColor} wrap="truncate">
            {title}
          </Text>
          {titleRight !== undefined && (
            <Box flexShrink={1} overflow="hidden">
              {titleRight}
            </Box>
          )}
        </Box>
      )}
      {children}
    </Box>
  );
}
