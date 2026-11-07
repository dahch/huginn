/**
 * `huginn stats` — what the recorded runs prove, read-only.
 *
 * The measurement plan starts here: before a benchmark exists, a project already
 * carries the evidence of every run it ever made (state.json and the per-iteration
 * receipts). This command reads those files and says what they contain —
 * iterations, per-phase verdicts, retries, time per phase, token cost — instead
 * of asking anyone to grep the harness directory by hand.
 *
 * It is deliberately a *reader*: no engine, no model, no writes. A run that died
 * halfway still reports what it managed to record, and a project with no harness
 * directory reports that honestly rather than an empty table.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { formatDurationTerse, formatUsage } from "../format.js";
import { statePath } from "../state/store.js";
import { sanitizeTerminalText } from "../util/text.js";

const RECEIPTS_SUBDIR = join(".huginn", "receipts");
const RECEIPT_FILE = /^iter-(\d+)\.json$/;

/** One verdict bucket per phase, so a phase that only ever warned is visible. */
export interface PhaseSummary {
  phase: string;
  attempts: number;
  pass: number;
  warning: number;
  blocked: number;
  skipped: number;
  /** Attempts recorded without a verdict (a phase that died mid-turn). */
  unverdicted: number;
  /** Median wall time per attempt, or `null` when no attempt carried both stamps. */
  medianMs: number | null;
}

export interface RunStats {
  projectPath: string;
  /** False when there is no state.json at all (a project never run here). */
  hasState: boolean;
  models: { thinker: string; executor: string } | null;
  mode: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  aborted: boolean;
  currentIteration: number;
  promotion: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  phases: PhaseSummary[];
  attempts: number;
  /** Attempts spent on a `FIX_*` phase: the retry cost of the run. */
  fixRounds: number;
  /** Receipt files found under .huginn/receipts/. */
  receipts: number;
  /** Receipts whose VERIFY phase passed: a tree that was actually verified. */
  verifiedReceipts: number;
  /** Iteration numbers the receipts cover. */
  receiptedIterations: number[];
  /** startedAt → finishedAt (or updatedAt for a run still open). */
  durationMs: number | null;
}

/** Median of a non-empty list; even lengths average the middle pair. */
export function median(values: number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : Math.round((clean[mid - 1] + clean[mid]) / 2);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface HistoryRow {
  phase: string;
  verdict: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function readHistory(state: Record<string, unknown>): HistoryRow[] {
  const raw = Array.isArray(state.history) ? state.history : [];
  const rows: HistoryRow[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const phase = asString(entry.phase);
    if (!phase) continue;
    const verdict = asString(entry.verdict);
    rows.push({
      phase,
      verdict: verdict === "pass" || verdict === "warning" || verdict === "blocked" || verdict === "skipped" ? verdict : null,
      startedAt: asString(entry.startedAt),
      finishedAt: asString(entry.finishedAt),
    });
  }
  return rows;
}

function attemptMs(row: HistoryRow): number | null {
  if (!row.startedAt || !row.finishedAt) return null;
  const start = Date.parse(row.startedAt);
  const end = Date.parse(row.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function readReceipts(projectPath: string): { count: number; verified: number; iterations: number[] } {
  const dir = join(projectPath, RECEIPTS_SUBDIR);
  if (!existsSync(dir)) return { count: 0, verified: 0, iterations: [] };
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => RECEIPT_FILE.test(name));
  } catch {
    return { count: 0, verified: 0, iterations: [] };
  }
  let verified = 0;
  const iterations: number[] = [];
  for (const name of names) {
    const iteration = Number(RECEIPT_FILE.exec(name)?.[1]);
    if (Number.isInteger(iteration)) iterations.push(iteration);
    const receipt = readJson(join(dir, name));
    if (!isRecord(receipt) || !Array.isArray(receipt.verdicts)) continue;
    const verify = receipt.verdicts.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && asString(entry.phase) === "VERIFY",
    );
    if (verify && asString(verify.verdict) === "pass") verified += 1;
  }
  iterations.sort((a, b) => a - b);
  return { count: names.length, verified, iterations };
}

/** Read a project's harness directory into one comparable object. */
export function readRunStats(projectPath: string): RunStats {
  const root = resolve(projectPath);
  const state = readJson(statePath(root));
  const receipts = readReceipts(root);

  if (!isRecord(state)) {
    return {
      projectPath: root,
      hasState: false,
      models: null,
      mode: null,
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      aborted: false,
      currentIteration: 0,
      promotion: null,
      usage: null,
      phases: [],
      attempts: 0,
      fixRounds: 0,
      receipts: receipts.count,
      verifiedReceipts: receipts.verified,
      receiptedIterations: receipts.iterations,
      durationMs: null,
    };
  }

  const history = readHistory(state);
  const byPhase = new Map<string, HistoryRow[]>();
  for (const row of history) {
    const list = byPhase.get(row.phase) ?? [];
    list.push(row);
    byPhase.set(row.phase, list);
  }
  const phases: PhaseSummary[] = [...byPhase.entries()]
    .map(([phase, rows]) => ({
      phase,
      attempts: rows.length,
      pass: rows.filter((row) => row.verdict === "pass").length,
      warning: rows.filter((row) => row.verdict === "warning").length,
      blocked: rows.filter((row) => row.verdict === "blocked").length,
      skipped: rows.filter((row) => row.verdict === "skipped").length,
      unverdicted: rows.filter((row) => row.verdict === null).length,
      medianMs: median(rows.map(attemptMs).filter((ms): ms is number => ms !== null)),
    }))
    .sort((a, b) => a.phase.localeCompare(b.phase));

  const models = isRecord(state.models)
    ? {
        thinker: sanitizeTerminalText(asString(state.models.thinker) ?? ""),
        executor: sanitizeTerminalText(asString(state.models.executor) ?? ""),
      }
    : null;
  const usage = isRecord(state.usage)
    ? {
        inputTokens: asNumber(state.usage.inputTokens) ?? 0,
        outputTokens: asNumber(state.usage.outputTokens) ?? 0,
        costUsd: asNumber(state.usage.costUsd) ?? 0,
      }
    : null;
  const promotion = isRecord(state.promotion) ? asString(state.promotion.status) : null;

  const startedAt = asString(state.startedAt);
  const finishedAt = asString(state.finishedAt);
  const updatedAt = asString(state.updatedAt);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = Date.parse(finishedAt ?? updatedAt ?? "");
  const durationMs =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;

  return {
    projectPath: root,
    hasState: true,
    models,
    mode: asString(state.mode),
    startedAt,
    updatedAt,
    finishedAt,
    aborted: state.aborted === true,
    currentIteration: asNumber(state.currentIteration) ?? 0,
    promotion,
    usage,
    phases,
    attempts: history.length,
    fixRounds: history.filter((row) => row.phase.startsWith("FIX_")).length,
    receipts: receipts.count,
    verifiedReceipts: receipts.verified,
    receiptedIterations: receipts.iterations,
    durationMs,
  };
}

/** Human summary; `--json` prints the object instead. */
export function formatRunStats(stats: RunStats): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold(`[huginn] stats — ${stats.projectPath}`));
  if (!stats.hasState) {
    lines.push(chalk.dim("  no .harness/state.json: this project has not run here"));
    if (stats.receipts > 0) {
      lines.push(`  receipts    ${stats.receipts} (${stats.verifiedReceipts} verified)`);
    }
    return lines;
  }

  const verdicts = stats.phases.reduce(
    (acc, phase) => ({
      pass: acc.pass + phase.pass,
      warning: acc.warning + phase.warning,
      blocked: acc.blocked + phase.blocked,
      skipped: acc.skipped + phase.skipped,
    }),
    { pass: 0, warning: 0, blocked: 0, skipped: 0 },
  );

  lines.push(
    `  models      thinker ${chalk.magenta(stats.models?.thinker || "—")} · executor ${chalk.blueBright(stats.models?.executor || "—")}`,
  );
  lines.push(
    `  run         ${stats.mode ?? "—"} · ${stats.durationMs === null ? "duration n/a" : formatDurationTerse(stats.durationMs)} · ${stats.aborted ? chalk.yellow("aborted") : stats.finishedAt ? "finished" : chalk.yellow("open")}`,
  );
  lines.push(
    `  iterations  current ${stats.currentIteration} · ${stats.receipts} receipt${stats.receipts === 1 ? "" : "s"} (${stats.verifiedReceipts} verified) · promotion ${stats.promotion ?? "none"}`,
  );
  // state.json holds the *current* run; receipts accumulate across runs. Saying
  // which one the count comes from is the difference between a baseline and a
  // number that looks bigger than the project.
  lines.push(
    `  phases      ${stats.attempts} attempts in the current state · ${stats.fixRounds} fix round${stats.fixRounds === 1 ? "" : "s"}`,
  );
  lines.push(
    `  verdicts    ${chalk.green(`pass ${verdicts.pass}`)} · ${chalk.yellow(`warning ${verdicts.warning}`)} · ${chalk.red(`blocked ${verdicts.blocked}`)} · ${chalk.dim(`skipped ${verdicts.skipped}`)}`,
  );
  const usage = stats.usage ? formatUsage(stats.usage) : undefined;
  if (usage) lines.push(`  usage       ${usage}`);

  if (stats.phases.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  per phase"));
    const width = Math.max(...stats.phases.map((phase) => phase.phase.length));
    for (const phase of stats.phases) {
      const parts = [`${phase.attempts} attempt${phase.attempts === 1 ? "" : "s"}`];
      if (phase.pass > 0) parts.push(chalk.green(`${phase.pass} pass`));
      if (phase.warning > 0) parts.push(chalk.yellow(`${phase.warning} warning`));
      if (phase.blocked > 0) parts.push(chalk.red(`${phase.blocked} blocked`));
      if (phase.skipped > 0) parts.push(chalk.dim(`${phase.skipped} skipped`));
      if (phase.unverdicted > 0) parts.push(chalk.dim(`${phase.unverdicted} no verdict`));
      if (phase.medianMs !== null) parts.push(chalk.dim(`median ${formatDurationTerse(phase.medianMs)}`));
      lines.push(`  ${phase.phase.padEnd(width)}  ${parts.join(" · ")}`);
    }
  }
  return lines;
}

export function printStatsUsage(io: StatsIo = {}): void {
  (io.log ?? console.log)(`huginn stats — summarize the recorded runs, read-only

Usage:
  huginn stats [--project <path>] [--json]

Reads <project>/.harness/state.json and <project>/.huginn/receipts/iter-*.json:
iterations, per-phase verdicts and medians, fix rounds, promotion, usage. Writes
nothing and never calls a model.

Options:
  --project <path>  repository to inspect (default: cwd)
  --json            print the collected object instead of the summary
  --help, -h        show this help`);
}

export interface StatsIo {
  log?: (message: string) => void;
}

/** `huginn stats` entry point. Exit code stays 0 even with no state: an empty
 * project is a fact to report, not an error. */
export function handleStatsCommand(
  args: Record<string, string | boolean | undefined>,
  io: StatsIo = {},
): void {
  const log = io.log ?? console.log;
  if (args["--help"] || args["-h"]) {
    printStatsUsage(io);
    return;
  }
  const projectPath = typeof args["--project"] === "string" ? resolve(args["--project"]) : process.cwd();
  const stats = readRunStats(projectPath);
  if (args["--json"]) {
    log(JSON.stringify(stats, null, 2));
    return;
  }
  for (const line of formatRunStats(stats)) log(line);
}
