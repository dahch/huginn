/**
 * `huginn report` — read one iteration's receipt and print it in two lanes.
 *
 * The receipt already recorded *what happened*; this command says what it is
 * *worth*: what the engine proved by running something (deterministic), what a
 * model judged (judgment), and which claims the receipt cannot make at all. That
 * separation is the reason the command exists — a run whose only green marks are
 * agent opinions should read differently from one whose verification passed.
 *
 * Read-only: no engine, no model, no writes. A v1 receipt (which listed only
 * verdicts) is classified from its phase names and *says so*, instead of
 * pretending the split was recorded at write time.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import {
  evidenceClassForPhase,
  partitionPhases,
  unprovenClaims,
  type EvidenceEntry,
} from "../engine/evidence.js";
import { sanitizeTerminalText } from "../util/text.js";

const RECEIPTS_SUBDIR = join(".huginn", "receipts");
const RECEIPT_FILE = /^iter-(\d+)\.json$/;

export interface ReceiptView {
  path: string;
  iteration: number;
  /** 2 when the file recorded the lanes; 1 when they were derived here. */
  version: number;
  profile: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  treeHash: string | null;
  createdAt: string | null;
  lanes: { deterministic: EvidenceEntry[]; judgment: EvidenceEntry[] };
  unproven: string[];
  /** True when the lanes came from the phase names, not from the file. */
  derived: boolean;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function verdictList(value: unknown): Array<{ phase: string; verdict?: "pass" | "warning" | "blocked" | "skipped" }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ phase: string; verdict?: "pass" | "warning" | "blocked" | "skipped" }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const phase = asString(row.phase);
    if (!phase) continue;
    const verdict = asString(row.verdict);
    out.push({
      phase,
      verdict:
        verdict === "pass" || verdict === "warning" || verdict === "blocked" || verdict === "skipped"
          ? verdict
          : undefined,
    });
  }
  return out;
}

/** Every receipt file, newest iteration first. */
export function listReceipts(projectPath: string): Array<{ iteration: number; path: string }> {
  const dir = join(resolve(projectPath), RECEIPTS_SUBDIR);
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => RECEIPT_FILE.test(name));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ iteration: Number(RECEIPT_FILE.exec(name)?.[1] ?? 0), path: join(dir, name) }))
    .filter((entry) => Number.isInteger(entry.iteration) && entry.iteration > 0)
    .sort((a, b) => b.iteration - a.iteration);
}

/** Read one receipt into the lane view; `undefined` when the file is unreadable. */
export function readReceipt(path: string, iteration: number): ReceiptView | undefined {
  const raw = readJson(path);
  if (!raw) return undefined;

  const verdicts = verdictList(raw.verdicts);
  const recorded = raw.lanes;
  let lanes = partitionPhases(verdicts);
  let derived = true;
  if (typeof recorded === "object" && recorded !== null) {
    const block = recorded as Record<string, unknown>;
    const det = Array.isArray(block.deterministic) ? block.deterministic : null;
    const jud = Array.isArray(block.judgment) ? block.judgment : null;
    if (det && jud) {
      // Recorded at write time: trust the file, but only for phases it lists.
      const clean = (rows: unknown[]): EvidenceEntry[] =>
        rows
          .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
          .map((row) => ({
            phase: sanitizeTerminalText(asString(row.phase) ?? "?"),
            class: evidenceClassForPhase(asString(row.phase) ?? ""),
            verdict: (asString(row.verdict) ?? undefined) as EvidenceEntry["verdict"],
            basis: sanitizeTerminalText(asString(row.basis) ?? ""),
          }));
      lanes = { deterministic: clean(det), judgment: clean(jud) };
      derived = false;
    }
  }

  const recordedUnproven = Array.isArray(raw.unproven)
    ? raw.unproven.filter((entry): entry is string => typeof entry === "string")
    : null;

  return {
    path,
    iteration,
    version: raw.version === 2 ? 2 : 1,
    profile: asString(raw.profile),
    baseCommit: asString(raw.baseCommit),
    headCommit: asString(raw.headCommit),
    treeHash: asString(raw.treeHash),
    createdAt: asString(raw.createdAt),
    lanes,
    unproven: recordedUnproven ?? unprovenClaims(verdicts.map((entry) => entry.phase)),
    derived,
  };
}

function verdictText(entry: EvidenceEntry): string {
  const verdict = entry.verdict ?? "no verdict";
  if (verdict === "pass") return chalk.green("pass");
  if (verdict === "warning") return chalk.yellow("warning");
  if (verdict === "blocked") return chalk.red("blocked");
  if (verdict === "skipped") return chalk.dim("skipped");
  return chalk.yellow("no verdict");
}

function laneLines(title: string, entries: EvidenceEntry[], emptyText: string): string[] {
  const lines = [chalk.bold(`  ${title}`)];
  if (entries.length === 0) {
    lines.push(chalk.dim(`    ${emptyText}`));
    return lines;
  }
  const width = Math.max(...entries.map((entry) => entry.phase.length));
  for (const entry of entries) {
    lines.push(
      `    ${entry.phase.padEnd(width)}  ${verdictText(entry)} ${chalk.dim(`· ${entry.basis}`)}`,
    );
  }
  return lines;
}

/** Human view of one receipt: the two lanes and what it cannot prove. */
export function formatReceipt(receipt: ReceiptView): string[] {
  const lines: string[] = [];
  lines.push(
    chalk.bold(
      `[huginn] report · iter ${receipt.iteration}${receipt.profile ? ` · ${receipt.profile}` : ""}`,
    ),
  );
  const commits = [
    receipt.baseCommit && `base ${receipt.baseCommit.slice(0, 7)}`,
    receipt.headCommit && `head ${receipt.headCommit.slice(0, 7)}`,
    receipt.treeHash && `tree ${receipt.treeHash.slice(0, 7)}`,
  ].filter(Boolean);
  if (commits.length > 0) lines.push(`  commits   ${commits.join(" → ")}`);
  if (receipt.derived) {
    lines.push(
      chalk.dim("  lanes     derived from the phase names: this receipt predates the split"),
    );
  }
  lines.push("");
  lines.push(...laneLines("comprobado — the engine ran it", receipt.lanes.deterministic, "nothing was verified in this iteration"));
  lines.push("");
  lines.push(...laneLines("opinado — a model judged it", receipt.lanes.judgment, "no model-phase ran in this iteration"));
  if (receipt.unproven.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  no probado"));
    for (const claim of receipt.unproven) lines.push(chalk.dim(`    · ${claim}`));
  }
  return lines;
}

export function printReportUsage(): void {
  console.log(`huginn report — what one iteration's receipt proves, in two lanes

Usage:
  huginn report [--project <path>] [--iteration <n>] [--json] [--help]

Reads <project>/.huginn/receipts/iter-<n>.json (default: the newest) and splits
it into what the engine ran (deterministic), what a model judged (judgment) and
what the receipt cannot prove. Writes nothing and never calls a model.

Options:
  --project <path>    repository to inspect (default: cwd)
  --iteration <n>     read iter-<n>.json instead of the newest one
  --json              print the collected object instead of the summary
  --help, -h          show this help`);
}

export interface ReportIo {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

/** `huginn report` entry point. A missing receipt is reported, not thrown. */
export function handleReportCommand(
  args: Record<string, string | boolean | undefined>,
  io: ReportIo = {},
): void {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  if (args["--help"] || args["-h"]) {
    printReportUsage();
    return;
  }
  const projectPath = typeof args["--project"] === "string" ? resolve(args["--project"]) : process.cwd();
  const receipts = listReceipts(projectPath);
  if (receipts.length === 0) {
    error(`[huginn] report — no receipts under ${join(projectPath, RECEIPTS_SUBDIR)}`);
    process.exitCode = 1;
    return;
  }
  const requested =
    typeof args["--iteration"] === "string" ? Number(args["--iteration"]) : undefined;
  const chosen =
    requested !== undefined
      ? receipts.find((entry) => entry.iteration === requested)
      : receipts[0];
  if (!chosen) {
    error(`[huginn] report — no receipt for iteration ${requested}`);
    process.exitCode = 1;
    return;
  }
  const receipt = readReceipt(chosen.path, chosen.iteration);
  if (!receipt) {
    error(`[huginn] report — unreadable receipt: ${chosen.path}`);
    process.exitCode = 1;
    return;
  }
  if (args["--json"]) {
    log(JSON.stringify(receipt, null, 2));
    return;
  }
  for (const line of formatReceipt(receipt)) log(line);
}
