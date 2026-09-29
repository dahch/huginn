import chalk from "chalk";
import type { Verdict } from "./engine/types";
import type { ThemeToken } from "./tui/theme";

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

export function verdictIcon(v: Verdict): string {
  switch (v) {
    case "pass":
      return "✅";
    case "warning":
      return "🟡";
    case "blocked":
      return "🔴";
    case "skipped":
      return "⏭️";
  }
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