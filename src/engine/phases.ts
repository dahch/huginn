import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { formatModel, type Models } from "./modelRouter";
import type { PromptResult } from "./agent/types.js";
import type { RuntimeSession } from "./agent/port.js";
import { pendingChanges, changedFilesSince, isGitRepo } from "./diff";
import { commitAllPending, WorktreeError } from "./worktree";
import { deterministicCommitMessage } from "./steps/commitMessage";
import { recordAdrsAsDecisions, recordIterationObservation } from "./memory/index";
import type { Iteration } from "../plan/types";
import {
  verifyTypeScriptContracts,
  formatDiagnosticsReport,
} from "@dahch/muninn";
import { indexFilesIntoMuninn } from "@dahch/muninn";
import { MemoryService } from "@dahch/muninn";
import { resolveDatabasePath } from "@dahch/muninn";
import {
  type StepContext,
  specAuditPrompt,
  executePrompt,
  testModulePrompt,
  secureCheckPrompt,
  reviewPrompt,
  docSyncPrompt,
  commitAllPrompt,
  diagnoseFindingsPrompt,
  fixFindingsPrompt,
  repairPromotionPrompt,
  validateStepPrompt,
  parseAuditStatus,
} from "./steps/index.js";
import { parseSpecAuditVerdict } from "./gate";
import { formatVerificationReport, runVerification } from "./verify.js";
import type { Verdict } from "./types";

/**
 * What a phase returns to the engine: the `text` for the human report plus,
 * where huginn computes it itself, a **structured** verdict.
 *
 * `authoritativeVerdict` exists so the engine never has to re-derive a gate
 * decision from the model's prose (REV-101): `CycleEngine.runPhase` prefers this
 * field over parsing the report text, so a report whose wording contradicts its
 * own gate line cannot change the effective verdict.
 */
export interface PhaseOutput extends PromptResult {
  authoritativeVerdict?: GateVerdict;
  /**
   * Set by `VERIFY` when a command died from a signal instead of returning an
   * exit status. A crash is an environment failure, not a failing expectation:
   * the engine must not spend fix rounds asking the thinker to "fix" it.
   */
  crash?: { command: string; signal: string };
}

export interface PhaseContext extends StepContext {
  client?: OpencodeClient;
  session?: RuntimeSession;
  sessionId: string;
  models: Models;
  phaseTimeoutMs: number;
  /** `false` disables the deterministic `VERIFY` phase (`--no-verify`). */
  verify?: boolean;
}

/** The sandbox-scoped directory every prompt should run against. */
function agentDirectory(ctx: PhaseContext): string {
  return ctx.directory ?? ctx.projectPath;
}

/**
 * The single seam every step's prompt goes through (REQ-7): huginn composes the
 * instruction text itself (see `./steps`) and sends it as a **prompt**. Subprocess
 * runtimes get a plain prompt, and the opencode SDK path only ever carries an
 * optional `agent` (used for the built-in `build` agent's tooling) — never a
 * slash command resolved from `~/.config/opencode`.
 */
async function promptWithContext(
  ctx: PhaseContext,
  opts: {
    text: string;
    agent?: "build";
    model?: { providerID: string; modelID: string };
    timeoutMs?: number;
    directory?: string;
  },
): Promise<PromptResult> {
  if (!ctx.session) {
    throw new Error("No agent session available for this step");
  }
  // One seam, one shape: every step is a port prompt. A driver that owns a
  // daemon or a subprocess is behind the same call, and the engine never sees
  // which one it is.
  return ctx.session.prompt({
    text: opts.text,
    agent: opts.agent,
    model: opts.model ? formatModel(opts.model) : undefined,
    timeoutMs: opts.timeoutMs,
    directory: opts.directory,
  });
}

export async function specAudit(ctx: PhaseContext): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: specAuditPrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function execute(ctx: PhaseContext): Promise<PromptResult> {
  // `agent: "build"` is opencode's built-in coding agent: keeping it lets the
  // SDK session use the build agent's tools. Subprocess runtimes ignore `agent`
  // and receive the same prompt text.
  return promptWithContext(ctx, {
    text: executePrompt(ctx),
    agent: "build",
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

/**
 * `VERIFY` — deterministic proof that the increment works.
 *
 * The plan declares one or more non-interactive commands; huginn runs them in the
 * iteration's sandbox and gates on the real exit codes, so "it works" is not a
 * model's opinion. A plan without `Verification:` stays compatible: the phase
 * passes with a note and the existing QA/validation gates apply.
 */
export async function verifyIteration(ctx: PhaseContext): Promise<PhaseOutput> {
  const commands = ctx.iteration.verification ?? [];
  const disabled =
    ctx.verify === false
      ? "Verification is disabled for this run (`--no-verify` / `verify: false`)."
      : undefined;

  if (commands.length === 0) {
    return {
      messageId: "verification",
      text: [
        `# Verification — Iteration ${ctx.iteration.index}`,
        "",
        disabled ?? "No `Verification:` commands were declared by this plan.",
        "The increment is gated by the existing QA / validation phases instead.",
        "",
        "### Verification status: PASS (nothing to run)",
      ].join("\n"),
      authoritativeVerdict: "pass",
    };
  }

  if (disabled) {
    return {
      messageId: "verification",
      text: [
        `# Verification — Iteration ${ctx.iteration.index}`,
        "",
        disabled,
        `${commands.length} command(s) were declared but not executed.`,
        "",
        "### Verification status: PASS (disabled)",
      ].join("\n"),
      authoritativeVerdict: "pass",
    };
  }

  const result = await runVerification(commands, {
    cwd: ctx.projectPath,
    timeoutMs: ctx.phaseTimeoutMs,
  });
  const crashed = result.results.find((command) => command.crashed);
  return {
    messageId: "verification",
    text: formatVerificationReport(ctx.iteration, result),
    authoritativeVerdict: result.ok ? "pass" : "blocked",
    ...(crashed
      ? { crash: { command: crashed.command, signal: crashed.signal ?? "signal" } }
      : {}),
  };
}

const EXCLUDED_SCAN_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

export function isIgnoredDirectory(dirName: string): boolean {
  return EXCLUDED_SCAN_DIRS.has(dirName) || dirName.startsWith(".");
}

function scanDirectoryForSourceFiles(dir: string, fileSet: Set<string>): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isIgnoredDirectory(entry.name)) {
          continue;
        }
        scanDirectoryForSourceFiles(path.join(dir, entry.name), fileSet);
      } else if (entry.isFile()) {
        if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
          fileSet.add(path.join(dir, entry.name));
        }
      }
    }
  } catch {
    // ignore read error
  }
}

export function getIterationFiles(projectPath: string, modules: string[]): string[] {
  const fileSet = new Set<string>();
  for (const m of modules) {
    const fullPath = path.resolve(projectPath, m);

    // Path traversal containment for modules (REV-002)
    const rel = path.relative(projectPath, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }

    if (!existsSync(fullPath)) continue;
    try {
      const stat = statSync(fullPath);
      if (stat.isFile()) {
        if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(fullPath)) {
          fileSet.add(fullPath);
        }
      } else if (stat.isDirectory()) {
        // Exclude vendor & build directories in directory scan (REV-003)
        if (fullPath !== projectPath && isIgnoredDirectory(path.basename(fullPath))) {
          continue;
        }
        scanDirectoryForSourceFiles(fullPath, fileSet);
      }
    } catch {
      // ignore stat/read error
    }
  }

  // Also include any pending changes that are TypeScript / JavaScript (REV-001)
  try {
    const pending = pendingChanges(projectPath);
    for (const p of pending) {
      if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p)) {
        const fullPath = path.resolve(projectPath, p);
        const rel = path.relative(projectPath, fullPath);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          continue;
        }
        // Only include if file actually exists on disk (avoid false-positives on deleted/renamed files)
        if (existsSync(fullPath)) {
          fileSet.add(fullPath);
        }
      }
    }
  } catch {
    // ignore git error
  }

  return Array.from(fileSet);
}

// ---------------------------------------------------------------------------
// VALIDATE_STEP verdict — computed deterministically by huginn (REV-003 / M-4)
// ---------------------------------------------------------------------------

/** A gate verdict is a {@link Verdict} that is never "skipped". */
type GateVerdict = Exclude<Verdict, "skipped">;

const GATE_LINES: Record<GateVerdict, string> = {
  pass: "### Overall gate: 🟢 PASS",
  warning: "### Overall gate: 🟡 PASS WITH WARNINGS",
  blocked: "### Overall gate: 🔴 BLOCKED",
};

const HANDOFF_LINES: Record<GateVerdict, string> = {
  pass: "✅ AUTO-APPROVED — no action required, continuing to next step.",
  warning: "⚠️ REVIEW REQUESTED — address the items above before continuing.",
  blocked: "🛑 BLOCKED — do not proceed until issues are resolved and /validate-step is re-run.",
};

const GATE_SEVERITY: Record<GateVerdict, number> = { pass: 1, warning: 2, blocked: 3 };

function severest(a: GateVerdict, b: GateVerdict): GateVerdict {
  return GATE_SEVERITY[a] >= GATE_SEVERITY[b] ? a : b;
}

const VERDICT_BY_MARKER: Record<string, GateVerdict> = {
  "🔴": "blocked",
  "🟡": "warning",
  "🟢": "pass",
};

/**
 * The canonical marker lines huginn's own contracts mandate, anchored at the
 * start of a line (optionally after markdown decoration). Leading `#`/`>`/`*`/`-`
 * are tolerated, an inline code span or prose mention is not.
 */
const CANONICAL_GATE_LINE_RE = /^[ \t>*#-]*###[ \t]*Overall gate:[ \t]*(🔴|🟡|🟢)/gim;
const CANONICAL_FIDELITY_LINE_RE = /^[ \t>*#-]*###[ \t]*Overall fidelity:[ \t]*(🔴|🟡|🟢)/gim;

/**
 * The verdict carried by the **last** canonical marker line of `text`, or `null`
 * when the report has none.
 *
 * `parseValidateStepVerdict`/`parseSpecAuditVerdict` (gate.ts, unchanged) merge
 * *every* severity emoji anywhere in the body, so the `🟢 … / 🟡 … / 🔴 …`
 * skeletons huginn's own prompts carry — and any 🔴 bullet in the prose — would
 * escalate an otherwise-green report forever (REV-101/REV-102). Only the report's
 * own conclusion line, the last one it emitted, may decide, and only via its
 * leading marker (never a later emoji in the same line).
 */
function lastCanonicalMarkerVerdict(text: string, pattern: RegExp): GateVerdict | null {
  pattern.lastIndex = 0;
  let marker: string | undefined;
  for (const match of text.matchAll(pattern)) marker = match[1];
  return marker ? VERDICT_BY_MARKER[marker] ?? null : null;
}

/** The verdict of the last canonical `### Overall gate:` line, if any (REV-101). */
export function parseCanonicalGateLineVerdict(text: string): GateVerdict | null {
  return lastCanonicalMarkerVerdict(text, CANONICAL_GATE_LINE_RE);
}

/** The verdict of the last canonical `### Overall fidelity:` line, if any (REV-102). */
export function parseCanonicalFidelityVerdict(text: string): GateVerdict | null {
  return lastCanonicalMarkerVerdict(text, CANONICAL_FIDELITY_LINE_RE);
}

/**
 * Deterministic, fail-closed verdict for the ONE validate-step report
 * (REV-003 / M-4): both mandatory conclusion lines are required — an empty
 * report, or a missing/unreadable `### Overall fidelity:` or `### Audit status:`
 * marker, is `blocked`; any blocked signal is `blocked`; any warning is
 * `warning`; only two green lines pass.
 *
 * Each line is read from its canonical conclusion when the report has one
 * (REV-101/REV-102): the role instructions' illustrative skeletons carry all
 * three emoji, so the whole-body parsers are only the fallback for a report that
 * omits the line.
 */
export function computeValidateVerdict(report: string): GateVerdict {
  if (report.trim() === "") return "blocked";
  const fidelity = parseFidelityVerdict(report);
  const audit = parseAuditStatus(report);
  if (fidelity === null || audit === null || audit === "skipped") return "blocked";
  return severest(fidelity, audit);
}

/**
 * The report's fidelity verdict.
 *
 * The whole-body `parseSpecAuditVerdict` escalates on any 🟢/🟡/🔴 glyph, so on
 * its own it would read the `### Audit status: 🟢 PASS` line as a green fidelity
 * verdict and let a report that never audited fidelity pass. The fallback is
 * therefore only consulted when the report actually talks about fidelity.
 */
function parseFidelityVerdict(report: string): GateVerdict | null {
  const canonical = parseCanonicalFidelityVerdict(report);
  if (canonical !== null) return canonical;
  if (/overall fidelity|major deviation|minor drift|\baligned\b/i.test(report)) {
    const fallback = parseSpecAuditVerdict(report);
    return fallback === "skipped" ? null : fallback;
  }
  return null;
}

const GATE_LINE_RE = /^[#>\s]*Overall gate:.*$/gim;
const HANDOFF_LINE_RE = /^[#>\s]*(?:✅|⚠️|🛑).*$/gim;

/**
 * Overwrite the synthesis output's verdict lines with huginn's computed verdict
 * (REV-003 / M-4). The synthesis is kept for the human report, but every
 * pre-existing `### Overall gate:` line and handoff marker is stripped and the
 * canonical lines for `verdict` appended, so the engine — not the model —
 * decides and `parseValidateStepVerdict` (gate.ts, unchanged) reads it back.
 */
export function enforceValidateVerdict(text: string, verdict: GateVerdict): string {
  const body = text
    .replace(GATE_LINE_RE, "")
    .replace(HANDOFF_LINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const trailer = `${GATE_LINES[verdict]}\n${HANDOFF_LINES[verdict]}`;
  return body.length > 0 ? `${body}\n\n${trailer}` : trailer;
}

/**
 * `VALIDATE_STEP` — huginn-orchestrated gate (REQ-7).
 *
 * One increment audit answers the two questions a gate needs — acceptance
 * coverage and spec fidelity — and ends on the two mandatory markers
 * (`### Overall fidelity:` and `### Audit status:`). huginn merges them itself
 * (see {@link computeValidateVerdict}) and imposes the canonical gate line and
 * handoff marker on the report (see {@link enforceValidateVerdict}), so the
 * model's own verdict wording survives only as prose. The effective verdict
 * travels as the structural `authoritativeVerdict` (REV-101) and the engine
 * gates on that field — never on the text.
 *
 * QA and security are not re-run here: `TEST_MODULE` and `SECURE_CHECK` own
 * those phases, and the previous four-turn orchestration only paid for them
 * twice.
 */
export async function validateStep(ctx: PhaseContext): Promise<PhaseOutput> {
  // Contract verification (fail closed — REV-114): a real violation, or a
  // verifier that could not run, short-circuits the whole gate.
  const contractFailure = verifyContractsOrFail(ctx.projectPath, ctx.modules);
  if (contractFailure) return contractFailure;

  const result = await promptWithContext(ctx, {
    text: validateStepPrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });

  const verdict = computeValidateVerdict(result.text);
  return {
    ...result,
    text: enforceValidateVerdict(result.text, verdict),
    authoritativeVerdict: verdict,
  };
}

/**
 * The fail-closed output for a `VALIDATE_STEP` short-circuit (compiler contract
 * violation, or verification that could not run): a report the human can read
 * plus the structural verdict the engine gates on.
 */
function contractFailureOutput(report: string): PhaseOutput {
  return {
    messageId: "contract-compiler-failure",
    text: report,
    raw: {
      info: { id: "contract-compiler-failure" },
      parts: [{ type: "text", text: report }],
    },
    authoritativeVerdict: "blocked",
  };
}

/**
 * Runs the TypeScript contract verification for one iteration and returns the
 * fail-closed output when it cannot pass — a real violation, or a verifier that
 * threw. `null` means "nothing to report" (nothing to check, or valid).
 *
 * The verifier is injectable so this failure path is testable without module
 * mocking (both test runners reject `vi.mock` factory signatures — REV-114).
 */
export function verifyContractsOrFail(
  projectPath: string,
  modules: string[],
  verify: typeof verifyTypeScriptContracts = verifyTypeScriptContracts,
): PhaseOutput | null {
  try {
    const iterationFiles = getIterationFiles(projectPath, modules);
    if (iterationFiles.length > 0) {
      const contractResult = verify(projectPath, iterationFiles);
      if (!contractResult.valid && contractResult.errorsCount > 0) {
        return contractFailureOutput(formatDiagnosticsReport(contractResult));
      }
    }
  } catch (err) {
    // Contract verification failing is not the model's call to make: report it
    // (HUGINN_DEBUG) and fail closed, instead of silently degrading the gate to
    // an agent-judged pass (REV-114).
    if (process.env.HUGINN_DEBUG) {
      console.error(
        "[huginn] TypeScript contract verification failed (non-fatal, fail-closed):",
        err instanceof Error ? err.message : String(err),
      );
    }
    return contractFailureOutput(
      formatDiagnosticsReport({
        valid: false,
        errorsCount: 1,
        diagnostics: [
          {
            filePath: "tsconfig.json",
            line: 1,
            character: 1,
            code: "TS0000",
            category: "error",
            message: `TypeScript contract verification could not run: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
      }),
    );
  }
  return null;
}

export async function testModule(ctx: PhaseContext): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: testModulePrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function secureCheck(ctx: PhaseContext): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: secureCheckPrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function review(ctx: PhaseContext): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: reviewPrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function docSync(ctx: PhaseContext): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: docSyncPrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function commitAll(ctx: PhaseContext): Promise<PromptResult> {
  // Indexing moved out of this phase: it must run only after the iteration has
  // been promoted, or a failed promotion would leave the durable symbol graph
  // describing files that never reached the primary tree. See
  // `indexIterationSourceFiles`, called by `CycleEngine` post-promotion.
  return promptWithContext(ctx, {
    text: commitAllPrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

/**
 * `COMMIT_ALL`, deterministic: no model turn (REQ-63).
 *
 * The message is derived from the iteration and the changed paths, so the same
 * increment always produces the same commit and no plan text enters permanent
 * history. A git failure is reported here but not thrown: the pre-promotion
 * checkpoint re-attempts the same hardened commit and fails closed there, so the
 * failure surfaces once, honestly, instead of as a silent "pass".
 */
export async function commitAllDeterministic(ctx: PhaseContext): Promise<PromptResult> {
  const repoPath = agentDirectory(ctx);
  if (!isGitRepo(repoPath)) {
    return {
      messageId: "deterministic-commit",
      text: [
        "### Commit status: 🔴 FAILED",
        "",
        `${repoPath} is not a git work tree, so the increment cannot be committed.`,
        "The pre-promotion checkpoint re-attempts it and fails closed.",
      ].join("\n"),
    };
  }
  const changedPaths = pendingChanges(repoPath);
  const message = deterministicCommitMessage({
    iteration: ctx.iteration,
    totalIterations: ctx.totalIterations ?? ctx.iteration.index,
    profile: ctx.profile ?? "huginn",
    changedPaths,
  });

  if (changedPaths.length === 0) {
    return {
      messageId: "deterministic-commit",
      text: "### Commit status: 🟢 nothing to commit\n\nThe working tree is already clean.",
    };
  }

  try {
    const result = commitAllPending(repoPath, message);
    const sha = result.commit?.slice(0, 7) ?? "(none)";
    return {
      messageId: "deterministic-commit",
      text: [
        "### Commit status: 🟢 committed",
        "",
        `- commit: ${sha}`,
        `- subject: ${message.split("\n")[0]}`,
        `- files: ${changedPaths.length}`,
      ].join("\n"),
    };
  } catch (err) {
    const detail = err instanceof WorktreeError || err instanceof Error ? err.message : String(err);
    return {
      messageId: "deterministic-commit",
      text: [
        "### Commit status: 🔴 FAILED",
        "",
        `git refused the commit: ${detail}`,
        "",
        "The pre-promotion checkpoint re-attempts it and fails closed if git still refuses.",
      ].join("\n"),
    };
  }
}

/**
 * Index an iteration's changed source files into Muninn's durable symbol graph.
 *
 * Best-effort and non-blocking, but never silent (AC-30.5): `HUGINN_DEBUG`
 * surfaces why the graph was not updated. Memory is durable state that must
 * outlive an ephemeral sandbox, so the project root and database path resolve
 * from the PRIMARY project while the files are read from the promoted tree.
 */
export function indexIterationSourceFiles(opts: {
  projectPath: string;
  baseCommit?: string;
  primaryProjectRoot: string;
  dbPath?: string;
}): void {
  try {
    let modified: string[] = [];
    try {
      modified = opts.baseCommit
        ? changedFilesSince(opts.projectPath, opts.baseCommit)
        : pendingChanges(opts.projectPath);
    } catch {
      // ignore git error
    }

    const sourceFiles = Array.from(new Set(modified)).filter(
      (file) =>
        /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file) &&
        existsSync(path.resolve(opts.projectPath, file)),
    );
    if (sourceFiles.length === 0) return;

    const muninnRoot = opts.primaryProjectRoot;
    const resolvedDbPath = resolveDatabasePath(opts.dbPath, muninnRoot);
    const memoryService = new MemoryService({ projectRoot: muninnRoot, dbPath: resolvedDbPath });
    try {
      indexFilesIntoMuninn(memoryService, sourceFiles, { projectRoot: opts.projectPath });
    } finally {
      memoryService.close?.();
    }
  } catch (err) {
    if (process.env.HUGINN_DEBUG) {
      console.error(
        "[huginn] Muninn post-promotion indexing failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Persist every ADR section as a `decision` observation (REQ-64).
 *
 * Best-effort exactly like indexing: no file, no database or a query failure is
 * a no-op, and the reason is only printed under `HUGINN_DEBUG`. Called after the
 * ADR document is written, from `plan` and `live`.
 */
export function saveAdrDecisions(opts: {
  adrPath: string;
  primaryProjectRoot: string;
  dbPath?: string;
}): { saved: number; updated: number; unchanged: number; skipped: number } {
  try {
    const result = recordAdrsAsDecisions({
      adrPath: opts.adrPath,
      projectRoot: opts.primaryProjectRoot,
      dbPath: opts.dbPath ?? resolveDatabasePath(undefined, opts.primaryProjectRoot),
    });
    return {
      saved: result.saved,
      updated: result.updated,
      unchanged: result.unchanged,
      skipped: result.skipped,
    };
  } catch (err) {
    if (process.env.HUGINN_DEBUG) {
      console.error(
        "[huginn] Muninn ADR decisions failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
    return { saved: 0, updated: 0, unchanged: 0, skipped: 0 };
  }
}

/**
 * Curate one observation for a promoted increment (REQ-65).
 *
 * Runs after indexing, so the changed files exist as entities and can be linked.
 * Fail-open: memory can never turn a successful promotion into a failure.
 */
export function recordIterationMemory(opts: {
  primaryProjectRoot: string;
  dbPath?: string;
  iteration: Iteration;
  baseCommit?: string;
  verdicts: Array<{ phase: string; verdict?: string }>;
  commit?: string | null;
}): void {
  try {
    const files = opts.baseCommit
      ? changedFilesSince(opts.primaryProjectRoot, opts.baseCommit)
      : pendingChanges(opts.primaryProjectRoot);
    recordIterationObservation({
      projectRoot: opts.primaryProjectRoot,
      dbPath: opts.dbPath,
      iteration: opts.iteration,
      verdicts: opts.verdicts,
      filesChanged: files,
      commit: opts.commit,
    });
  } catch (err) {
    if (process.env.HUGINN_DEBUG) {
      console.error(
        "[huginn] Muninn iteration curation failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * What the architect diagnosed for a blocked gate: a deterministic plan of exact
 * edits and/or the judge's structured action items. `fixFindings` forwards both
 * to the executor's prompt.
 */
export interface Remediation {
  plan?: string;
  actionItems?: string[];
}

/**
 * `DIAGNOSE` — the `thinker` root-causes a blocked gate in READ-ONLY mode and
 * emits a Remediation Plan. No `agent: "build"`: the architect never gets the
 * editing toolset, and the engine additionally guards the working tree.
 */
export async function diagnoseFindings(
  ctx: PhaseContext,
  label: string,
  report: string,
  extraInstructions?: string,
  actionItems?: string[],
): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: diagnoseFindingsPrompt(ctx, label, report, { extraInstructions, actionItems }),
    model: ctx.models.thinker,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

/**
 * `APPLY_FIX` — the `executor` applies the remediation. Every `FIX_*` gate is
 * build work, so it always runs on the executor model with the build agent's
 * toolset; the architect's plan (when there is one) is passed through verbatim.
 */
export async function fixFindings(
  ctx: PhaseContext,
  label: string,
  report: string,
  extraInstructions?: string,
  remediation?: Remediation,
): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: fixFindingsPrompt(ctx, label, report, extraInstructions, remediation),
    agent: "build",
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

/**
 * `REPAIR_PROMOTION` — the `executor` resolves the conflicts of the merge huginn
 * started between the primary branch and the iteration's preserved branch
 * (ADR-62). It edits files only: huginn aborts, commits and promotes.
 */
export async function repairPromotionFindings(
  ctx: PhaseContext,
  opts: { detail: string; conflicts: string[]; head: string; plan?: string },
): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: repairPromotionPrompt(ctx, opts),
    agent: "build",
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function fixSpec(
  ctx: PhaseContext,
  report: string,
  remediation?: Remediation,
): Promise<PromptResult> {
  return fixFindings(
    ctx,
    "spec audit",
    report,
    "Decide per finding whether to (A) implement the spec as written (preferred) or (B) — only if the spec is objectively wrong — align the spec. Do not silently drop findings.",
    remediation,
  );
}

export async function fixSecurity(
  ctx: PhaseContext,
  report: string,
  remediation?: Remediation,
): Promise<PromptResult> {
  return fixFindings(
    ctx,
    "security audit",
    report,
    "Absolute requirement: every single breach must be fixed. Do not advance past any security issue.",
    remediation,
  );
}
