import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { formatModel, type Models } from "./modelRouter";
import { prompt } from "../server/client";
import type { IAgentSession, PromptResult } from "./agent/types.js";
import { pendingChanges, changedFilesSince } from "./diff";
import {
  verifyTypeScriptContracts,
  formatDiagnosticsReport,
} from "../contracts/compiler.js";
import { indexFilesIntoMuninn } from "../muninn/indexer/ast-indexer.js";
import { MemoryService } from "../muninn/service/memory-service.js";
import { resolveDatabasePath } from "../muninn/db/client.js";
import {
  type StepContext,
  specAuditPrompt,
  executePrompt,
  testModulePrompt,
  secureCheckPrompt,
  reviewPrompt,
  docSyncPrompt,
  commitAllPrompt,
  fixFindingsPrompt,
  validateStepSubPrompts,
  validateStepSynthesisPrompt,
  parseAuditStatus,
  type ValidateStepReports,
} from "./steps/index.js";
import { parseSpecAuditVerdict } from "./gate";
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
}

export interface PhaseContext extends StepContext {
  client?: OpencodeClient;
  session?: IAgentSession;
  sessionId: string;
  models: Models;
  /**
   * Explicit SQLite database path for Muninn persistence. When sandboxing,
   * callers pass the PRIMARY project database so indexed symbols survive
   * worktree cleanup. When omitted, `resolveDatabasePath` resolves the git root
   * of {@link primaryProjectRoot} (falling back to `~/.huginn/muninn.db`).
   */
  dbPath?: string;
  /**
   * Canonical project root Muninn should attribute entities/observations to.
   * Under sandboxing this is the primary project root while `projectPath` is
   * the ephemeral worktree, so symbols are linked to the durable project
   * record rather than a throwaway worktree root. Falls back to
   * {@link projectPath} when omitted.
   */
  primaryProjectRoot?: string;
  phaseTimeoutMs: number;
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
    agent?: string;
    model?: { providerID: string; modelID: string };
    timeoutMs?: number;
    directory?: string;
  },
): Promise<PromptResult> {
  if (ctx.session) {
    return ctx.session.prompt(opts.text, {
      agent: opts.agent,
      model: opts.model ? formatModel(opts.model) : undefined,
      timeoutMs: opts.timeoutMs,
      directory: opts.directory,
    });
  }
  if (!ctx.client) {
    throw new Error("No agent session or OpenCode client available for prompt");
  }
  return prompt(ctx.client, ctx.sessionId, opts);
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
 * Deterministic, fail-closed verdict from the three sub-reports (REV-003 / M-4):
 * an empty or unreadable (no parseable marker) sub-report, or any blocked signal
 * from spec/qa/security, is `blocked`; any warning signal is `warning`; all green
 * is `pass`.
 *
 * The spec sub-report is read from its canonical
 * `### Overall fidelity:` line when it has one (REV-102): the spec-auditor role
 * instructions' illustrative skeleton carries all three emoji, and the
 * whole-body parser in gate.ts would read it as a MAJOR DEVIATION. The
 * whole-body parser is kept as the fallback for a report that omits the line.
 */
export function computeSubReportVerdict(reports: ValidateStepReports): GateVerdict {
  if (reports.qa.trim() === "" || reports.spec.trim() === "" || reports.security.trim() === "") {
    return "blocked";
  }
  const qa = parseAuditStatus(reports.qa);
  const spec = parseCanonicalFidelityVerdict(reports.spec) ?? parseSpecAuditVerdict(reports.spec);
  const security = parseAuditStatus(reports.security);
  // A report with no parseable status marker is unreadable → fail closed.
  if (qa === null || spec === null || security === null) return "blocked";
  if (qa === "blocked" || spec === "blocked" || security === "blocked") return "blocked";
  if (qa === "warning" || spec === "warning" || security === "warning") return "warning";
  return "pass";
}

/**
 * Merged `VALIDATE_STEP` verdict (REV-003 / M-4). The deterministic sub-report
 * verdict (see {@link computeSubReportVerdict}) is authoritative and fail-closed;
 * the synthesis is advisory and may only *escalate* it (e.g. a cross-phase
 * contradiction the reviewer spotted), never downgrade it. So a synthesis that
 * says 🟢 while security reports 🔴 stays blocked, but a 🟡 synthesis raises an
 * otherwise-green result to warning.
 *
 * Only the synthesis' **canonical `### Overall gate:` line** is read (REV-101):
 * the consolidation template huginn itself sends contains the three-emoji gate
 * skeleton and 🔴/🛑 bullets, so escalating on any emoji in the body would turn a
 * model that echoes the template into a spurious BLOCKED.
 */
export function computeValidateVerdict(
  reports: ValidateStepReports,
  synthesis = "",
): GateVerdict {
  const subVerdict = computeSubReportVerdict(reports);
  const synthVerdict = parseCanonicalGateLineVerdict(synthesis);
  if (synthVerdict === null) return subVerdict;
  return severest(subVerdict, synthVerdict);
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
 * Instead of delegating to the installed `/validate-step` slash command (which
 * opencode resolved through the Task tool and subprocess runtimes degraded to
 * literal text), huginn runs the three audits itself and then synthesizes the
 * consolidated report:
 *
 *   1. qa in `AUDIT-ONLY MODE`
 *   2. spec-auditor
 *   3. security
 *   4. a synthesis prompt that receives the three reports and emits the
 *      `### Overall gate:` line plus the trailing handoff marker.
 *
 * The returned text is the synthesis output with huginn's canonical gate line
 * and handoff marker imposed on it (see {@link enforceValidateVerdict}), so the
 * model's own verdict wording survives only as prose. The effective verdict
 * travels as the structural `authoritativeVerdict` huginn computed itself
 * (REV-101), and the engine gates on that field — never on the text.
 */
export async function validateStep(ctx: PhaseContext): Promise<PhaseOutput> {
  // 1. Contract verification (fail closed — REV-114): a real violation, or a
  // verifier that could not run, short-circuits the whole sub-gate.
  const contractFailure = verifyContractsOrFail(ctx.projectPath, ctx.modules);
  if (contractFailure) return contractFailure;

  // 2. The three audits, then a synthesis that consolidates them.
  const [qaPrompt, specPrompt, securityPrompt] = validateStepSubPrompts(ctx);
  const subOpts = {
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  };
  const qa = await promptWithContext(ctx, { text: qaPrompt, ...subOpts });
  const spec = await promptWithContext(ctx, { text: specPrompt, ...subOpts });
  const security = await promptWithContext(ctx, { text: securityPrompt, ...subOpts });

  const synthesis = validateStepSynthesisPrompt(ctx, {
    qa: qa.text,
    spec: spec.text,
    security: security.text,
  });
  const synthesisResult = await promptWithContext(ctx, { text: synthesis, ...subOpts });

  // huginn computes the gate verdict deterministically from the three reports
  // (REV-003 / M-4) — it is never left to the synthesis model. The synthesis is
  // advisory: it may escalate but never downgrade the fail-closed result.
  const verdict = computeValidateVerdict(
    { qa: qa.text, spec: spec.text, security: security.text },
    synthesisResult.text,
  );

  // The synthesis is produced for the human report, but huginn imposes the
  // result: the returned text carries exactly one coherent `### Overall gate:`
  // line and one handoff marker, so the engine (not the model) decides. The
  // effective verdict travels as a structured field (REV-101).
  return {
    ...synthesisResult,
    text: enforceValidateVerdict(synthesisResult.text, verdict),
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
  // Capture modified files before committing, because the commit step cleans the
  // working tree (REV-008)
  let preModified: string[] = [];
  try {
    preModified = ctx.baseCommit
      ? changedFilesSince(ctx.projectPath, ctx.baseCommit)
      : pendingChanges(ctx.projectPath);
  } catch {
    // ignore git error
  }

  const result = await promptWithContext(ctx, {
    text: commitAllPrompt(ctx),
    model: ctx.models.executor,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });

  // Post-execution: Automatically index modified files into Muninn AST symbol graph
  try {
    let postModified: string[] = [];
    try {
      if (ctx.baseCommit) {
        postModified = changedFilesSince(ctx.projectPath, ctx.baseCommit);
      }
    } catch {
      // ignore git error
    }

    const modifiedSet = new Set([...preModified, ...postModified]);
    const sourceFiles = Array.from(modifiedSet).filter(
      (f) =>
        /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f) &&
        existsSync(path.resolve(ctx.projectPath, f))
    );

    if (sourceFiles.length > 0) {
      // Memory is durable state that must outlive an ephemeral sandbox: the
      // database path and the project record entities are linked to must use
      // the PRIMARY project root, while the scan root stays the worktree where
      // the modified files live until the sandbox is promoted. Resolving through
      // `resolveDatabasePath` keeps this consistent with `CycleEngine`'s own
      // resolution (git root / explicit path) instead of a second convention.
      const muninnRoot = ctx.primaryProjectRoot ?? ctx.projectPath;
      const resolvedDbPath = resolveDatabasePath(ctx.dbPath, muninnRoot);
      const memoryService = new MemoryService({
        projectRoot: muninnRoot,
        dbPath: resolvedDbPath,
      });
      try {
        indexFilesIntoMuninn(memoryService, sourceFiles, {
          projectRoot: ctx.projectPath,
        });
      } finally {
        memoryService.close?.();
      }
    }
  } catch (err) {
    // Best-effort Muninn indexing: non-blocking, but never *silent* (AC-30.5) —
    // HUGINN_DEBUG surfaces why the symbol graph was not updated.
    if (process.env.HUGINN_DEBUG) {
      console.error(
        "[huginn] Muninn post-execution indexing failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

export async function fixFindings(
  ctx: PhaseContext,
  label: string,
  report: string,
  extraInstructions?: string,
): Promise<PromptResult> {
  return promptWithContext(ctx, {
    text: fixFindingsPrompt(ctx, label, report, extraInstructions),
    agent: "build",
    model: ctx.models.thinker,
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function fixSpec(ctx: PhaseContext, report: string): Promise<PromptResult> {
  return fixFindings(
    ctx,
    "spec audit",
    report,
    "Decide per finding whether to (A) implement the spec as written (preferred) or (B) — only if the spec is objectively wrong — align the spec. Do not silently drop findings.",
  );
}

export async function fixSecurity(ctx: PhaseContext, report: string): Promise<PromptResult> {
  return fixFindings(
    ctx,
    "security audit",
    report,
    "Absolute requirement: every single breach must be fixed. Do not advance past any security issue.",
  );
}
