/**
 * The footer's pure hint policy (H-13 / REQ-70).
 *
 * The live console used to paint one fixed sentence no matter where focus was:
 * it advertised History and Send while a card owned the keys, and it truncated
 * exactly the surface-specific keys first. The run dashboard repeated its own
 * copy of the same chain. {@link footerHints} is now the single source of truth:
 * it returns the keys of **the focused surface** on the left and keeps `usage`
 * on the right. The live stage lives in the header badge (ADR-73), so the footer
 * never repeats it.
 *
 * It is a pure function (no JSX, no hooks): both dashboards call it, the tests
 * call it, and `columns` lets the caller clamp the result through
 * {@link headerValue} so the footer can never claim a column the terminal does
 * not have. Its only import is that shared clamp.
 */
import { headerValue } from "./RavenHeader.js";

/** Where the keys go: the live surfaces, or the run dashboard's own footer. */
export type FooterFocus = "composer" | "chat" | "stream" | "run";

/** The card a `z` press maximized, or `null` for the split layout. */
export type FooterMaximized = "chat" | "stream" | null;

export interface FooterHintInput {
  /** The surface that owns the keyboard right now. */
  focus: FooterFocus;
  /** The inline command palette owns the keys while it is open. */
  paletteOpen?: boolean;
  /** A turn is in flight: `Esc` is the abort key. */
  busy?: boolean;
  /** The card `z` maximized, so the footer offers `[z] Restore`. */
  maximized?: FooterMaximized;
  /** Token usage text, kept on the right exactly as before. */
  usage?: string;
  /** Entries the collapsed log tail would bring back (`[L] logs · N`). */
  hiddenLogs?: number;
  /** Transcript search is open (its own footer replaces the focus keys). */
  search?: boolean;
  /** Hits the current search found. */
  searchMatches?: number;
  /** `"3/12"` from `matchLabel`, when there is a hit to number. */
  searchMatchText?: string;
  /** Run dashboard: `Space` resumes instead of pausing. */
  paused?: boolean;
  /** Run dashboard: the verbose state the `v` key toggles. */
  verbose?: boolean;
  /** Run dashboard: a decision modal owns the keyboard. */
  hasDecision?: boolean;
  /** Total columns available; when given, the result is clamped to fit. */
  columns?: number;
}

export interface FooterHints {
  /** The focused surface's keys. */
  left: string;
  /** `usage` (or the run dashboard's decision notice). */
  right: string;
}

/** The palette's own keys, unchanged from the overlay that opens it. */
export const PALETTE_FOOTER_HINT =
  "[↑/↓] Select · [Tab] Accept · [Enter] Run · [Esc] Dismiss";

function logsPrefix(hiddenLogs: number | undefined): string {
  return hiddenLogs && hiddenLogs > 0 ? `[L] logs · ${hiddenLogs} (card focus) · ` : "";
}

function searchHint(input: FooterHintInput): string {
  const matches = Math.max(0, Math.floor(input.searchMatches ?? 0));
  const label = input.searchMatchText ? ` ${input.searchMatchText}` : "";
  return `find ❯ [↑/↓] ${matches} match${matches === 1 ? "" : "es"} · [Enter] Jump${label} · [Esc] Cancel`;
}

function runHint(input: FooterHintInput): string {
  return `[Space] ${input.paused ? "Resume" : "Pause"} · [q/Esc] Abort · [v] Verbose ${
    input.verbose ? "(ON)" : "(OFF)"
  } · [PageUp/Down, ↑/↓] Scroll`;
}

function leftHint(input: FooterHintInput): string {
  if (input.paletteOpen) return PALETTE_FOOTER_HINT;
  if (input.search) return searchHint(input);
  if (input.focus === "run") return runHint(input);

  const logs = logsPrefix(input.hiddenLogs);
  const abort = input.busy ? " · [Esc] Abort" : "";
  if (input.focus === "composer") {
    return `${logs}[Tab] Focus: input · [↑/↓] History · [PgUp/Dn] Scroll · [Enter] Send${abort} · / commands`;
  }

  const focus = input.focus === "chat" ? "chat" : "stream";
  const restore = input.maximized === focus ? "Restore" : "Maximize";
  // The conversation can be read back (`y` copies); the agent stream has no
  // message to copy, so it never advertises a key that would do nothing.
  const copy = focus === "chat" ? " · [y] Copy" : "";
  return `${logs}[Tab] Focus: ${focus} · [↑/↓] Scroll · [Ctrl+F] Search${copy} · [g/G] Jump · [PgUp/Dn] Scroll · [z] ${restore}${abort}`;
}

function rightHint(input: FooterHintInput): string {
  if (input.focus === "run") {
    const notice = input.hasDecision ? "Interactive decision input active" : "";
    return [input.usage, notice].filter((part) => Boolean(part)).join(" · ");
  }
  return input.usage ?? "";
}

/**
 * The footer's two cells for the current surface.
 *
 * With `columns`, the right cell is clamped first (the usage figure must survive)
 * and the left cell gets whatever remains, through `headerValue`; the returned
 * strings therefore never exceed the terminal width together.
 */
export function footerHints(input: FooterHintInput): FooterHints {
  const right = rightHint(input);
  const left = leftHint(input);
  const columns = input.columns;
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) {
    return { left, right };
  }

  const safeRight = headerValue(right, columns);
  const separator = safeRight.length > 0 ? 1 : 0;
  const leftBudget = Math.max(0, Math.floor(columns) - safeRight.length - separator);
  return { left: headerValue(left, leftBudget), right: safeRight };
}
