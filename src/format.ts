import chalk from "chalk";
import type { Verdict } from "./engine/types";
import type { ThemeToken } from "./tui/theme";
import { verdictGlyph } from "./tui/glyphs.js";

/** Human-readable duration, e.g. `0s`, `3.2s`, `12m 3s` (headless summaries). */
export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  return `${minutes}m ${remSec}s`;
}

/** Clock-style duration, e.g. `00:00`, `03:07` (TUI elapsed readouts). */
export function formatDurationSec(ms: number): string {
  if (ms <= 0) return "00:00";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Compact duration for a completed pipeline row, e.g. `1.2s`. */
export function formatDurationTerse(ms?: number): string {
  if (!ms || ms <= 0) return "0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The semantic theme token for a verdict — verdicts describe *state*, not colour
 * (REV-7A-003). The TUI resolves the token (`THEME[verdictToken(v)]`) so the
 * palette, and `NO_COLOR`, stay in one place.
 */
export function verdictToken(v: Verdict): ThemeToken {
  switch (v) {
    case "pass":
      return "ok";
    case "warning":
      return "warn";
    case "blocked":
      return "danger";
    case "skipped":
      return "muted";
  }
}

/**
 * The single-width glyph for a verdict (REQ-52 / ADR-51). Delegates to the shared
 * table so the TUI and `.harness/PROGRESS.md` cannot drift.
 */
export function verdictIcon(v: Verdict): string {
  return verdictGlyph(v);
}

export function verdictBadge(v: Verdict): string {
  switch (v) {
    case "pass":
      return chalk.bgGreen.black.bold(" PASS ");
    case "warning":
      return chalk.bgYellow.black.bold(" WARN ");
    case "blocked":
      return chalk.bgRed.white.bold(" BLOCKED ");
    case "skipped":
      return chalk.bgGray.white.bold(" SKIPPED ");
    default:
      return chalk.bgMagenta.white.bold(` ${v} `);
  }
}

/** Compact token count, e.g. `987`, `12.3k`, `1.2M`. */
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** A cost, or `undefined` when nothing was measured (never a fake `$0.00`). */
export function formatCost(usd: number): string | undefined {
  if (!Number.isFinite(usd) || usd <= 0) return undefined;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

/**
 * One line of token/cost telemetry, or `undefined` when the driver reported
 * nothing. A surface that gets `undefined` renders no usage row at all — it never
 * shows `0 in / 0 out`, which would look like a measurement.
 */
export function formatUsage(total?: {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): string | undefined {
  if (!total) return undefined;
  const input = Math.max(0, total.inputTokens);
  const output = Math.max(0, total.outputTokens);
  const cost = formatCost(total.costUsd);
  if (input === 0 && output === 0 && cost === undefined) return undefined;
  const parts: string[] = [];
  if (input > 0 || output > 0) {
    parts.push(`${compactTokens(input)} in / ${compactTokens(output)} out`);
  }
  if (cost) parts.push(cost);
  return parts.join(" · ");
}
