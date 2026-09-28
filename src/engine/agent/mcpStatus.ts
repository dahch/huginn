import { sanitizeTerminalText } from "../../util/text.js";
import type {
  IAgentRuntime,
  McpListingStatus,
  McpServerListing,
  McpServerState,
  McpServerStatus,
  McpStatusReport,
} from "./types.js";

/** Columns the reason is clamped to in the header badge (the header clamps again). */
export const MCP_BADGE_REASON_WIDTH = 40;

/**
 * Budget the TUI gives the whole MCP status call (NFR-9). The listing paths are
 * individually bounded, and this bounds the poll as a whole so the badge can
 * never stall the viewer — while still being generous enough for the slowest
 * verified CLI (`opencode mcp list` ≈ 5 s, `commandcode` ≈ 8 s).
 */
export const MCP_STATUS_POLL_TIMEOUT_MS = 12000;

/** How long a completed listing is reused before the agent's CLI is asked again. */
const LISTING_CACHE_TTL_MS = 60_000;

/**
 * Last successful listing per runtime, plus the in-flight promise behind it.
 *
 * `claude mcp list` health-checks every server (≈ 23 s measured), which must not
 * mean "timeout forever": the spawn keeps running past the poll deadline, lands
 * in the cache, and the next poll reports it.
 */
const listingCache = new Map<string, { at: number; listings: McpServerListing[] }>();
const inFlightListings = new Map<string, Promise<McpServerListing[]>>();

/** Numeric fields are always nullish-coalesced, so `NaN`/`undefined` cannot reach the screen (AC-32.4). */
function count(value: number | undefined | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The report's servers, tolerating a malformed report (`servers` missing/undefined). */
function serversOf(report?: McpStatusReport | null): McpServerStatus[] {
  return Array.isArray(report?.servers) ? report.servers : [];
}

/**
 * Total tools behind a report: the reported total when it exists, otherwise the
 * per-server sum. Always a real number (AC-32.4).
 */
export function mcpToolTotal(report?: McpStatusReport | null): number {
  const reported = count(report?.totalTools);
  if (reported > 0) return reported;
  return serversOf(report).reduce((sum, server) => sum + count(server.toolsCount), 0);
}

/** True when every reported server was verified reachable by a real probe. */
function verifiedConnected(servers: McpServerStatus[]): McpServerStatus[] {
  return servers.filter((s) => s.status === "connected");
}

/**
 * True when the report carries an honestly-unknown state: either an explicit
 * `unverified` flag or servers that were discovered but never probed (AC-30.1).
 */
export function hasUnverified(report?: McpStatusReport | null): boolean {
  if (report?.unverified) return true;
  return serversOf(report).some((s) => s.status === "unknown");
}

/** Honest listing→status mapping (AC-32.2): only `connected` may be described as live. */
export function mapListingToServerState(status: McpListingStatus): McpServerState {
  if (status === "connected") return "connected";
  if (status === "disabled") return "disconnected";
  // `enabled` / `pending` / `unknown`: configured (or not probed), never live.
  return "unknown";
}

/**
 * Turns the active agent's own listing into a status report (REQ-32 / AC-32.1).
 *
 * Servers are attributed to the agent that named them (`<agent>:<name>` ids), and
 * the report is honest about its own depth: `enabled`/`pending`/`unknown` become
 * `unknown` (configured, not probed) and the report is flagged `unverified`
 * whenever nothing was probed, so the badge says "configured" rather than
 * implying health. `connected` — and only `connected` — is passed through.
 */
export function reportFromListings(
  runtimeId: string,
  listings: McpServerListing[],
): McpStatusReport {
  const servers: McpServerStatus[] = [];
  const seen = new Set<string>();

  for (const listing of listings) {
    const name = sanitizeTerminalText(listing?.name ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const transport = sanitizeTerminalText(listing?.transport ?? "").trim();
    const detail = sanitizeTerminalText(listing?.detail ?? "").trim();
    servers.push({
      id: `${sanitizeTerminalText(runtimeId) || "agent"}:${name}`,
      name,
      status: mapListingToServerState(listing?.status ?? "unknown"),
      // The CLI reported no transport → say so rather than assume one.
      transport: transport || "unknown",
      toolsCount: 0,
      detail: detail || undefined,
    });
  }

  return {
    servers,
    totalTools: 0,
    healthy: servers.length > 0 && servers.every((s) => s.status === "connected"),
    // AC-32.4/AC-32.5: a listing that probed nothing is *configured*, not live.
    unverified: servers.some((s) => s.status === "unknown"),
    degraded: servers.some((s) => s.status === "error"),
  };
}

/** One bounded attempt with a reason: `{ value }`, `{ timedOut: true }` or `{ error }`. */
type Attempt<T> = { value: T } | { timedOut: true } | { error: string };

/**
 * Resolves `factory()` within `budgetMs`, never rejecting.
 *
 * The timer is unref'd so a pending deadline can never hold the process (or an
 * Ink test runner) open — the same contract as `fetchMcpStatusWithTimeout`.
 */
async function withDeadline<T>(factory: () => Promise<T>, budgetMs: number): Promise<Attempt<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, Math.max(0, budgetMs));
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  try {
    const result = await Promise.race([factory(), deadline]);
    if (timedOut || result === null) return { timedOut: true };
    return { value: result as T };
  } catch (err) {
    if (timedOut) return { timedOut: true };
    return { error: sanitizeTerminalText(err instanceof Error ? err.message : String(err)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Safely fetches the MCP status report from an agent runtime bounded by a strict
 * timeout (REQ-30 / REQ-32, NFR-9). Guaranteed not to throw or block the render
 * loop, and never to exceed `timeoutMs` in total.
 *
 * Order of truth (REQ-32 / AC-32.1):
 * 1. the agent's **own listing** (`listMcpServers()`) when the runtime provides
 *    one and it named something — the only source that can attribute servers to
 *    the active agent;
 * 2. otherwise the runtime's `getMcpStatus()` probe/config discovery, on the
 *    budget that is still left, so a runtime without a listing command (or one
 *    whose CLI is missing) keeps working exactly as before;
 * 3. otherwise an honest error/timeout report.
 */
export async function fetchMcpStatusWithTimeout(
  runtime: IAgentRuntime,
  timeoutMs = 1500,
): Promise<McpStatusReport> {
  const deadlineAt = Date.now() + Math.max(0, timeoutMs);
  const remaining = (): number => Math.max(0, deadlineAt - Date.now());

  const timeoutReport = (): McpStatusReport => ({
    servers: [],
    totalTools: 0,
    healthy: false,
    degraded: true,
    error: `MCP status timed out after ${timeoutMs}ms`,
  });

  // 1. The active agent's own enumeration, when it has one.
  const listMcpServers = runtime.listMcpServers;
  if (typeof listMcpServers === "function") {
    const key = String(runtime.id ?? "agent");
    const cached = listingCache.get(key);
    if (cached && Date.now() - cached.at < LISTING_CACHE_TTL_MS) {
      return reportFromListings(key, cached.listings);
    }

    // One spawn per runtime, shared between the deadline race and the cache: some
    // CLIs health-check every server (`claude mcp list` ≈ 23 s measured), so a
    // listing that outruns the poll must still be allowed to finish and land on
    // the *next* poll instead of being killed and retried forever.
    let pending = inFlightListings.get(key);
    if (!pending) {
      pending = Promise.resolve(listMcpServers.call(runtime))
        .then((listings) => {
          const resolved = Array.isArray(listings) ? listings : [];
          listingCache.set(key, { at: Date.now(), listings: resolved });
          return resolved;
        })
        .catch(() => [] as McpServerListing[])
        .finally(() => {
          inFlightListings.delete(key);
        });
      inFlightListings.set(key, pending);
    }

    const attempt = await withDeadline(() => pending, remaining());
    if ("value" in attempt) {
      const listings = attempt.value;
      // An empty listing means "nothing enumerated" (no listing command, missing
      // binary, or truly no servers) — fall through to config discovery rather
      // than presenting it as the whole truth.
      if (listings.length > 0) {
        return reportFromListings(key, listings);
      }
    } else if (cached) {
      // Deadline lost, but we have a real earlier answer: prefer it over a timeout.
      return reportFromListings(key, cached.listings);
    } else {
      return timeoutReport();
    }
  }

  // 2. The runtime's own probe / config discovery, on the remaining budget.
  const probe = await withDeadline(() => Promise.resolve(runtime.getMcpStatus()), remaining());
  if ("timedOut" in probe) {
    return timeoutReport();
  }
  if ("error" in probe) {
    return {
      servers: [],
      totalTools: 0,
      healthy: false,
      degraded: true,
      error: probe.error,
    };
  }

  const result = probe.value;
  if (!result || typeof result !== "object" || !Array.isArray(result.servers)) {
    return { servers: [], totalTools: 0, healthy: false, degraded: true, error: "MCP status unavailable" };
  }
  if (result.servers.some((s) => s.status === "error") && result.degraded === undefined) {
    return { ...result, degraded: true };
  }
  return result;
}

/**
 * Maps a status report to a concise, *truthful*, **attributed** header badge
 * (REQ-30 / REQ-32).
 *
 * Every badge names its source agent (AC-32.4) and states what its number means:
 *
 * - `MCP: 🟡 timeout · <agent>`            — the probe/list exceeded its deadline
 * - `MCP: 🟡 error — <reason> · <agent>`   — a probe threw, or a server failed
 * - `MCP: 🟢 n connected · <agent>`        — n servers verified by a real probe
 * - `MCP: ⚪ n configured · <agent>`       — n servers known, none probed
 * - `MCP: ⚪ none · <agent>`               — nothing configured / reported
 *
 * The agent suffix is omitted when the caller has no name to attribute with, so
 * the signature stays backward compatible.
 */
export function formatMcpBadge(
  report?: McpStatusReport | null,
  agentName?: string,
): {
  text: string;
  color: "green" | "yellow" | "gray";
} {
  const agent = attribution(agentName);
  const servers = serversOf(report);

  const failed = servers.some((s) => s.status === "error");
  if (report?.degraded || report?.error || failed) {
    const lower = (report?.error ?? "").toLowerCase();
    const isTimeout = lower.includes("timed out") || lower.includes("timeout");
    if (isTimeout) {
      return { text: `MCP: 🟡 timeout${agent}`, color: "yellow" };
    }
    const reason = report?.error ? badgeReason(report.error) : "";
    return {
      text: reason ? `MCP: 🟡 error — ${reason}${agent}` : `MCP: 🟡 error${agent}`,
      color: "yellow",
    };
  }

  const active = verifiedConnected(servers);
  if (active.length > 0) {
    // Keep the tool count when it is actually known (a real probe can report it;
    // a CLI listing usually cannot), and never render `(0 tools)` noise.
    const totalTools = Math.max(0, Math.floor(report?.totalTools ?? 0));
    const tools = totalTools > 0 ? ` (${totalTools} tools)` : "";
    return { text: `MCP: 🟢 ${active.length} connected${tools}${agent}`, color: "green" };
  }

  if (servers.length > 0) {
    // Every remaining server is known-but-not-live (`enabled`/`disabled`/
    // `pending`/`unknown`), so the count is qualified as configured: this is the
    // branch AC-32.2 exists for — a listing word must never read as health.
    return { text: `MCP: ⚪ ${servers.length} configured${agent}`, color: "gray" };
  }

  return { text: `MCP: ⚪ none${agent}`, color: "gray" };
}

/** ` · <agent>`, sanitized and single-lined; empty when there is nothing to attribute. */
export function attribution(agentName?: string): string {
  const clean = sanitizeTerminalText(agentName ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? ` · ${clean}` : "";
}

/** Sanitizes and clamps an error reason so a badge never injects control codes or floods a row. */
function badgeReason(reason: string): string {
  const clean = sanitizeTerminalText(reason).replace(/\s+/g, " ").trim();
  if (clean.length <= MCP_BADGE_REASON_WIDTH) return clean;
  return `${clean.slice(0, MCP_BADGE_REASON_WIDTH - 1)}…`;
}
