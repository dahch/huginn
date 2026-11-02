/**
 * Shared ASCII brand assets (REQ-29 / ADR-29).
 *
 * Both surfaces of Huginn use the same art: the CLI prints the wordmark from
 * `printBanner` (`src/banner.ts`) and the TUI headers render the wordmark next
 * to the raven mark (`src/tui/RavenHeader.tsx`). Keeping the art in this
 * dependency-free module means the CLI and the Ink render loop share one
 * identity without dragging `chalk`/`package.json` into the TUI bundle.
 *
 * Every glyph is printable ASCII (`0x20`–`0x7e`): no control characters and no
 * emoji, so the art is safe to emit straight into the alternate screen buffer
 * and cannot inject terminal sequences (SEC-001). Leading spaces are
 * significant — they carry the wordmark's slant — and callers must never trim
 * them.
 */

/** The five-row `HUGINN` wordmark (FIGURE "slant" letterforms). */
export const HUGINN_WORDMARK: readonly string[] = [
  "    __  ____  _____________   ___   __",
  "   / / / / / / / ____/  _/ | / / | / /",
  "  / /_/ / / / / / __ / //  |/ /  |/ / ",
  " / __  / /_/ / /_/ // // /|  / /|  /  ",
  "/_/ /_/\\____/\\____/___/_/ |_/_/ |_/   ",
];

/**
 * The raven mark: a perched bird in profile with a heavy corvid beak, a
 * rounded breast and a wedge tail. Three rows tall so the header stays compact.
 */
export const RAVEN_MARK: readonly string[] = [
  "    ___",
  "  <(o  \\___",
  "   \\__/   \\_\\",
];

/** The three moods the raven can express (REQ-73 / ADR-69). */
export type RavenMood = "idle" | "thinking" | "sleeping";

/** Options for {@link ravenMark}. */
export interface RavenMarkOptions {
  /**
   * The blink phase of the thinking animation. It only has an effect for
   * `thinking`; every other mood ignores it.
   */
  blink?: boolean;
}

/**
 * The mood the raven should show, with a fixed precedence: an in-flight turn
 * (`busy`) always wins, then a degraded MCP connection (`degraded`), otherwise
 * the raven is idle. Pure and exported so both dashboards resolve the same way.
 */
export function ravenMood({ busy = false, degraded = false }: {
  busy?: boolean;
  degraded?: boolean;
}): RavenMood {
  if (busy) return "thinking";
  if (degraded) return "sleeping";
  return "idle";
}

/** Ticks of the shared 80 ms spinner that make up one ~500 ms blink phase. */
export const RAVEN_BLINK_TICKS = 6;

/**
 * Whether the raven's eyes are closed on this spinner tick. Derived from the
 * existing `spinnerIndex`, so the animation adds no timer of its own.
 */
export function ravenBlink(spinnerIndex: number): boolean {
  const frame = Number.isFinite(spinnerIndex) ? Math.max(0, Math.floor(spinnerIndex)) : 0;
  return Math.floor(frame / RAVEN_BLINK_TICKS) % 2 === 1;
}

/**
 * The raven's mood variants.
 *
 * The mood is carried by the raven's beak/mouth glyph (`o`): `thinking` opens it
 * into an `O` and `sleeping` closes it into a `-`. Everything else — the same
 * three rows, the same columns, the same leading spaces — is byte-for-byte
 * identical to {@link RAVEN_MARK}, so switching mood costs the layout table
 * exactly zero rows and zero columns and no caller has to re-measure anything.
 */
export const RAVEN_MOODS: Readonly<Record<RavenMood, readonly string[]>> = {
  idle: RAVEN_MARK,
  thinking: [
    "    ___",
    "  <(O  \\___",
    "   \\__/   \\_\\",
  ],
  sleeping: [
    "    ___",
    "  <(-  \\___",
    "   \\__/   \\_\\",
  ],
};

/**
 * The raven mark for a mood, in the exact same grid as {@link RAVEN_MARK}.
 *
 * `blink` is the thinking animation's closed-eye frame: it drops back to the
 * `idle` mark (the open `o` eye), so the cycle alternates `<(O` ↔ `<(o` without
 * inventing a glyph or changing the grid. That closed-eye frame is what a user
 * who is not looking at the animation sees — a paused recording, a dropped
 * frame or a screen reader gets a complete, legible raven rather than a blank
 * cell — and it is deliberately indistinguishable from `idle` on its own: only
 * the persistent `thinking` colour says the turn is still in flight.
 */
export function ravenMark(
  mood: RavenMood,
  options: RavenMarkOptions = {},
): readonly string[] {
  if (mood === "thinking" && options.blink === true) return RAVEN_MOODS.idle;
  return RAVEN_MOODS[mood];
}

/**
 * The two ravens perched side by side — Huginn (thought) and Muninn (memory) —
 * for the run panel's idle state (REQ-51 / AC-51.2). Printable ASCII only, like
 * every other brand asset, so it is safe to write straight into the alternate
 * screen buffer.
 */
export const TWO_RAVENS: readonly string[] = [
  "    ___            ___",
  "  <(o  \\___      <(o  \\___",
  "   \\__/   \\_\\      \\__/   \\_\\",
];

/** Width of the widest row in an art block (rows are left-aligned, not padded). */
export function artWidth(rows: readonly string[]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}
