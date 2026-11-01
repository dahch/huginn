/**
 * Live-session status summaries (Phase 7B / REQ-12).
 *
 * The console's status surfaces — the raven header's second row and the side
 * panel — describe the same few facts: which branch the session runs on and
 * whether the tree is dirty, whether the session lives in an isolated worktree,
 * what Muninn holds, and how big the conversation has grown. Keeping the wording
 * here, as pure functions, means the two surfaces can never disagree and the
 * render loop only pays for a couple of string joins.
 *
 * Two rules the summaries never break:
 *  - **no fabrication** (NFR-10): every value comes from what the engine
 *    reported; a counter with nothing to count renders `""`, never `0`, and a
 *    Muninn database that could not be read says so instead of showing an empty
 *    one (AC-30.5).
 *  - **no colour**: these are strings. The TUI picks the token, so the palette
 *    and `NO_COLOR` stay in the presentation layer (REV-7A-003).
 */

import type { LiveStage } from "../engine/engineEvents.js";
import type { McpBadge, McpBadgeStatus } from "../engine/agent/mcpStatus.js";
import { sanitizeTerminalText } from "../util/text.js";
import { STATUS_GLYPHS } from "./glyphs.js";
import { headerValue } from "./RavenHeader.js";

/** The branch glyph the git summaries are introduced with (one column). */
export const GIT_MARK = "⎇";

/** Columns a git branch may claim before it is clamped. */
export const GIT_BRANCH_COLUMNS = 32;
/** Columns the sanitized Muninn failure reason may claim. */
export const MEMORY_REASON_COLUMNS = 40;

/** What the header/panel needs to know about the working tree. */
export interface GitSummary {
  /** Current branch name (`unknown` when git could not be read). */
  branch: string;
  /** `true` when the working tree has no pending changes. */
  clean: boolean;
  /** `true` when the session runs inside an isolated worktree sandbox. */
  sandbox: boolean;
}

/**
 * Muninn's counts, or the reason they could not be read. `error` is the
 * AC-30.5 signal: with it, the counts are meaningless and the UI must say so
 * rather than present an unavailable database as an empty one.
 */
export interface MemorySummary {
  entitiesCount: number;
  observationsCount: number;
  error?: string;
}

/** How big the conversation the live prompt carries is. */
export interface ContextStat {
  /** User + thinker turns on screen (system notices are not conversation). */
  turns: number;
  /** Characters those turns hold — the honest proxy for context size. */
  chars: number;
}

/**
 * Compact character count: `840`, `1.4k`, `12k`. Never fabricates a token
 * count: the engine exposes no tokenizer, so the surfaces report *characters*
 * and say so (NFR-10).
 */
export function formatCount(value: number): string {
  const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (count < 1_000) return String(count);
  if (count < 100_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${Math.round(count / 1_000)}k`;
}

/**
 * `⎇ main · clean`, `⎇ feature/parser · dirty`. Empty when nothing was reported,
 * so a caller can drop the whole row instead of printing a bare glyph.
 */
export function gitStat(git?: GitSummary | null): string {
  if (!git) return "";
  const branch = headerValue(git.branch, GIT_BRANCH_COLUMNS);
  if (branch.length === 0) return "";
  return `${GIT_MARK} ${branch} · ${git.clean ? "clean" : "dirty"}`;
}

/** `sandbox` only when the session really runs in an isolated worktree. */
export function sandboxLabel(git?: GitSummary | null): string {
  return git?.sandbox ? "sandbox" : "";
}

/**
 * `3 turns · 1.4k chars`, or `""` while the conversation is empty — an empty
 * session has no context size to report.
 */
export function contextStat(context?: ContextStat | null): string {
  if (!context || context.turns <= 0) return "";
  const turns = context.turns === 1 ? "1 turn" : `${context.turns} turns`;
  return `${turns} · ${formatCount(context.chars)} chars`;
}

/**
 * `4 entities · 9 obs`, or `unavailable — <reason>` when the database could not
 * be read (AC-30.5). Empty when the caller has no diagnostics at all.
 */
export function memoryStat(memory?: MemorySummary | null): string {
  if (!memory) return "";
  if (memory.error) return `unavailable — ${headerValue(memory.error, MEMORY_REASON_COLUMNS)}`;
  // Both counters go through the same compact formatter: a large database reads
  // `2.3k entities · 76 obs` instead of overflowing the panel's value column.
  const entities = formatCount(memory.entitiesCount);
  const observations = formatCount(memory.observationsCount);
  return `${entities} entities · ${observations} obs`;
}

/**
 * The single-column mark each MCP severity is introduced with (REQ-76). It comes
 * from the shared status table, never from a literal in the JSX, so the badge
 * speaks the same measured alphabet as the pipeline and the feedback channel.
 */
export const MCP_STATUS_GLYPHS: Readonly<Record<McpBadgeStatus, string>> = Object.freeze({
  healthy: STATUS_GLYPHS.pass,
  degraded: STATUS_GLYPHS.warning,
  unknown: STATUS_GLYPHS.pending,
});

/** The badge's `MCP: ` label; the status mark is inserted right after it. */
const MCP_LABEL = "MCP: ";

/**
 * The MCP badge as the TUI may paint it: `formatMcpBadge` describes the report
 * with pictographs (`🟢`/`🟡`/`⚪`), which are double-width and break the console's
 * monospace grid. This pure mapping — deliberately on the **TUI** side of the
 * boundary, so the engine keeps producing the badge it always did — removes every
 * pictograph and variation selector, collapses the whitespace they leave behind,
 * and re-introduces the status as one measured glyph right after `MCP: `:
 *
 *   `MCP: 🟢 2 connected · pi` → `MCP: ✓ 2 connected · pi`
 *
 * `formatMcpBadge` itself is untouched, and so is its test.
 */
export function mcpBadgeText(badge: McpBadge): string {
  const clean = sanitizeTerminalText(badge.text ?? "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\uFE0F/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const glyph = MCP_STATUS_GLYPHS[badge.status] ?? STATUS_GLYPHS.pending;
  // The label is re-inserted with the mark right after it, so a badge the
  // engine sent as `MCP: 🟢` alone still names itself (`MCP: ✓`).
  const rest = clean.replace(/^MCP:\s*/, "");
  return rest.length > 0 ? `${MCP_LABEL}${glyph} ${rest}` : `${MCP_LABEL}${glyph}`;
}

/**
 * The header's one-line status summary: git state first, the sandbox next, the
 * conversation counter last. Each part only joins while the row still has room,
 * so a narrow terminal loses the *least* important detail instead of wrapping —
 * the same rule every other header value follows (AC-29.3). Pure, so the header
 * and the layout tests share one wording.
 */
export function sessionStat(
  git: GitSummary | null | undefined,
  context: ContextStat | null | undefined,
  maxWidth: number,
): string {
  const context_ = contextStat(context);
  const parts = [gitStat(git), sandboxLabel(git), context_ ? `ctx ${context_}` : ""].filter(
    (part) => part.length > 0,
  );
  let text = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    const joined = text.length > 0 ? `${text} · ${part}` : part;
    if (joined.length > maxWidth) break;
    text = joined;
  }
  return headerValue(text, maxWidth);
}

/**
 * One useful reminder per live stage (REQ-12). A tip is a reminder, never a
 * claim about state, so it is safe to show whatever the session is doing.
 *
 * They are deliberately short: the same string is rendered inside the side
 * panel's narrowest column (see `SIDE_PANEL_WIDTH`) and in the hero's tip box.
 */
export const STAGE_TIPS: Readonly<Record<LiveStage, string>> = Object.freeze({
  /** Refining the scope in prose — the palette is the next thing to learn. */
  refine: "type / for commands",
  /** Drafting the documents — leaving is the likely next intent. */
  draft: "Esc aborts the session",
  /** Reviewing the drafted documents — Enter is the affirmative key. */
  approve: "Enter approves it",
  /** The cycle is running — the stream card has its own scroll keys. */
  execute: "Tab focuses the stream",
});

/** The tip for a stage (never empty for a known stage). */
export function stageTip(stage: LiveStage): string {
  return STAGE_TIPS[stage] ?? "";
}
