/**
 * Transcript search for the live console (REQ-72 / AC-72.3).
 *
 * The conversation card is a wrapped terminal transcript, so a hit has to be
 * identified by *message*, not by painted row: one message may occupy dozens of
 * rows, and the row offsets move whenever the card is resized. The dashboard maps
 * a message index to its first row separately (that mapping needs the current
 * layout); everything that can be decided from the messages alone lives here.
 */

/** The part of a chat message search reads. */
export interface SearchableMessage {
  role: string;
  text: string;
}

/**
 * Message indexes whose text contains `query`, case-insensitively.
 *
 * Pure: an empty or whitespace-only query matches nothing (an empty search is
 * not "every message"), and the result is in ascending message order so `↑`/`↓`
 * can walk it with a plain index.
 */
export function findMatches(
  messages: ReadonlyArray<SearchableMessage>,
  query: string,
): number[] {
  const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (needle.length === 0) return [];
  const matches: number[] = [];
  messages.forEach((message, index) => {
    const haystack = typeof message?.text === "string" ? message.text.toLowerCase() : "";
    if (haystack.includes(needle)) matches.push(index);
  });
  return matches;
}

/**
 * `"3/12"` for the third of twelve matches, or `""` when there is no match to
 * number. `index` is zero-based and clamped so a shrinking result set can never
 * print a position that does not exist.
 */
export function matchLabel(index: number, total: number): string {
  const count = Number.isFinite(total) ? Math.floor(total) : 0;
  if (count <= 0) return "";
  const position = Number.isFinite(index) ? Math.floor(index) : 0;
  const at = Math.min(Math.max(position, 0), count - 1);
  return `${at + 1}/${count}`;
}
