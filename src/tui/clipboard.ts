/**
 * OSC 52 clipboard support for the live console (REQ-72 / AC-72.5).
 *
 * A terminal escape sequence is the only clipboard channel a TUI has without a
 * native dependency: `\x1b]52;c;<base64>\x1b\\` asks the terminal itself to put
 * the payload on the system clipboard. Support varies — tmux needs
 * `set-clipboard on`, some terminals ignore it outright — so this module only
 * *sends* the sequence and the caller reports what it used instead of claiming
 * the copy reached a clipboard it cannot see.
 *
 * The payload is sanitized before it is encoded: repository and model text can
 * carry terminal escapes (SEC-001), and although base64 cannot represent an ESC
 * byte it can faithfully reproduce one after the terminal decodes it. Stripping
 * them here keeps the decoded clipboard text exactly as safe as the screen.
 */

import { sanitizeTerminalText } from "../util/text.js";

/** The largest payload (in UTF-8 bytes) this module will hand to a terminal. */
export const CLIPBOARD_MAX_BYTES = 100_000;

/**
 * The OSC 52 sequence that copies `text` to the system clipboard.
 *
 * Pure and total: it returns the escape sequence, or `""` when the sanitized
 * payload is empty or larger than `maxBytes` (the caller treats that as "not
 * copied" instead of emitting a truncated or unbounded sequence). The payload is
 * base64, so it never contains a raw ESC, and the text it decodes to is already
 * stripped of control sequences.
 */
export function osc52Sequence(text: string, maxBytes = CLIPBOARD_MAX_BYTES): string {
  if (typeof text !== "string" || typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) {
    return "";
  }
  if (maxBytes <= 0) return "";
  // Reject on the raw length before scanning/sanitizing the whole payload: an
  // oversized answer must not spend work only to be refused afterwards.
  if (Buffer.byteLength(text, "utf8") > maxBytes) return "";
  const sanitized = sanitizeTerminalText(text);
  if (sanitized.length === 0) return "";
  if (Buffer.byteLength(sanitized, "utf8") > maxBytes) return "";
  return `\x1b]52;c;${Buffer.from(sanitized, "utf8").toString("base64")}\x1b\\`;
}

/** The write side of the output stream `copyToTerminal` sends the sequence to. */
export interface ClipboardSink {
  write(chunk: string): unknown;
}

/**
 * Write `text` to the terminal clipboard through OSC 52.
 *
 * `out` is the caller's render/output stream, passed explicitly so an embedder
 * or a test can direct the sequence instead of reaching for `process.stdout`.
 * Returns `true` only when the sequence was written. An oversized payload (over
 * {@link CLIPBOARD_MAX_BYTES}) returns `false` without writing anything, so the
 * caller can surface an honest "too large" warning instead of a silent no-op.
 */
export function copyToTerminal(text: string, out: ClipboardSink): boolean {
  const sequence = osc52Sequence(text);
  if (sequence.length === 0) return false;
  out.write(sequence);
  return true;
}

/** `1234` → `1.2k`: a short, honest character count for the copy notice. */
export function formatCharCount(chars: number): string {
  const count = Number.isFinite(chars) ? Math.max(0, Math.floor(chars)) : 0;
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}
