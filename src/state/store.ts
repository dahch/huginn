import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { stateSchema, type HarnessState, type HistoryEntry } from "./schema";
import { MAIN_PHASES, type PhaseName } from "../engine/types";

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

export function saveState(projectPath: string, state: HarnessState): void {
  const p = statePath(projectPath);
  mkdirSync(dirname(p), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, p);
}

export function writeReport(
  projectPath: string,
  iteration: number,
  phase: PhaseName,
  attempt: number,
  content: string,
): string {
  const dir = reportsDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const name = `${String(iteration).padStart(2, "0")}-${phase}-${attempt}.md`;
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const PHASE_LABEL: Record<string, { label: string; icon: string }> = {
  SPEC_AUDIT: { label: "Spec Audit", icon: "🔍" },
  FIX_SPEC: { label: "Fix Spec deviations", icon: "🧠" },
  EXECUTE: { label: "Execute iteration", icon: "⚡" },
  VALIDATE_STEP: { label: "Validate step", icon: "🚦" },
  FIX_VALIDATE: { label: "Fix validation findings", icon: "🧠" },
  TEST_MODULE: { label: "Test module", icon: "🧪" },
  FIX_TEST: { label: "Fix test failures", icon: "🧠" },
  SECURE_CHECK: { label: "Secure check", icon: "🔐" },
  FIX_SECURITY: { label: "Fix security findings", icon: "🧠" },
  REVIEW: { label: "Code review", icon: "👀" },
  FIX_REVIEW: { label: "Fix review findings", icon: "🧠" },
  DOC_SYNC: { label: "Doc sync", icon: "📝" },
  COMMIT_ALL: { label: "Commit all", icon: "📦" },
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
  lines.push(
    state.finishedAt
      ? `- **Status**: ${state.aborted ? "🛑 ABORTED" : "✅ COMPLETED"} (${state.finishedAt})`
      : `- **Status**: ▶ RUNNING — current iteration ${state.currentIteration}, phase \`${state.currentPhase}\``,
  );
  lines.push("");

  for (let i = 1; i <= maxIter; i++) {
    const entries = byIteration.get(i) ?? [];
    lines.push(`## Iteration ${i}`);
    if (entries.length === 0) {
      lines.push("- ⏳ pending");
      continue;
    }
    const mainPhaseSet = new Set<string>(MAIN_PHASES);
    const done = entries.filter(
      (e) => (e.verdict === "pass" || e.verdict === "warning") && mainPhaseSet.has(e.phase),
    ).length;
    const phaseCount = MAIN_PHASES.length;
    lines.push(`- Phase progress: ${done}/${phaseCount}`);
    for (const e of entries) {
      const meta = PHASE_LABEL[e.phase] ?? { label: e.phase, icon: "•" };
      const mark =
        e.verdict === "pass" ? "✅" : e.verdict === "warning" ? "🟡" : e.verdict === "blocked" ? "🔴" : "🔵";
      lines.push(`- ${mark} ${meta.icon} **${meta.label}** (attempt ${e.attempt}, ${e.model}) — ${e.summary}`);
      if (e.reportPath) lines.push(`  - report: \`${e.reportPath}\``);
    }
    lines.push("");
  }

  const out = join(harnessDir(projectPath), "PROGRESS.md");
  mkdirSync(harnessDir(projectPath), { recursive: true });
  writeFileSync(out, lines.join("\n"));
  return out;
}

export function clearStaleHarness(projectPath: string): void {
  const dir = harnessDir(projectPath);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export { mkdirSync };
