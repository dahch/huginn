/**
 * Strips ANSI escape sequences and non-printable control characters
 * to prevent terminal injection, cursor hijacking, and log poisoning (SEC-001).
 */
export function sanitizeTerminalText(input: string): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}
