import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { stateSchema, type HarnessState, type HistoryEntry } from "./schema";
import { MAIN_PHASES, type PhaseName } from "../engine/types";
import { assertDocPath } from "../util/docPath";
import { sanitizeTerminalText } from "../util/text";
import { STATUS_GLYPHS, phaseGlyph, verdictGlyph } from "../tui/glyphs.js";
import { writeFileAtomic } from "../util/atomicWrite";

export function harnessDir(projectPath: string): string {
  return join(projectPath, ".harness");
}

export function statePath(projectPath: string): string {
  return join(harnessDir(projectPath), "state.json");
}

export function reportsDir(projectPath: string): string {
  return join(harnessDir(projectPath), "reports");
}

export function logsDir(projectPath: string): string {
  return join(harnessDir(projectPath), "logs");
}

export function computePlanHash(files: string[]): string {
  const h = createHash("sha256");
  for (const f of files) {
    let content = "";
    try {
      content = readFileSync(f, "utf8");
    } catch {
      content = "";
    }
    // hash the basename (not the absolute path) so the resume hash survives
    // the repo being moved or cloned to a different directory
    h.update(`${basename(f)}\0${content}\0`);
  }
  return h.digest("hex");
}

export function freshState(opts: {
  planHash: string;
  planPath: string;
  specPath: string;
  adrPath: string;
  thinker: string;
  executor: string;
  mode: "auto" | "supervised";
}): HarnessState {
  const now = new Date().toISOString();
  return {
    version: 1,
    planHash: opts.planHash,
    planPath: opts.planPath,
    specPath: opts.specPath,
    adrPath: opts.adrPath,
    models: { thinker: opts.thinker, executor: opts.executor },
    mode: opts.mode,
    currentIteration: 1,
    currentPhase: "SPEC_AUDIT",
    phaseAttempts: {},
    startedAt: now,
    updatedAt: now,
    history: [],
  };
}

export function loadState(projectPath: string): HarnessState | null {
  const p = statePath(projectPath);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return stateSchema.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt harness state at ${p}: ${(err as Error).message}`);
  }
}

/**
 * Persist the harness state (SEC-102).
 *
 * Fail-closed on the *path*: the state file is screened with the shared doc-path
 * helper, so a cloned repository shipping `.harness/state.json` (or the whole
 * `.harness`) as a symlink can make huginn neither truncate nor overwrite the
 * link's target — the write throws instead. The write itself is atomic on the
 * checked path: an exclusive temp file in the same directory, `renameSync`d into
 * place, the same pattern `state/liveSession.ts` uses for its store.
 */
export function saveState(projectPath: string, state: HarnessState): void {
  const p = assertDocPath(statePath(projectPath), {
    projectPath,
    label: "the harness state",
    action: "write",
  });
  mkdirSync(dirname(p), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileAtomic(p, JSON.stringify(state, null, 2) + "\n", 0o600);
}

/**
 * Write one phase report (SEC-102). Same containment and atomicity as
 * {@link saveState}: the report name is repository-reachable, so a link planted
 * at `.harness/reports/<name>.md` must never be written through.
 */
export function writeReport(
  projectPath: string,
  iteration: number,
  phase: PhaseName,
  attempt: number,
  content: string,
): string {
  const name = `${String(iteration).padStart(2, "0")}-${phase}-${attempt}.md`;
  const p = join(reportsDir(projectPath), name);
  const target = assertDocPath(p, {
    projectPath,
    label: "a phase report",
    action: "write",
  });
  mkdirSync(dirname(target), { recursive: true });
  writeFileAtomic(target, content, 0o600);
  return p;
}

const PHASE_LABEL: Record<string, { label: string }> = {
  SPEC_AUDIT: { label: "Spec Audit" },
  FIX_SPEC: { label: "Fix Spec deviations" },
  EXECUTE: { label: "Execute iteration" },
  VALIDATE_STEP: { label: "Validate step" },
  FIX_VALIDATE: { label: "Fix validation findings" },
  TEST_MODULE: { label: "Test module" },
  FIX_TEST: { label: "Fix test failures" },
  SECURE_CHECK: { label: "Secure check" },
  FIX_SECURITY: { label: "Fix security findings" },
  REVIEW: { label: "Code review" },
  FIX_REVIEW: { label: "Fix review findings" },
  DOC_SYNC: { label: "Doc sync" },
  COMMIT_ALL: { label: "Commit all" },
};

export function renderProgressMarkdown(projectPath: string, state: HarnessState): string {
  const byIteration = new Map<number, HistoryEntry[]>();
  for (const h of state.history) {
    const arr = byIteration.get(h.iteration) ?? [];
    arr.push(h);
    byIteration.set(h.iteration, arr);
  }
  const maxIter = Math.max(1, ...byIteration.keys());
  const lines: string[] = [];
  lines.push("# Harness Progress");
  lines.push("");
  lines.push(`- **Project**: \`${projectPath}\``);
  lines.push(`- **Started**: ${state.startedAt}`);
  lines.push(`- **Last update**: ${state.updatedAt}`);
  lines.push(`- **Models**: thinker \`${state.models.thinker}\`, executor \`${state.models.executor}\``);
  lines.push(`- **Mode**: ${state.mode}`);
  // A promotion failure is reported as itself, with the preserved branch and the
  // backup directory — never as an abort (AC-49.3). `🛑 ABORTED` stays reserved
  // for a run the user actually stopped.
  const promotion = state.promotion;
  const promotionFailed = promotion?.status === "conflict" || promotion?.status === "failed";
  const backupNote =
    promotion?.backups && promotion.backups.length > 0
      ? ` (untracked file(s) backed up under \`${promotion.backups
          .map((dir) => sanitizeTerminalText(dir))
          .join(", ")}\`)`
      : "";
  lines.push(
    promotionFailed && promotion
      ? `- **Status**: ${STATUS_GLYPHS.blocked} PROMOTION FAILED — branch \`${sanitizeTerminalText(
          promotion.branch,
        )}\` preserved${backupNote}${state.finishedAt ? ` (${state.finishedAt})` : ""}`
      : state.finishedAt
        ? `- **Status**: ${
            state.aborted ? `${STATUS_GLYPHS.blocked} ABORTED` : `${STATUS_GLYPHS.pass} COMPLETED`
          } (${state.finishedAt})`
        : `- **Status**: > RUNNING — current iteration ${state.currentIteration}, phase \`${state.currentPhase}\``,
  );
  lines.push("");

  for (let i = 1; i <= maxIter; i++) {
    const entries = byIteration.get(i) ?? [];
    lines.push(`## Iteration ${i}`);
    if (entries.length === 0) {
      lines.push(`- ${STATUS_GLYPHS.pending} pending`);
      continue;
    }
    const mainPhaseSet = new Set<string>(MAIN_PHASES);
    const done = entries.filter(
      (e) =>
        (e.verdict === "pass" || e.verdict === "warning" || e.verdict === "skipped") &&
        mainPhaseSet.has(e.phase),
    ).length;
    const phaseCount = MAIN_PHASES.length;
    lines.push(`- Phase progress: ${done}/${phaseCount}`);
    for (const e of entries) {
      const meta = PHASE_LABEL[e.phase] ?? { label: e.phase };
      // Single-width glyphs, shared with the TUI (REQ-52 / ADR-51).
      const mark = e.verdict ? verdictGlyph(e.verdict) : STATUS_GLYPHS.running;
      lines.push(
        `- ${mark} ${phaseGlyph(e.phase)} **${meta.label}** (attempt ${e.attempt}, ${e.model}) — ${e.summary}`,
      );
      if (e.reportPath) lines.push(`  - report: \`${e.reportPath}\``);
    }
    lines.push("");
  }

  const out = join(harnessDir(projectPath), "PROGRESS.md");
  // SEC-102: same containment as `saveState` — a cloned repository must not be
  // able to make the progress page overwrite a file outside the project by
  // shipping `.harness/PROGRESS.md` (or `.harness`) as a symlink.
  const target = assertDocPath(out, {
    projectPath,
    label: "the progress page",
    action: "write",
  });
  mkdirSync(dirname(target), { recursive: true });
  writeFileAtomic(target, lines.join("\n"), 0o600);
  return out;
}

export function clearStaleHarness(projectPath: string): void {
  const dir = harnessDir(projectPath);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export { mkdirSync };
