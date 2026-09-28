import { sanitizeTerminalText } from "../../../util/text.js";
import type { McpListingStatus, McpServerListing } from "../types.js";
import { runModelListCommand } from "./modelList.js";

/**
 * Per-agent MCP enumeration through the agent's *own* CLI listing (REQ-32 /
 * ADR-31).
 *
 * Each supported CLI answers "what MCP servers do you have?" in its own
 * human-readable format, so every format gets one pure, fixture-tested parser
 * and every listing runs through the same bounded spawner as model discovery
 * (`runModelListCommand`: hard deadline, stdout cap, process-group kill,
 * sanitized stderr reason). Parsers are pure functions of stdout so they can be
 * verified against captured output without spawning anything.
 *
 * Truthfulness rules that apply to every parser:
 * - ANSI codes are stripped *first* (`sanitizeTerminalText`), because some CLIs
 *   colour the status word (`opencode` prints `ESC[90mconnected`).
 * - Headings, preambles and footers (`MCP Servers`, `└  3 server(s)`,
 *   `Total: 1 server`, `NAME TYPE …`) must never become servers.
 * - A status word is mapped per AC-32.2; anything unrecognised becomes
 *   `unknown`, and only `connected` may ever be described as live.
 */

/** Default deadline for a listing command (NFR-9: resolves within 5 s). */
export const MCP_LIST_TIMEOUT_MS = 5000;

/**
 * `claude mcp list` performs a real health check against every server, so it is
 * given a generous — but still bounded and killable — deadline. Direct callers
 * (provisioning, `huginn doctor`) can afford it; the TUI's badge poll bounds the
 * whole call to {@link MCP_LIST_TIMEOUT_MS} and reports an honest timeout when
 * the health check outruns it.
 */
export const CLAUDE_MCP_LIST_TIMEOUT_MS = 30000;

/** `agy mcp list` reads its local config table (measured ≈ 0.2 s). */
export const AGY_MCP_LIST_TIMEOUT_MS = 3000;

/** `commandcode mcp list` is a local table read too; same bound as `agy`. */
export const COMMANDCODE_MCP_LIST_TIMEOUT_MS = 5000;

/** A leading status glyph the CLIs print before the server name. */
const LEADING_GLYPH = /^[✓✔✗✘×✕]\s*/;

/** Bullet glyph that opens an `opencode mcp list` row (`●  ✓ <name> <status>`). */
const OPENCODE_BULLET = /^[●○◯◦•·*]\s+/;

/** Box-drawing gutter that prefixes an `opencode` detail (command) line. */
const OPENCODE_GUTTER = /^[│┃|]\s*/;

/** `id + 2-or-more spaces` (or tabs) — the column separator of aligned tables. */
const COLUMN_SEPARATOR = /(?:\t+| {2,})/;

/**
 * Maps one status word/glyph reported by a CLI to its true meaning (AC-32.2).
 *
 * - `connected` / `Connected` / `✔` / `✓` (or `healthy`) → `connected` (probed)
 * - `enabled` / `configured` / `➜` → `enabled` (configured, **not** probed)
 * - `disabled` → `disabled`
 * - `pending approval` → `pending`
 * - anything else (including `disconnected`, `failed`, `✗`) → `unknown`
 *
 * Matching is token-based on purpose: a naive `includes("connected")` would
 * upgrade `disconnected` and `not connected` to a live probe.
 */
export function mapMcpListingStatus(raw?: string): McpListingStatus {
  const clean = sanitizeTerminalText(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!clean) return "unknown";

  const tokens = clean.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const has = (token: string): boolean => tokens.includes(token);

  if (has("disabled")) return "disabled";
  if (has("pending")) return "pending";
  // `disconnected` is a single distinct token, so it can never match here.
  if (has("connected") && !has("not")) return "connected";
  if (has("healthy")) return "connected";
  if (has("enabled") || has("configured") || clean.includes("➜")) return "enabled";
  // A bare success glyph still means the CLI probed the server successfully.
  if (clean.includes("✔") || clean.includes("✓")) return "connected";
  return "unknown";
}

/**
 * Transport of a listing entry whose format has no transport column.
 *
 * MCP configuration is mechanically either a URL (remote transport) or a
 * command (stdio), so `opencode`/`claude`/`qwen` command lines can be classified
 * without inventing anything. `undefined` when the listing exposed no detail at
 * all — the panel then says the transport was not reported (AC-32.5).
 */
export function inferListingTransport(detail?: string): string | undefined {
  const clean = sanitizeTerminalText(detail ?? "").trim();
  if (!clean) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(clean) ? "http" : "stdio";
}

/**
 * Splits an aligned table row into at most `max` cells on tab runs or 2+-space
 * runs. The last cell keeps everything that is left (so a command line with
 * single spaces survives verbatim), which is what makes the `agy`/`commandcode`
 * tables parseable without knowing their column widths.
 */
function splitColumns(line: string, max: number): string[] {
  const cells: string[] = [];
  let rest = line.trim();
  while (cells.length < max - 1) {
    const separator = COLUMN_SEPARATOR.exec(rest);
    if (!separator || separator.index < 1) break;
    cells.push(rest.slice(0, separator.index).trim());
    rest = rest.slice(separator.index + separator[0].length);
  }
  cells.push(rest.trim());
  return cells;
}

/** True for the `NAME  TYPE  …` header row every table-format listing prints. */
function isColumnHeader(name: string, second: string): boolean {
  return name.toUpperCase() === "NAME" && second.toUpperCase() === "TYPE";
}

/** Free-text cell that carries no information (`-`, `n/a`, empty). */
function isBlankCell(value: string | undefined): boolean {
  const clean = (value ?? "").trim();
  return clean.length === 0 || clean === "-" || clean.toLowerCase() === "n/a";
}

/**
 * Pure parser for `opencode mcp list` (REQ-32 / AC-32.1).
 *
 * Verified format: a box list — `┌  MCP Servers`, then per server a bullet row
 * `●  ✓ <name> <ESC>[90mconnected` followed by the indented command line
 * (`│      npx @playwright/mcp@latest`), then a `└  N server(s)` footer. The
 * ANSI colour code around the status word is stripped first, and only bullet
 * rows can ever become servers, so the heading, the gutter lines and the footer
 * are inert. Exported for fixture tests.
 */
export function parseOpencodeMcpList(stdout: string): McpServerListing[] {
  const listings: McpServerListing[] = [];
  const seen = new Set<string>();
  const lines = sanitizeTerminalText(stdout).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line || !OPENCODE_BULLET.test(line)) continue;

    const body = line.replace(OPENCODE_BULLET, "").trim();
    const glyph = LEADING_GLYPH.exec(body);
    const rest = body.slice(glyph ? glyph[0].length : 0).trim();
    const row = /^(\S+)\s*(.*)$/.exec(rest);
    if (!row) continue;

    const name = sanitizeTerminalText(row[1] ?? "");
    if (!name || seen.has(name)) continue;
    seen.add(name);

    // The indented line directly below a server is its command line: real
    // detail, and consuming it keeps it from being parsed as another row.
    const nextRaw = (lines[i + 1] ?? "").trim();
    const detail = OPENCODE_GUTTER.test(nextRaw)
      ? nextRaw.replace(OPENCODE_GUTTER, "").trim()
      : "";
    if (detail) i++;

    listings.push({
      name,
      transport: inferListingTransport(detail),
      status: mapMcpListingStatus(row[2] || (glyph ? glyph[0] : "")),
      detail: detail || undefined,
    });
  }

  return listings;
}

/**
 * Pure parser for `claude mcp list` (REQ-32 / AC-32.1).
 *
 * Verified format: a `Checking MCP server health…` preamble, a blank line, then
 * `<name>: <command> - <✔ status>`. The name may itself contain colons
 * (`plugin:engram:engram`), so the separator is the *first* `: ` and the status
 * is what follows the *last* ` - `. Preamble lines carry neither, so they are
 * skipped rather than turned into servers. Exported for fixture tests.
 */
export function parseClaudeMcpList(stdout: string): McpServerListing[] {
  const listings: McpServerListing[] = [];
  const seen = new Set<string>();

  for (const rawLine of sanitizeTerminalText(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const nameSep = line.indexOf(": ");
    if (nameSep <= 0) continue;
    const statusSep = line.lastIndexOf(" - ");
    if (statusSep <= nameSep) continue;

    const name = line.slice(0, nameSep).trim();
    const command = line.slice(nameSep + 2, statusSep).trim();
    const status = line.slice(statusSep + 3).trim();
    if (!name || !status || seen.has(name)) continue;
    seen.add(name);

    listings.push({
      name,
      transport: inferListingTransport(command),
      status: mapMcpListingStatus(status),
      detail: command || undefined,
    });
  }

  return listings;
}

/**
 * Pure parser for `qwen mcp list` (REQ-32 / AC-32.1).
 *
 * Verified format: a `Configured MCP servers:` heading, then
 * `<ESC>[32m✓<ESC>[0m <name>: <command> (<transport>) - <Connected>`. The ANSI
 * codes and the leading glyph are stripped, the transport is read from the last
 * parenthesised group before the status (so nothing is guessed when the CLI
 * reports one), and the heading — which has no `: ` separator — is skipped.
 * Exported for fixture tests.
 */
export function parseQwenMcpList(stdout: string): McpServerListing[] {
  const listings: McpServerListing[] = [];
  const seen = new Set<string>();

  for (const rawLine of sanitizeTerminalText(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const body = line.replace(LEADING_GLYPH, "").trim();
    const nameSep = body.indexOf(": ");
    if (nameSep <= 0) continue;

    const name = body.slice(0, nameSep).trim();
    const tail = body.slice(nameSep + 2).trim();
    if (!name || !tail || seen.has(name)) continue;

    const withTransport = /^(.*?)\(\s*([^()]+?)\s*\)\s+-\s+(.+)$/.exec(tail);
    let command: string;
    let transport: string | undefined;
    let status: string;

    if (withTransport) {
      command = withTransport[1].trim();
      transport = withTransport[2].trim();
      status = withTransport[3].trim();
    } else {
      const statusSep = tail.lastIndexOf(" - ");
      if (statusSep < 0) continue;
      command = tail.slice(0, statusSep).trim();
      transport = inferListingTransport(command);
      status = tail.slice(statusSep + 3).trim();
    }
    if (!status) continue;
    seen.add(name);

    listings.push({
      name,
      transport,
      status: mapMcpListingStatus(status),
      detail: command || undefined,
    });
  }

  return listings;
}

/**
 * Pure parser for `agy mcp list` (REQ-32 / AC-32.1).
 *
 * Verified format: a `NAME TYPE STATUS COMMAND/URL` header followed by aligned
 * rows (`muninn  stdio  enabled  huginn mcp run --project …`). Statuses are the
 * configuration words `enabled`/`disabled` — never a probe result — so they map
 * to `enabled`/`disabled` and are never upgraded to `connected` (AC-32.2).
 * Exported for fixture tests.
 */
export function parseAgyMcpList(stdout: string): McpServerListing[] {
  const listings: McpServerListing[] = [];
  const seen = new Set<string>();

  for (const rawLine of sanitizeTerminalText(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const cells = splitColumns(line, 4);
    const [rawName = "", rawTransport = "", rawStatus = "", rawDetail = ""] = cells;
    if (cells.length < 3) continue;
    if (isColumnHeader(rawName, rawTransport)) continue;

    const name = sanitizeTerminalText(rawName).trim();
    if (!name || !rawStatus || seen.has(name)) continue;
    seen.add(name);

    const detail = rawDetail.trim();
    listings.push({
      name,
      transport: sanitizeTerminalText(rawTransport).trim() || inferListingTransport(detail),
      status: mapMcpListingStatus(rawStatus),
      detail: detail || undefined,
    });
  }

  return listings;
}

/**
 * Pure parser for `commandcode mcp list` (REQ-32 / AC-32.1).
 *
 * Verified format: a blank line, `MCP Servers`, the header
 * `NAME TYPE SCOPE AUTH STATUS`, indented rows
 * (`  muninn  stdio  user     -     enabled`) and a `Total: N server(s)` footer.
 * Scope/auth are surfaced as detail (AC-32.5) so the panel can show what the CLI
 * actually knows; placeholders (`-`) are dropped rather than rendered as truth.
 * Exported for fixture tests.
 */
export function parseCommandcodeMcpList(stdout: string): McpServerListing[] {
  const listings: McpServerListing[] = [];
  const seen = new Set<string>();

  for (const rawLine of sanitizeTerminalText(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^MCP Servers$/i.test(line)) continue;
    if (/^Total:/i.test(line)) continue;

    const cells = splitColumns(line, 5);
    const [rawName = "", rawTransport = "", rawScope = "", rawAuth = "", rawStatus = ""] = cells;
    if (cells.length < 5) continue;
    if (isColumnHeader(rawName, rawTransport)) continue;

    const name = sanitizeTerminalText(rawName).trim();
    if (!name || !rawStatus || seen.has(name)) continue;
    seen.add(name);

    const detailParts: string[] = [];
    if (!isBlankCell(rawScope)) detailParts.push(`scope ${sanitizeTerminalText(rawScope).trim()}`);
    if (!isBlankCell(rawAuth)) detailParts.push(`auth ${sanitizeTerminalText(rawAuth).trim()}`);

    listings.push({
      name,
      transport: sanitizeTerminalText(rawTransport).trim() || undefined,
      status: mapMcpListingStatus(rawStatus),
      detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
    });
  }

  return listings;
}

/** Declarative wiring of one listing CLI: argv + the pure parser for its format. */
export interface McpListCommandSpec {
  command: string;
  args: string[];
  parse: (stdout: string) => McpServerListing[];
  /** Bounded spawn deadline; defaults to {@link MCP_LIST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Outcome of one listing spawn: parsed listings, or the reason there are none. */
export interface McpListCommandResult {
  listings?: McpServerListing[];
  error?: string;
}

/**
 * Runs one agent's MCP listing command and parses its stdout.
 *
 * Never throws and never fabricates: a missing binary, a non-zero exit, a
 * timeout, empty output or unparseable output all resolve with an `error`
 * reason (and no `listings`), so a caller can distinguish "the CLI told me
 * nothing" from "the CLI has no servers" — and can fall back to config
 * discovery instead of rendering an empty panel as if it were the truth.
 */
export async function runMcpListCommand(
  spec: McpListCommandSpec,
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<McpListCommandResult> {
  const timeoutMs = options.timeoutMs ?? spec.timeoutMs ?? MCP_LIST_TIMEOUT_MS;
  const commandLine = `${spec.command} ${spec.args.join(" ")}`.trim();

  const result = await runModelListCommand(spec.command, spec.args, {
    env: options.env,
    timeoutMs,
  });
  if (result.error || result.stdout === undefined) {
    return { error: result.error ?? `\`${commandLine}\` printed no output` };
  }

  try {
    const listings = spec.parse(result.stdout);
    return { listings: Array.isArray(listings) ? listings : [] };
  } catch (err) {
    const detail = sanitizeTerminalText(err instanceof Error ? err.message : String(err));
    return { error: `could not parse \`${commandLine}\` output: ${detail}` };
  }
}

/** {@link runMcpListCommand} collapsed to the `IAgentRuntime` contract: `[]` on any failure. */
export async function listMcpServersViaCommand(
  spec: McpListCommandSpec,
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<McpServerListing[]> {
  const result = await runMcpListCommand(spec, options);
  return result.listings ?? [];
}
