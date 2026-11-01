import type { OpencodeClient } from "@opencode-ai/sdk";
import { join, relative } from "node:path";
import type { RunConfig } from "../config";
import type { Iteration } from "../plan/types";
import { resolveModels, formatModel, type Models } from "./modelRouter";
import {
  specAudit,
  execute,
  validateStep,
  testModule,
  verifyIteration,
  secureCheck,
  review,
  docSync,
  commitAll,
  commitAllDeterministic,
  diagnoseFindings,
  fixFindings,
  repairPromotionFindings,
  indexIterationSourceFiles,
  recordIterationMemory,
  fixSpec,
  fixSecurity,
  type PhaseContext,
  type Remediation,
} from "./phases";
import { parseValidateStepVerdict, parseSpecAuditVerdict, parseAuditGateVerdict, judgePhase } from "./gate";
import { profilePreamble, profileSpec, validateProfilePhases, type ProfileName } from "./profiles";
import { buildIterationReceipt, treeHash, writeIterationReceipt } from "./receipts";
import type { Verdict, PhaseName, PhaseResult, DecisionRequest, DecisionChoice } from "./types";
import { events } from "./engineEvents";
import { DecisionBroker } from "./decisionBroker";
import {
  headCommit,
  git,
  inferModules,
  isGitRepo,
  hasImplementationCode,
} from "./diff";
import {
  saveState,
  freshState,
  writeReport,
  renderProgressMarkdown,
  computePlanHash,
} from "../state/store";
import type { HarnessState, HistoryEntry, PromotionRecord, ResumeCursor } from "../state/schema";
import { WorktreeManager, sandboxBranch, sandboxPath, integrationBase, type Sandbox, type PromoteResult } from "./worktree";
import {
  promotionRepairEligibility,
  type PromotionRetryResult,
} from "./promotionRepair";
import { resolveDatabasePath } from "@dahch/muninn";
import type { RuntimePort, RuntimeSession } from "./agent/port.js";
import { asRuntimePort } from "./agent/legacy-bridge.js";
import type { IAgentRuntime } from "./agent/types.js";
import { createOpencodePort } from "./agent/drivers/opencode.js";
import { createRuntimeSink, addUsage } from "./runtimeEvents";
import { permissionHandlerFor } from "./permissionPolicy";
import { sanitizeTerminalText } from "../util/text.js";

/**
 * A phase's result as the engine consumes it: its report text plus, for phases
 * whose verdict huginn computes itself, the structured verdict (REV-101) and,
 * for a read-only phase that mutated the tree, huginn's forced BLOCKED.
 */
type PhaseFn = (ctx: PhaseContext) => Promise<{
  text: string;
  messageId: string;
  authoritativeVerdict?: Verdict;
  crash?: { command: string; signal: string };
}>;

/** A phase result plus the verdict fields the engine may have attached to it. */
type GatedPhaseResult = PhaseResult & {
  raw: string;
  forcedVerdict?: Verdict;
  authoritativeVerdict?: Verdict;
  /** `VERIFY` only: a command died from a signal (see `PhaseOutput.crash`). */
  crash?: { command: string; signal: string };
  /**
   * The judge's structured action items for a `judge`-gated phase. Kept on the
   * result so the remediation turn (architect and then executor) receives the
   * exact blocking items instead of re-deriving them from prose.
   */
  actionItems?: string[];
};

interface PipelineStep {
  phase: PhaseName;
  fn: PhaseFn;
  gate: "spec-audit" | "validate-step" | "judge" | "audit-status" | "none";
  fixPhase: PhaseName | null;
  fixLabel: string;
  blocking: boolean;
  /**
   * Auditor phases must not mutate the repository (REV-001). Enforced at
   * runtime by comparing a working-tree hash before and after the step, so the
   * guarantee does not depend on the agent's own permission configuration.
   */
  readOnly?: boolean;
}

/**
 * Whether a read-only phase's tree signature proves it did not write.
 *
 * Fail-closed on purpose (REV-103): a missing signature (`undefined` — git
 * failed, or the path is not a work tree) means "cannot prove nothing changed",
 * which must block, not pass. See {@link treeHash} for what the signature can
 * and cannot see: this guard is best-effort (a write-and-restore, or a write
 * outside the hashed work tree, is invisible to it) and is a backstop for the
 * sandboxed worktree, not a replacement for it.
 */
export function readOnlyTreeViolation(
  before: string | undefined,
  after: string | undefined,
): boolean {
  if (before === undefined || after === undefined) return true;
  return before !== after;
}

/**
 * huginn's own verdict for a phase result, or `undefined` when the engine has
 * no structural answer and must fall back to reading the report's markers
 * (REV-101).
 *
 * A read-only violation (REV-001) outranks the phase's own structured verdict:
 * the phase's report is discarded in that case, so its verdict cannot be
 * trusted either.
 */
export function resolveStructuralVerdict(result: {
  forcedVerdict?: Verdict;
  authoritativeVerdict?: Verdict;
}): Verdict | undefined {
  return result.forcedVerdict ?? result.authoritativeVerdict;
}

const GATE_SEVERITY: Record<Verdict, number> = { pass: 1, warning: 2, blocked: 3, skipped: 0 };

export interface GateInput {
  gate: PipelineStep["gate"];
  /** A blocking gate can escalate; a non-blocking one (`strict-tdd`'s test-first run) cannot. */
  blocking: boolean;
  /** huginn's own verdict (REV-101) — always wins. */
  structural?: Verdict;
  /** `audit-status`: the role's own marker, escalated by gate vocabulary. `null` = unreadable. */
  auditStatus?: Verdict | null;
  /** `spec-audit` / `validate-step` / legacy `judge`: the deterministic parser result. */
  parsed?: Verdict | null;
}

/**
 * The single source of truth for a step's gate verdict and whether the judge
 * turn is worth paying for.
 *
 * A model-graded prose report is expensive, and an LLM judge re-deriving what
 * the role already stated is pure waste on a green report. Each role therefore
 * ends on its own `### Audit status:` marker; the judge runs only when that
 * marker is non-pass (to extract structured action items) or missing (fail
 * closed). A structural verdict from huginn itself always outranks both.
 */
export function gateDecision(input: GateInput): { verdict: Verdict; judge: boolean } {
  if (input.structural) return { verdict: input.structural, judge: false };
  if (input.gate === "none") return { verdict: "pass", judge: false };
  if (input.gate === "judge") return { verdict: input.parsed ?? "blocked", judge: true };
  if (input.gate === "spec-audit" || input.gate === "validate-step") {
    return { verdict: input.parsed ?? "blocked", judge: false };
  }
  // `audit-status`: the role's own line decides when it is green. A non-blocking
  // test-first run records its marker but never pays for a judge, because its
  // action items are unconsumable (`fixPhase === null`).
  const marker = input.auditStatus ?? null;
  if (!input.blocking) return { verdict: marker ?? "blocked", judge: false };
  if (marker === "pass") return { verdict: "pass", judge: false };
  return { verdict: marker ?? "blocked", judge: true };
}

/** The marker is the floor; the judge may only escalate it (mirrors `computeValidateVerdict`). */
export function mergeAuditVerdict(marker: Verdict | null, judged: Verdict): Verdict {
  if (marker === null) return judged;
  return GATE_SEVERITY[judged] >= GATE_SEVERITY[marker] ? judged : marker;
}

export interface SpecAuditDecisionInput {
  /** `--only-phase SPEC_AUDIT` forces a real audit. */
  force: boolean;
  /** `hasImplementationCode(workPath)` — a greenfield repo has nothing to audit. */
  hasImplementationCode: boolean;
  /** `computePlanHash([spec, adr, plan])` at this iteration. */
  docHash: string;
  /** The last memoized audit, if any. */
  last?: { docHash: string };
}

/**
 * Whether the whole-document `SPEC_AUDIT` must run this iteration (REQ-62).
 *
 * Greenfield always wins, even under `--only-phase`: there is nothing to audit
 * and spending a turn would only hallucinate findings. Otherwise the audit runs
 * on the first iteration and whenever the spec/adr/plan content changed; an
 * unchanged contract reuses the previous result.
 */
export function specAuditNeeded(input: SpecAuditDecisionInput): {
  run: boolean;
  reason: "forced" | "greenfield" | "first" | "changed" | "unchanged";
} {
  if (!input.hasImplementationCode) return { run: false, reason: "greenfield" };
  if (input.force) return { run: true, reason: "forced" };
  if (input.last === undefined) return { run: true, reason: "first" };
  if (input.last.docHash !== input.docHash) return { run: true, reason: "changed" };
  return { run: false, reason: "unchanged" };
}

/**
 * The phase implementations, keyed by phase. A methodology profile (REQ-36 /
 * ADR-35) is just an ordered selection of these, so a profile can reorder or
 * subset the pipeline — and `strict-tdd` can run `TEST_MODULE` twice (tests
 * first, then the gate) — without touching the engine.
 */
const STEP_BY_PHASE: Partial<Record<PhaseName, PipelineStep>> = {
  SPEC_AUDIT: { phase: "SPEC_AUDIT", fn: specAudit, gate: "spec-audit", fixPhase: "FIX_SPEC", fixLabel: "spec audit", blocking: true, readOnly: true },
  EXECUTE: { phase: "EXECUTE", fn: execute, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
  VALIDATE_STEP: { phase: "VALIDATE_STEP", fn: validateStep, gate: "validate-step", fixPhase: "FIX_VALIDATE", fixLabel: "validation gate", blocking: true, readOnly: true },
  TEST_MODULE: { phase: "TEST_MODULE", fn: testModule, gate: "audit-status", fixPhase: "FIX_TEST", fixLabel: "test failures", blocking: true },
  VERIFY: { phase: "VERIFY", fn: verifyIteration, gate: "none", fixPhase: "FIX_VERIFY", fixLabel: "verification", blocking: true },
  SECURE_CHECK: { phase: "SECURE_CHECK", fn: secureCheck, gate: "audit-status", fixPhase: "FIX_SECURITY", fixLabel: "security audit", blocking: true, readOnly: true },
  REVIEW: { phase: "REVIEW", fn: review, gate: "audit-status", fixPhase: "FIX_REVIEW", fixLabel: "code review", blocking: true, readOnly: true },
  DOC_SYNC: { phase: "DOC_SYNC", fn: docSync, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
  COMMIT_ALL: { phase: "COMMIT_ALL", fn: commitAll, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
};

/**
 * The two commit implementations (REQ-63). The default is deterministic: no
 * model turn, and `git log` is reproducible from the plan. A profile (or
 * `--commit agent`) can opt back into the agent's semantic grouping.
 */
const COMMIT_STEP: Record<"agent" | "deterministic", PhaseFn> = {
  agent: commitAll,
  deterministic: commitAllDeterministic,
};

/**
 * Resolve a profile into runnable steps, failing closed (AC-36.6) if it names a
 * phase the engine cannot run — a broken profile must never silently degrade to
 * the default.
 */
function pipelineFor(
  profile: ProfileName | undefined,
  commit?: "agent" | "deterministic",
): PipelineStep[] {
  const spec = profileSpec(profile);
  const guard = validateProfilePhases(
    spec.id,
    new Set(Object.keys(STEP_BY_PHASE) as PhaseName[]),
  );
  if (!guard.ok) {
    throw new Error(
      `profile "${spec.id}" needs phase(s) the engine cannot run: ${guard.missing.join(", ")}`,
    );
  }
  const commitMode = commit ?? spec.commit ?? "deterministic";
  const steps = spec.phases.map((phase) => ({
    ...STEP_BY_PHASE[phase]!,
    ...(phase === "COMMIT_ALL" ? { fn: COMMIT_STEP[commitMode] } : {}),
  }));
  if (spec.testFirst) {
    // The pre-EXECUTE test run is expected to fail: judge it (so the failing
    // verdict is recorded as evidence) but never block, and never "fix" — that
    // would implement the code before EXECUTE and invert test-first.
    const index = steps.findIndex((step) => step.phase === "TEST_MODULE");
    if (index >= 0) {
      steps[index] = { ...steps[index]!, blocking: false, fixPhase: null, fixLabel: "" };
    }
  }
  return steps;
}

const PAUSE_POLL_MS = 200;
const SUMMARY_MAX_LENGTH = 300;
const MAX_JUDGE_ACTION_ITEMS = 8;

export interface CycleEngineOptions {
  cfg: RunConfig;
  /**
   * Legacy escape hatch: build the opencode port around this client. Tests and
   * embedders use it; the engine itself only ever sees the port.
   */
  client?: OpencodeClient;
  runtime?: RuntimePort | IAgentRuntime;
  plan: { content: string; iterations: Iteration[] };
  state?: HarnessState;
  /**
   * Injected worktree manager (tests / custom wiring). When omitted and
   * `cfg.sandbox` is enabled one is created lazily against `cfg.projectPath`.
   */
  worktrees?: WorktreeManager;
}

export class CycleEngine {
  private cfg: RunConfig;
  readonly runtime: RuntimePort;
  private activeSession?: RuntimeSession;
  private plan: { content: string; iterations: Iteration[] };
  private state: HarnessState;
  private models: Models;
  private decisions = new DecisionBroker();
  private paused = false;
  /** True while {@link run} is executing (the dashboard gates its idle timers on it). */
  private running = false;
  /** Verdict of the most recently completed phase (for the iteration receipt). */
  private lastVerdict?: Verdict;
  private abortRequested = false;
  private worktrees?: WorktreeManager;
  private sandboxEnabledCache?: boolean;
  /**
   * Set when an iteration's sandbox could not be integrated into the primary
   * branch (ADR-48). The run then finishes as a promotion failure — with the
   * preserved branch recorded — instead of being reported as an abort.
   */
  private promotionFailure?: PromotionRecord;
  /** Sandboxes already checkpointed by {@link parkForResume} (idempotent park). */
  private parkedBranches = new Set<string>();
  private outcome: { reason: "completed" | "aborted" | "error"; error?: string } = { reason: "completed" };

  constructor(opts: CycleEngineOptions) {
    this.cfg = opts.cfg;
    // The engine only knows the port. An injected legacy client builds the
    // opencode port around it, which is what the argv-level tests rely on.
    this.runtime = opts.runtime
      ? asRuntimePort(opts.runtime)
      : createOpencodePort({
          client: opts.client,
          port: opts.cfg.port,
          serverTimeoutMs: opts.cfg.serverTimeoutMs,
          projectPath: opts.cfg.projectPath,
        });
    this.plan = opts.plan;
    this.models = resolveModels(opts.cfg.thinker, opts.cfg.executor);
    this.worktrees = opts.worktrees;
    if (opts.state) {
      this.state = opts.state;
    } else {
      this.state = freshState({
        planHash: computePlanHash([opts.cfg.planPath, opts.cfg.specPath, opts.cfg.adrPath]),
        planPath: opts.cfg.planPath,
        specPath: opts.cfg.specPath,
        adrPath: opts.cfg.adrPath,
        thinker: opts.cfg.thinker,
        executor: opts.cfg.executor,
        mode: opts.cfg.mode,
      });
    }
  }

  getState(): HarnessState {
    return this.state;
  }

  getOutcome(): { reason: "completed" | "aborted" | "error"; error?: string } {
    return this.outcome;
  }

  /**
   * Keep the in-flight iteration's work instead of deleting it (ADR-56).
   *
   * Registered on SIGINT/SIGTERM and used by the abort path. Everything the
   * interrupted step produced is committed into the sandbox (so it survives even
   * if the worktree has to be recreated later) and the worktree plus its branch
   * stay on disk with the resume cursor naming the step to restart. Idempotent:
   * the signal handler and the engine's own unwinding can both call it.
   */
  parkForResume(): void {
    try {
      for (const sandbox of this.getWorktrees().listSandboxes()) {
        if (this.parkedBranches.has(sandbox.branch)) continue;
        this.parkedBranches.add(sandbox.branch);
        try {
          const checkpoint = this.getWorktrees().commitPendingChanges(
            sandbox,
            `chore(iter-${sandbox.iteration}): interrupted checkpoint`,
          );
          events.emit("log", {
            level: "info",
            message: checkpoint.commit
              ? `[sandbox] iteration ${sandbox.iteration}: parked for resume (checkpoint ${checkpoint.commit.slice(0, 12)})`
              : `[sandbox] iteration ${sandbox.iteration}: parked for resume (nothing to commit)`,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          events.emit("log", {
            level: "warn",
            message: `[sandbox] could not checkpoint the interrupted sandbox ${sandbox.branch}: ${
              (err as Error).message
            }`,
            timestamp: new Date().toISOString(),
          });
        }
      }
      this.persist();
    } catch (err) {
      events.emit("log", {
        level: "warn",
        message: `[sandbox] park-for-resume failed: ${(err as Error).message}`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** Lazily create the worktree manager (only when sandboxing is in play). */
  private getWorktrees(): WorktreeManager {
    if (!this.worktrees) {
      this.worktrees = new WorktreeManager(this.cfg.projectPath);
    }
    return this.worktrees;
  }

  /**
   * The step an interrupted run must restart (ADR-56).
   *
   * Only the iteration that has not completed can be resumed; a cursor naming any
   * other iteration is stale (the plan changed, or the state was edited by hand)
   * and is dropped here, so it can never point at work that no longer exists.
   */
  private resumeCursor(): ResumeCursor | undefined {
    const cursor = this.state.resume;
    if (!cursor) return undefined;
    if (cursor.iteration !== this.state.currentIteration) {
      this.state.resume = undefined;
      this.persist();
      return undefined;
    }
    return cursor;
  }

  /**
   * Whether this run actually uses worktree sandboxes. Sandboxing requires both
   * the config flag and an existing HEAD commit: a greenfield repo with no HEAD
   * cannot create a worktree, so the run falls back to in-place execution for
   * this run rather than throwing from `createSandbox` (REQ-17).
   */
  private sandboxingEnabled(): boolean {
    if (!this.cfg.sandbox) return false;
    if (this.sandboxEnabledCache === undefined) {
      if (!headCommit(this.cfg.projectPath)) {
        events.emit("log", {
          level: "warn",
          message:
            "[sandbox] disabled for this run: project has no HEAD commit; running in-place",
          timestamp: new Date().toISOString(),
        });
        this.sandboxEnabledCache = false;
      } else {
        this.sandboxEnabledCache = true;
      }
    }
    return this.sandboxEnabledCache;
  }

  /**
   * Map a primary-project doc path into the sandbox so phases read/write the
   * sandbox copy. Returns `docPath` unchanged when there is no sandbox.
   */
  private sandboxDocPath(sandbox: Sandbox | undefined, docPath: string): string {
    if (!sandbox) return docPath;
    return join(sandbox.path, relative(this.cfg.projectPath, docPath));
  }

  async ask(req: DecisionRequest): Promise<DecisionChoice> {
    return this.requestDecision(req);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  requestAbort(): void {
    this.abortRequested = true;
    this.outcome = { reason: "aborted" };
    this.decisions.resolveAll("abort");
    // Interrupt the in-flight agent request so the loop can observe the abort
    // immediately instead of waiting out a long phase timeout: aborting the
    // session server-side rejects the pending `session.prompt`/`command`.
    if (this.activeSession) {
      void this.activeSession.interrupt("aborted by the engine");
    } else if (this.state.iterationSessionId && this.runtime.abortSession) {
      void this.runtime.abortSession(this.state.iterationSessionId);
    }
  }

  resolveDecision(choice: DecisionChoice): void {
    this.decisions.resolve(choice);
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.abortRequested) {
      await new Promise((r) => setTimeout(r, PAUSE_POLL_MS));
    }
  }

  private async requestDecision(req: DecisionRequest): Promise<DecisionChoice> {
    await this.waitIfPaused();
    return this.decisions.request(req);
  }

  get isRunning(): boolean {
    return this.running;
  }

  async run(): Promise<{ reason: "completed" | "aborted" | "error"; error?: string }> {
    if (!isGitRepo(this.cfg.projectPath)) {
      throw new Error(`"${this.cfg.projectPath}" is not a git repository.`);
    }

    if (!this.cfg.sandbox) {
      events.emit("log", {
        level: "warn",
        message:
          "[huginn] in-place execution: stopping mid-iteration can leave a partial working tree; " +
          "use the sandbox (default) for atomic increments",
        timestamp: new Date().toISOString(),
      });
    }

    // Best-effort: reclaim worktrees (and orphaned branches) left behind by a
    // previous interrupted run before creating this run's sandboxes — except the
    // one this run is about to resume, whose worktree holds the only copy of the
    // interrupted iteration's work (ADR-56).
    const resume = this.resumeCursor();
    if (this.sandboxingEnabled()) {
      try {
        // A branch a failed promotion preserved holds the only copy of that
        // iteration's commits: rename it out of the reclaim namespace before the
        // sweep, so a plain re-run can neither delete it nor be blocked by it
        // (REV-001). A branch the resume cursor owns is not preserved: renaming it
        // would strand the worktree the run is about to reattach.
        const preserved = this.state.promotion;
        if (
          preserved &&
          (preserved.status === "conflict" || preserved.status === "failed") &&
          preserved.branch !== resume?.sandboxBranch
        ) {
          const kept = this.getWorktrees().preserveOrphanBranch(preserved.branch);
          if (kept) {
            // The record must keep naming the branch that actually holds the
            // commits, or `huginn promote` would look for the old name (ADR-62).
            this.state.promotion = { ...preserved, branch: kept };
            this.persist();
            events.emit("log", {
              level: "info",
              message: `[sandbox] preserved branch ${preserved.branch} renamed to ${kept} for manual recovery`,
              timestamp: new Date().toISOString(),
            });
          }
        }
        const reclaimed = this.getWorktrees().cleanupAll(resume?.iteration);
        if (reclaimed > 0) {
          events.emit("log", {
            level: "info",
            message: `[sandbox] reclaimed ${reclaimed} stale sandbox resource(s) before run`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        events.emit("log", {
          level: "warn",
          message: `[sandbox] pre-run cleanup failed (continuing): ${(err as Error).message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
    if (resume) {
      events.emit("log", {
        level: "info",
        message: `[resume] iteration ${resume.iteration} — restarting ${resume.phase}`,
        timestamp: new Date().toISOString(),
      });
    }

    this.running = true;
    try {
      await this.runLoop();
    } catch (err) {
      // A deliberate abort interrupts the in-flight agent request, which can
      // surface as a transport rejection from judge/fix awaits outside the
      // per-phase try — report it as an abort, not an error. The underlying
      // error is still attached so a genuine failure during shutdown isn't
      // silently swallowed.
      if (this.abortRequested) return this.finishAborted((err as Error).message);
      this.decisions.resolveAll("abort");

      // A promotion failure is not an abort (ADR-48 / AC-49.3): the iteration's
      // commits are preserved on their sandbox branch, so the run finishes as an
      // *error* carrying a structured promotion record — never as `aborted`.
      if (this.promotionFailure) {
        this.state.promotion = this.promotionFailure;
        this.outcome = { reason: "error", error: (err as Error).message };
        this.state.finishedAt = new Date().toISOString();
        this.persist();
        events.emit("done", { reason: "error", error: (err as Error).message });
        return this.outcome;
      }

      this.outcome = { reason: "error", error: (err as Error).message };
      this.state.finishedAt = new Date().toISOString();
      this.state.aborted = true;
      this.persist();
      events.emit("done", { reason: "error", error: (err as Error).message });
      return this.outcome;
    } finally {
      this.running = false;
    }

    if (this.abortRequested) return this.finishAborted();

    this.outcome = { reason: "completed" };
    if (!this.cfg.onlyPhase) {
      // debug mode (--only-phase) keeps state resumable
      this.state.finishedAt = new Date().toISOString();
      // A resumed run that now completes is not an aborted run: clear the sticky
      // flag so `PROGRESS.md` cannot report ABORTED beside a successful exit
      // (REV-004, AC-49.3).
      this.state.aborted = false;
    }
    this.persist();
    events.emit("done", { reason: "completed" });
    return this.outcome;
  }

  private persist(): void {
    saveState(this.cfg.projectPath, this.state);
    renderProgressMarkdown(this.cfg.projectPath, this.state);
    events.emit("stateUpdated", this.state);
  }

  private finishAborted(error?: string): { reason: "aborted"; error?: string } {
    this.decisions.resolveAll("abort");
    const outcome = error ? { reason: "aborted" as const, error } : { reason: "aborted" as const };
    this.outcome = outcome;
    this.state.finishedAt = new Date().toISOString();
    this.state.aborted = true;
    this.persist();
    events.emit("done", { reason: "aborted", error });
    return outcome;
  }

  private async runLoop(): Promise<void> {
    const iterations = this.plan.iterations;
    for (const iteration of iterations) {
      if (this.cfg.fromIteration && iteration.index < this.cfg.fromIteration) continue;
      if (iteration.index < this.state.currentIteration) continue;
      if (this.abortRequested) return;

      // The title comes from the user's plan file, so it is sanitized before it
      // reaches any UI/log consumer (SEC-004): terminal escapes in it must never
      // reach the terminal.
      const safeTitle = sanitizeTerminalText(iteration.title);
      events.emit("iterationStart", {
        iteration: iteration.index,
        totalIterations: iterations.length,
        title: safeTitle,
        modules: iteration.modules,
      });
      events.emit("log", {
        level: "info",
        message: `▶ Iteration ${iteration.index}/${iterations.length} — ${safeTitle}`,
        timestamp: new Date().toISOString(),
      });
      await this.runIteration(iteration);

      // don't mark an aborted iteration as complete, or a resume would skip
      // it entirely even though its phases never finished
      if (this.abortRequested) return;

      events.emit("iterationEnd", {
        iteration: iteration.index,
        title: safeTitle,
      });

      if (this.cfg.onlyPhase) {
        // debug mode: run the phase on a single iteration, leave state resumable
        return;
      }
      // mark iteration complete
      this.state.currentIteration = iteration.index + 1;
      this.state.currentPhase = "SPEC_AUDIT";
      // The increment is promoted: there is nothing left to resume.
      this.state.resume = undefined;
      this.persist();
    }
  }

  private async runIteration(iteration: Iteration): Promise<void> {
    // When sandboxing is enabled, isolate the iteration in a git worktree and
    // run every phase against `workPath`; the primary working tree is only
    // touched by `promoteSandbox` on success. The sandbox is created first so
    // its path can scope the agent session. `settled` guarantees the sandbox is
    // cleaned up exactly once (promoted OR discarded), even on abort/throw.
    //
    // An interrupted iteration keeps its sandbox, so the resuming run reattaches
    // it instead of starting from HEAD (ADR-56) — otherwise every phase's work
    // would be gone and the whole iteration would have to re-run.
    const cursor = this.resumeCursor();
    let sandbox: Sandbox | undefined;
    let reattached = false;
    if (this.sandboxingEnabled()) {
      const attached = cursor
        ? this.getWorktrees().attachSandbox(this.cfg.projectPath, iteration.index)
        : null;
      if (attached) {
        sandbox = attached;
        reattached = true;
        events.emit("log", {
          level: "info",
          message: `[resume] iteration ${iteration.index}: reattached the interrupted sandbox`,
          timestamp: new Date().toISOString(),
        });
      } else {
        if (cursor) {
          // The worktree is gone, so the resume point cannot be honoured. The
          // branch may still hold the only copy of that iteration's work, so it
          // is renamed out of the reclaim namespace instead of deleted (the same
          // recovery rule a conflicted promotion uses); then the iteration
          // replays from its first step.
          const kept = this.getWorktrees().preserveOrphanBranch(sandboxBranch(iteration.index));
          if (kept) {
            events.emit("log", {
              level: "warn",
              message: `[resume] iteration ${iteration.index}: the interrupted sandbox is gone; its branch was preserved as ${kept}`,
              timestamp: new Date().toISOString(),
            });
          }
          this.getWorktrees().discardSandbox({
            iteration: iteration.index,
            path: sandboxPath(this.cfg.projectPath, iteration.index),
            branch: sandboxBranch(iteration.index),
            projectRoot: this.cfg.projectPath,
            baseCommit: "",
          });
          this.state.resume = undefined;
          this.persist();
          events.emit("log", {
            level: "warn",
            message: `[resume] iteration ${iteration.index}: restarting the iteration from its first step`,
            timestamp: new Date().toISOString(),
          });
        }
        sandbox = this.getWorktrees().createSandbox(this.cfg.projectPath, iteration.index);
      }
    }
    const workPath = sandbox?.path ?? this.cfg.projectPath;

    // Each iteration starts with a clean promotion record so a previous
    // iteration's outcome can never be read as this one's.
    this.promotionFailure = undefined;
    this.state.promotion = undefined;

    // Muninn memory is durable state that must outlive an ephemeral sandbox:
    // always resolve the database from the PRIMARY project root so the
    // harness-side symbol graph (indexed by `commitAll`) is never written into
    // the worktree and silently lost when the sandbox is promoted/discarded.
    // `projectPath`/`directory` stay on the sandbox so code edits and compiler
    // reads target the isolated worktree.
    const primaryDbPath = resolveDatabasePath(undefined, this.cfg.projectPath);

    // Every phase opens its own clean session scoped to `workPath` (see
    // `runPhase`): a role never inherits another role's accumulated context, and
    // the build agent's tools edit the sandbox rather than the primary tree
    // (REQ-17). The context below intentionally starts session-less; `runPhase`
    // fills it in per step.
    const sessionId = "";

    let settled = false;
    try {
      // A reattached sandbox already contains the interrupted iteration's
      // commits, so its HEAD is not the diff base — the persisted one is.
      const baseCommit = reattached
        ? (this.state.iterationBaseCommit ?? headCommit(workPath) ?? undefined)
        : (headCommit(workPath) ?? undefined);
      this.state.iterationBaseCommit = baseCommit;
      this.persist();

      const explicitModules = iteration.modules ?? [];
      const ctx: PhaseContext = {
        session: undefined,
        sessionId,
        models: this.models,
        projectPath: workPath,
        directory: workPath,
        // Durable Muninn state always targets the primary project, never the
        // ephemeral worktree (Phase 3 memory persistence).
        primaryProjectRoot: this.cfg.projectPath,
        dbPath: primaryDbPath,
        iteration,
        specPath: this.sandboxDocPath(sandbox, this.cfg.specPath),
        adrPath: this.sandboxDocPath(sandbox, this.cfg.adrPath),
        planPath: this.sandboxDocPath(sandbox, this.cfg.planPath),
        modules: explicitModules,
        baseCommit,
        profilePreamble: profilePreamble(this.cfg.profile),
        profile: profileSpec(this.cfg.profile).id,
        totalIterations: this.plan.iterations.length,
        phaseTimeoutMs: this.cfg.phaseTimeoutMs,
        verify: this.cfg.verify !== false,
      };

      // Resume point (ADR-56). The cursor names the step that was in flight when
      // the run ended, and restarting *that* step is the whole point: its work may
      // be half-done, so moving on to the next one would validate a step nobody
      // finished. Under sandboxing the cursor is only usable when its worktree
      // could be reattached; otherwise the earlier phases' changes are gone and
      // the iteration replays from the start. The history scan stays as the
      // fallback for state written before the cursor existed (in-place runs only).
      const steps = pipelineFor(this.cfg.profile, this.cfg.commit);
      let resumeIndex = 0;
      if (!this.cfg.onlyPhase && this.state.currentIteration === iteration.index) {
        if (cursor && (!sandbox || reattached)) {
          const index = steps.findIndex((step) => step.phase === cursor.phase);
          if (index >= 0) resumeIndex = index;
        } else if (!sandbox) {
          // Resume at the first step this iteration has not recorded yet. Keying
          // the cursor off a phase *id* was wrong: `currentPhase` starts at
          // SPEC_AUDIT every iteration, so a profile that does not begin with
          // SPEC_AUDIT (odd/rdd/strict-tdd) matched no step and ran nothing.
          const recorded = this.state.history
            .filter((h) => h.iteration === iteration.index)
            .map((h) => h.phase);
          resumeIndex = steps.length;
          const seen = new Map<PhaseName, number>();
          for (let i = 0; i < steps.length; i += 1) {
            const phase = steps[i]!.phase;
            const occurrence = (seen.get(phase) ?? 0) + 1;
            seen.set(phase, occurrence);
            if (occurrence > recorded.filter((p) => p === phase).length) {
              resumeIndex = i;
              break;
            }
          }
        }
      }
      if (resumeIndex > 0) {
        events.emit("log", {
          level: "info",
          message: `[resume] iteration ${iteration.index} — restarting ${steps[resumeIndex]!.phase} (${resumeIndex} earlier step(s) kept)`,
          timestamp: new Date().toISOString(),
        });
      }
      // Frozen evidence for the profiles that require it (REQ-36 / AC-36.4).
      const verdicts: Array<{ phase: PhaseName; verdict?: Verdict }> = [];
      const preExecuteTree = profileSpec(this.cfg.profile).evidence === "snapshot"
        ? treeHash(workPath)
        : undefined;

      for (const [stepIndex, step] of steps.entries()) {
        if (this.abortRequested) return;
        if (stepIndex < resumeIndex) continue;
        if (this.cfg.onlyPhase && step.phase !== this.cfg.onlyPhase) continue;

        this.state.currentPhase = step.phase;
        this.lastVerdict = undefined;
        // Record the step *before* it runs (ADR-56): a run killed mid-phase
        // (SIGKILL, OOM, power loss) must still know which step to restart, and
        // `currentPhase` only advances once a phase has finished. A debug run
        // (`--only-phase`) discards its sandbox, so it neither creates nor
        // destroys a resume point.
        if (!this.cfg.onlyPhase) {
          this.state.resume = {
            iteration: iteration.index,
            phase: step.phase,
            at: new Date().toISOString(),
            ...(sandbox ? { sandboxBranch: sandbox.branch, sandboxPath: sandbox.path } : {}),
          };
          this.persist();
        }

        // refresh modules once the iteration has produced changes
        if (step.phase === "VALIDATE_STEP" || step.phase === "TEST_MODULE") {
          if (explicitModules.length === 0) {
            ctx.modules = inferModules(workPath, ctx.baseCommit);
          }
        }

        if (step.phase === "SPEC_AUDIT") {
          const docHash = computePlanHash([ctx.specPath, ctx.adrPath, ctx.planPath]);
          const decision = specAuditNeeded({
            force: this.cfg.onlyPhase === "SPEC_AUDIT",
            hasImplementationCode: hasImplementationCode(workPath),
            docHash,
            last: this.state.specAudit,
          });
          if (decision.run) {
            await this.runPhase(step, ctx, sessionId, iteration);
            // Only a non-blocking audit may be memoized: if the human continued
            // past a BLOCKED one, the documents were never cleared and the next
            // iteration must audit them again.
            if (this.lastVerdict === "pass" || this.lastVerdict === "warning") {
              this.state.specAudit = {
                docHash,
                auditedAt: new Date().toISOString(),
                iteration: iteration.index,
                verdict: this.lastVerdict,
              };
              this.persist();
            }
          } else {
            this.recordSkippedSpecAudit(
              iteration,
              decision.reason === "greenfield" ? "greenfield" : "unchanged",
              docHash,
            );
          }
        } else {
          await this.runPhase(step, ctx, sessionId, iteration);
        }

        // An abort keeps the cursor: it names the step that was interrupted, and
        // that is exactly the step the next run must restart. A step that
        // finished cleanly is not a resume point any more; a blocked one stays,
        // so resuming retries the gate instead of stepping past it.
        if (this.abortRequested) return;
        if (this.lastVerdict !== "blocked" && this.state.resume) {
          this.state.resume = undefined;
          this.persist();
        }

        verdicts.push({ phase: step.phase, verdict: this.lastVerdict ?? "skipped" });
        this.persist();
      }

      // In-place runs have no promotion step, so the iteration's files are
      // already in the primary tree: index them here. Sandboxed runs index after
      // a successful promotion instead (below).
      if (!sandbox && !this.abortRequested) {
        indexIterationSourceFiles({
          projectPath: this.cfg.projectPath,
          baseCommit: ctx.baseCommit,
          primaryProjectRoot: this.cfg.projectPath,
        });
        recordIterationMemory({
          primaryProjectRoot: this.cfg.projectPath,
          dbPath: primaryDbPath,
          iteration,
          baseCommit: ctx.baseCommit,
          verdicts,
          commit: headCommit(this.cfg.projectPath),
        });
      }

      // Atomic increment: promotion integrates *commits*, so a successful
      // iteration must never reach promoteSandbox with uncommitted work. The
      // agent's COMMIT_ALL phase normally leaves a clean tree; this checkpoint is
      // the deterministic backstop when it did not (or the profile has no commit
      // phase). Without it, a dirty sandbox with zero commits was discarded
      // silently.
      if (sandbox && !this.abortRequested && !this.cfg.onlyPhase) {
        try {
          const checkpoint = this.getWorktrees().commitPendingChanges(
            sandbox,
            `chore(iter-${iteration.index}): checkpoint — ${sanitizeTerminalText(iteration.title)}`,
          );
          if (checkpoint.commit) {
            events.emit("log", {
              level: "info",
              message: `[huginn] iteration ${iteration.index}: checkpoint commit ${checkpoint.commit.slice(0, 12)}`,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          // Keep the worktree: it holds the only copy of the iteration's work.
          settled = true;
          throw new Error(
            `Could not checkpoint iteration ${iteration.index}: ${(err as Error).message}. ` +
              `The sandbox was preserved at ${sandbox.path}.`,
          );
        }
      }

      // Write the receipt *before* promotion so it pins the verified tree.
      const receipt = buildIterationReceipt({
        profile: this.cfg.profile,
        iteration: iteration.index,
        title: iteration.title,
        projectPath: workPath,
        // The real pre-iteration HEAD, not another read of the current one.
        baseCommit: ctx.baseCommit,
        verdicts,
        preExecuteTree,
      });
      if (receipt) {
        // A missing working-tree signature is the condition the read-only guard
        // fails closed on: the receipt is then no evidence at all, so say so
        // instead of writing a receipt that quietly omits `treeHash` (REV-103).
        if (receipt.treeHash === undefined) {
          events.emit("log", {
            level: "warn",
            message: `[huginn] iteration ${iteration.index}: no working-tree signature available — the receipt records no treeHash and cannot evidence the verified tree`,
            timestamp: new Date().toISOString(),
          });
        }
        const path = writeIterationReceipt(this.cfg.projectPath, receipt);
        if (path) {
          events.emit("log", {
            level: "info",
            message: `[huginn] receipt written: ${relative(this.cfg.projectPath, path)}`,
            timestamp: new Date().toISOString(),
          });
        } else {
          // Best effort must not be silent: the iteration has no frozen evidence.
          events.emit("log", {
            level: "warn",
            message: `[huginn] receipt could not be written (iteration ${iteration.index})`,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Success: integrate the sandbox into the primary branch.
      if (sandbox && !this.abortRequested && !this.cfg.onlyPhase) {
        const result = this.getWorktrees().promoteSandbox(sandbox);
        // `promoteSandbox` always removes the worktree (success, no-op, or
        // conflict), so the sandbox is settled the moment it returns; the
        // finally must not double-clean (which would drop a preserved branch).
        settled = true;
        const backupNote =
          result.backups && result.backups.length > 0
            ? ` (local change(s) parked under ${result.backups.join(", ")})`
            : "";
        if (result.promoted) {
          // The symbol graph is durable, so it may only be updated once the
          // iteration's files really reached the primary tree (a failed
          // promotion must not leave the graph describing ghost files).
          indexIterationSourceFiles({
            projectPath: this.cfg.projectPath,
            baseCommit: ctx.baseCommit,
            primaryProjectRoot: this.cfg.projectPath,
          });
          recordIterationMemory({
            primaryProjectRoot: this.cfg.projectPath,
            dbPath: primaryDbPath,
            iteration,
            baseCommit: ctx.baseCommit,
            verdicts,
            commit: headCommit(this.cfg.projectPath),
          });
          this.state.promotion = {
            status: "promoted",
            branch: sandbox.branch,
            backups: result.backups,
          };
          events.emit("log", {
            level: "info",
            message: `[sandbox] iteration ${iteration.index}: promoted via ${result.method} (${result.commits.length} commit(s))${backupNote}`,
            timestamp: new Date().toISOString(),
          });
        } else if (result.failure ?? result.method !== "none") {
          // `promoteSandbox` distinguishes an integration *conflict* from a
          // *failed* promotion (it could not even attempt the merge). Either way
          // the primary tree is intact and the branch is preserved; fail closed so
          // the run finishes as a *promotion failure* rather than silently
          // reporting success, and record it structurally so `run()` never
          // flattens it into an abort (REQ-17, AC-17.4, AC-49.3).
          // `failure` is authoritative; a non-"none" method that did not promote
          // is the pre-existing "integration conflicted" case.
          const kind = result.failure ?? "conflict";
          const reason = result.detail ? ` Reason: ${result.detail}` : "";
          const failure: PromotionRecord = {
            status: kind,
            branch: sandbox.branch,
            backups: result.backups,
            detail: result.detail,
          };
          this.promotionFailure = failure;
          this.state.promotion = failure;
          events.emit("log", {
            level: "warn",
            message: `[sandbox] iteration ${iteration.index}: promotion ${
              kind === "failed" ? "failed" : "conflicted"
            }; branch ${sandbox.branch} preserved for recovery${backupNote}${reason}`,
            timestamp: new Date().toISOString(),
          });
          throw new Error(
            `Sandbox promotion for iteration ${iteration.index} ${
              kind === "failed" ? "failed" : "conflicted"
            }. The primary tree is intact and branch ${sandbox.branch} holds the iteration's work; ` +
              `recover it with \`git log ${sandbox.branch}\` (a re-run renames it under huginn/preserved/ rather than deleting it). ` +
              `If the reason names a partially staged or staged-new file, commit, unstage or stash it before re-running; tracked local changes are parked automatically, and the iteration's commits stay safe on the branch.${reason}`,
          );
        } else {
          this.state.promotion = { status: "none", branch: sandbox.branch };
          events.emit("log", {
            level: "info",
            message: `[sandbox] iteration ${iteration.index}: no changes to promote`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } finally {
      // An aborted iteration keeps its sandbox, committed, so the next run can
      // reattach it and restart the step that was in flight (ADR-56) — discarding
      // it would throw away work the user already paid for. Everything else
      // (--only-phase, a promotion failure, a thrown engine error) still discards
      // the sandbox: never touch the primary tree, exactly once.
      const keepForResume = this.abortRequested && !this.cfg.onlyPhase && sandbox !== undefined;
      if (keepForResume) {
        this.parkForResume();
        settled = true;
      }
      if (sandbox && !settled) {
        this.getWorktrees().discardSandbox(sandbox);
      }
    }
  }

  // ── Promotion recovery (ADR-62) ─────────────────────────────────────────

  /**
   * Re-attempt the integration a failed promotion left behind. **No model turn.**
   *
   * A promotion failure keeps the branch and removes the worktree, so recovery
   * means: reopen a worktree on that branch, checkpoint anything dirty, and run
   * the same deterministic `promoteSandbox` the iteration would have run. This is
   * the recovery for the cases only a human can clear (a partially staged file, a
   * staged-new file) once they have cleared them.
   */
  async retryPromotion(): Promise<PromotionRetryResult> {
    const target = this.promotionTarget();
    if (!target.ok) return target.result;

    const worktrees = this.getWorktrees();
    let sandbox: Sandbox | undefined;
    let settled = false;
    try {
      sandbox = worktrees.openSandboxFromBranch(
        this.cfg.projectPath,
        target.branch,
        target.iteration.index,
        target.base,
      );
      const checkpoint = worktrees.commitPendingChanges(
        sandbox,
        `chore(iter-${target.iteration.index}): checkpoint — ${sanitizeTerminalText(target.iteration.title)}`,
      );
      if (checkpoint.commit) {
        events.emit("log", {
          level: "info",
          message: `[promote] iteration ${target.iteration.index}: checkpoint commit ${checkpoint.commit.slice(0, 12)}`,
          timestamp: new Date().toISOString(),
        });
      }
      const result = worktrees.promoteSandbox(sandbox);
      // `promoteSandbox` always removes the worktree; the branch is gone on
      // success and preserved on failure.
      settled = true;
      return this.settlePromotion(target.iteration, target.base, target.branch, result);
    } catch (err) {
      // Leave the cleanup to `finally`: a throw before or during integration can
      // leave the recovery worktree on disk, and it must not block a retry. The
      // previous record is passed so an infrastructure error cannot downgrade a
      // `conflict` (which the assisted repair is eligible for) to `failed`.
      return this.failedPromotion(target, err, this.state.promotion);
    } finally {
      if (sandbox && !settled) worktrees.detachSandbox(sandbox);
    }
  }

  /**
   * Diagnose and repair an integration **conflict** (ADR-62), then promote.
   *
   * One attempt, and huginn owns every git operation: it merges the primary HEAD
   * into the preserved branch *without committing*, asks the thinker (read-only)
   * for a remediation plan, lets the executor resolve the conflicted files, commits
   * the merge itself, proves the merged tree with the iteration's deterministic
   * `Verification:` commands, and only then promotes. Any failure keeps the branch
   * exactly as it was (the merge is aborted or the branch reset) and the primary
   * tree is never touched.
   */
  async repairPromotion(): Promise<PromotionRetryResult> {
    const record = this.state.promotion;
    const eligibility = promotionRepairEligibility(record);
    if (!eligibility.ok) {
      return {
        promoted: false,
        method: "none",
        commits: [],
        record: record ?? { status: "none", branch: "" },
        error: eligibility.reason,
      };
    }

    const target = this.promotionTarget();
    if (!target.ok) return target.result;

    const worktrees = this.getWorktrees();
    let sandbox: Sandbox | undefined;
    let settled = false;
    try {
      sandbox = worktrees.openSandboxFromBranch(
        this.cfg.projectPath,
        target.branch,
        target.iteration.index,
        target.base,
      );
      const preMergeTip = worktrees.sandboxHead(sandbox);
      const ctx = this.promotionContext(sandbox, target.iteration, target.base);
      const step = this.promotionStep();

      // The diagnosis/verification turns can take minutes. Bind every merge to
      // the primary HEAD that will actually be integrated: if a commit lands on
      // the primary while we resolve and verify, restart from the iteration's own
      // tip and re-merge, because the tree we verified is not the tree that would
      // be promoted — and `promoteSandbox` could no longer fast-forward.
      const MAX_MERGE_ATTEMPTS = 3;
      for (let attempt = 1; ; attempt++) {
        const head = headCommit(this.cfg.projectPath);
        if (!head) throw new Error("the primary branch has no HEAD commit to merge");

        const merge = worktrees.mergeRef(sandbox, head);
        if (!merge.clean && merge.conflicts.length === 0) {
          throw new Error(
            `cannot merge ${head.slice(0, 12)} into ${target.branch}: ${
              merge.detail ?? "git merge failed"
            }`,
          );
        }

        if (merge.conflicts.length > 0) {
          const report = this.promotionConflictReport(
            record!,
            merge.conflicts,
            head,
            target.iteration.index,
          );
          const diagnosed = await this.runDiagnosis(
            step,
            ctx,
            target.iteration,
            1,
            report,
            undefined,
          );
          const fixRes = await this.withPhaseSession(
            ctx,
            target.iteration,
            "REPAIR_PROMOTION",
            this.models.executor,
            (scoped) =>
              repairPromotionFindings(scoped, {
                detail: record!.detail ?? "",
                conflicts: merge.conflicts,
                head,
                plan: diagnosed.plan,
              }),
          );
          const key = this.attemptKey(target.iteration.index, "REPAIR_PROMOTION");
          this.state.phaseAttempts[key] = (this.state.phaseAttempts[key] ?? 0) + 1;
          this.recordFix(
            { text: fixRes.text, messageId: fixRes.messageId },
            target.iteration.index,
            step,
            1,
            formatModel(this.models.executor),
          );
          this.persist();
        }

        worktrees.commitMerge(
          sandbox,
          `chore(iter-${target.iteration.index}): merge ${head.slice(0, 12)} into ${target.branch}`,
        );

        const verification = await verifyIteration({ ...ctx, session: undefined, sessionId: "" });
        if (verification.crash) {
          throw new Error(
            `verification crashed (${verification.crash.command} → ${verification.crash.signal}); ` +
              `a crash is an environment failure, not something this repair can fix`,
          );
        }
        if (verification.authoritativeVerdict !== "pass") {
          // The merged tree never reached the primary branch and must not look
          // verified: restore the branch to the tip the iteration produced.
          if (preMergeTip) worktrees.resetTo(sandbox, preMergeTip);
          throw new Error(
            `the merged tree does not verify: ${sanitizeTerminalText(verification.text)
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .slice(-6)
              .join(" · ")}`,
          );
        }

        if (headCommit(this.cfg.projectPath) === head) break;

        if (attempt >= MAX_MERGE_ATTEMPTS) {
          // Give up without leaving an unverified merge commit behind: the branch
          // returns to the iteration's own tip and the primary tree is untouched.
          if (preMergeTip) worktrees.resetTo(sandbox, preMergeTip);
          throw new Error(
            `the primary branch advanced ${attempt} times while the promotion was ` +
              `being repaired; ${target.branch} was restored to its pre-merge tip — ` +
              `re-run \`huginn promote --repair\` once the primary branch settles`,
          );
        }

        // The primary moved during this attempt: loop and merge the new HEAD on
        // top of the merge we just made (no reset), so an existing resolution is
        // kept and only the newly landed commits are integrated, then verify the
        // combined tree again before promoting.
      }

      const result = worktrees.promoteSandbox(sandbox);
      settled = true;
      return this.settlePromotion(target.iteration, target.base, target.branch, result);
    } catch (err) {
      // `finally` aborts the in-flight merge (if any) and removes the worktree;
      // the branch — the only copy of the iteration — is never touched.
      return this.failedPromotion(target, err, record);
    } finally {
      if (sandbox && !settled) {
        if (worktrees.mergeInProgress(sandbox)) worktrees.abortMerge(sandbox);
        worktrees.detachSandbox(sandbox);
      }
    }
  }

  /**
   * The iteration, branch and integration base a failed promotion left behind, or
   * the explanation of why there is nothing to recover.
   */
  private promotionTarget():
    | { ok: true; iteration: Iteration; branch: string; base: string }
    | { ok: false; result: PromotionRetryResult } {
    const record = this.state.promotion;
    const fail = (error: string): { ok: false; result: PromotionRetryResult } => ({
      ok: false,
      result: {
        promoted: false,
        method: "none",
        commits: [],
        record: record ?? { status: "none", branch: "" },
        error,
      },
    });

    if (!record || (record.status !== "conflict" && record.status !== "failed")) {
      return fail("there is no failed promotion recorded; nothing to recover");
    }

    // The failed iteration never advanced `currentIteration`; fall back to the
    // number in the branch name so a preserved branch still resolves.
    const fromBranch = /^huginn\/(?:preserved\/)?task-iter-(\d+)/.exec(record.branch)?.[1];
    const iteration =
      this.plan.iterations.find((i) => i.index === this.state.currentIteration) ??
      (fromBranch ? this.plan.iterations.find((i) => i.index === Number(fromBranch)) : undefined);
    if (!iteration) {
      return fail(
        `the plan has no iteration ${this.state.currentIteration}; cannot rebuild the recovery context`,
      );
    }

    const base = this.promotionBase(record.branch);
    if (!base) {
      return fail(
        `could not determine the integration base of ${record.branch}; ` +
          `set it by hand (git merge-base HEAD ${record.branch}) and re-run`,
      );
    }

    return { ok: true, iteration, branch: record.branch, base };
  }

  /**
   * The commit the preserved branch is integrated from: the base the iteration was
   * created at when it still exists, otherwise the merge base with the primary
   * branch. Never the branch tip — that makes the range empty (see
   * `integrationBase`).
   */
  private promotionBase(branch: string): string | undefined {
    const persisted = this.state.iterationBaseCommit;
    if (
      persisted &&
      git(this.cfg.projectPath, ["merge-base", "--is-ancestor", persisted, branch]).code === 0
    ) {
      return persisted;
    }
    return integrationBase(this.cfg.projectPath, branch);
  }

  /** The recovery attempt's phase context: every prompt and command runs in the recovery worktree. */
  private promotionContext(sandbox: Sandbox, iteration: Iteration, base: string): PhaseContext {
    return {
      session: undefined,
      sessionId: "",
      models: this.models,
      projectPath: sandbox.path,
      directory: sandbox.path,
      primaryProjectRoot: this.cfg.projectPath,
      dbPath: resolveDatabasePath(undefined, this.cfg.projectPath),
      iteration,
      specPath: this.sandboxDocPath(sandbox, this.cfg.specPath),
      adrPath: this.sandboxDocPath(sandbox, this.cfg.adrPath),
      planPath: this.sandboxDocPath(sandbox, this.cfg.planPath),
      modules: iteration.modules ?? [],
      baseCommit: base,
      profilePreamble: profilePreamble(this.cfg.profile),
      profile: profileSpec(this.cfg.profile).id,
      totalIterations: this.plan.iterations.length,
      phaseTimeoutMs: this.cfg.phaseTimeoutMs,
      verify: this.cfg.verify !== false,
    };
  }

  /** The synthetic step the diagnosis/application turns are recorded under. */
  private promotionStep(): PipelineStep {
    return {
      phase: "REPAIR_PROMOTION",
      fn: async () => ({ text: "", messageId: "" }),
      gate: "none",
      fixPhase: "REPAIR_PROMOTION",
      fixLabel: "promotion integration",
      blocking: true,
    };
  }

  private promotionConflictReport(
    record: PromotionRecord,
    conflicts: string[],
    head: string,
    iteration: number,
  ): string {
    return [
      `Integration of iteration ${iteration} conflicted while promoting into the primary branch.`,
      `Promotion status: ${record.status}`,
      record.detail ? `Detail: ${record.detail}` : "",
      `A merge of the primary HEAD (${head}) into ${record.branch} is in progress in this worktree.`,
      "Conflicted paths:",
      ...conflicts.map((path) => `- ${path}`),
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  /**
   * The shared success/failure bookkeeping of a recovery attempt: a promoted
   * iteration updates the symbol graph and Muninn, advances the run (so the next
   * `run` continues after it) and clears the resume cursor; a failed one records
   * the reason and leaves the branch intact.
   */
  private settlePromotion(
    iteration: Iteration,
    base: string,
    branch: string,
    result: PromoteResult,
  ): PromotionRetryResult {
    if (result.promoted) {
      indexIterationSourceFiles({
        projectPath: this.cfg.projectPath,
        baseCommit: base,
        primaryProjectRoot: this.cfg.projectPath,
      });
      recordIterationMemory({
        primaryProjectRoot: this.cfg.projectPath,
        dbPath: resolveDatabasePath(undefined, this.cfg.projectPath),
        iteration,
        baseCommit: base,
        verdicts: this.state.history
          .filter((entry) => entry.iteration === iteration.index)
          .map((entry) => ({ phase: entry.phase, verdict: entry.verdict })),
        commit: headCommit(this.cfg.projectPath),
      });
      this.state.promotion = { status: "promoted", branch };
      // The increment is now in the primary tree, so the next run must continue
      // *after* it (exactly what `runLoop` does for a promoted iteration).
      this.state.currentIteration = iteration.index + 1;
      this.state.currentPhase = "SPEC_AUDIT";
      this.state.resume = undefined;
      this.persist();
      events.emit("log", {
        level: "info",
        message: `[promote] iteration ${iteration.index}: recovered via ${result.method} (${result.commits.length} commit(s))`,
        timestamp: new Date().toISOString(),
      });
      events.emit("iterationEnd", {
        iteration: iteration.index,
        title: sanitizeTerminalText(iteration.title),
      });
      return { promoted: true, method: result.method, commits: result.commits, record: this.state.promotion };
    }

    const kind = result.failure ?? "conflict";
    const record: PromotionRecord = {
      status: kind,
      branch,
      ...(result.backups ? { backups: result.backups } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
    this.state.promotion = record;
    this.persist();
    return {
      promoted: false,
      method: result.method,
      commits: result.commits,
      record,
      error: result.detail ?? `promotion ${kind}`,
    };
  }

  /** Record a recovery attempt that threw, keeping the preserved branch. */
  private failedPromotion(
    target: { iteration: Iteration; branch: string; base: string },
    err: unknown,
    previous?: PromotionRecord,
  ): PromotionRetryResult {
    const reason = sanitizeTerminalText(err instanceof Error ? err.message : String(err));
    const status = previous?.status === "conflict" ? "conflict" : "failed";
    const record: PromotionRecord = {
      status,
      branch: target.branch,
      ...(previous?.backups ? { backups: previous.backups } : {}),
      detail: reason,
    };
    this.state.promotion = record;
    this.persist();
    events.emit("log", {
      level: "warn",
      message: `[promote] recovery of iteration ${target.iteration.index} failed; branch ${target.branch} preserved: ${reason}`,
      timestamp: new Date().toISOString(),
    });
    return { promoted: false, method: "none", commits: [], record, error: reason };
  }

  /**
   * Open one clean, directory-scoped session for a single phase/role and close
   * it when the phase ends (ADR: clean sessions per phase).
   *
   * Reusing one iteration-wide session made every role share 150k–300k tokens of
   * someone else's tool loop: the prompt cache was invalidated on each
   * `executor`↔`thinker` switch and a builder effectively graded its own work.
   * The one call site that must keep the old behaviour is a test that injects a
   * fake runtime; `close` is optional on {@link IAgentSession}, so such a fake
   * is simply not closed.
   */
  private async withPhaseSession<T>(
    ctx: PhaseContext,
    iteration: Iteration,
    label: string,
    model: Models[keyof Models],
    fn: (scopedCtx: PhaseContext, sessionId: string) => Promise<T>,
  ): Promise<T> {
    const sink = createRuntimeSink({
      streaming: this.runtime.capabilities.streaming,
      iteration: iteration.index,
      phase: label,
      onUsage: (event) => {
        const current = this.state.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
        this.state.usage = addUsage(current, event);
        this.persist();
      },
    });
    const session = await this.runtime.createSession({
      title: `iter ${iteration.index}: ${sanitizeTerminalText(label)}`,
      directory: ctx.directory ?? ctx.projectPath,
      model: formatModel(model),
      permissions: this.cfg.permissions,
      sink,
      onPermission: permissionHandlerFor(this.cfg.permissions, (request) =>
        this.requestDecision(request),
      ),
    });
    const previous = this.activeSession;
    this.activeSession = session;
    const scopedCtx: PhaseContext = { ...ctx, session, sessionId: session.id };
    try {
      return await fn(scopedCtx, session.id);
    } finally {
      if (this.activeSession === session) this.activeSession = previous;
      await session.close();
    }
  }

  private attemptKey(iteration: number, phase: PhaseName): string {
    return `${iteration}:${phase}`;
  }

  /**
   * Run one pipeline step in its own clean session. The session is created per
   * *phase* (not per prompt): a phase's sub-audits share one role, while the
   * next phase starts fresh.
   */
  private async runPhase(
    step: PipelineStep,
    ctx: PhaseContext,
    _sessionId: string,
    iteration: Iteration,
  ): Promise<void> {
    // `VERIFY` runs deterministic commands and never prompts an agent, so it
    // gets no session: opening one would be waste (and one more failure point).
    if (step.phase === "VERIFY") {
      return this.runPhaseBody(step, ctx, ctx.sessionId, iteration);
    }
    await this.withPhaseSession(ctx, iteration, step.phase, this.models.executor, (scopedCtx, scopedId) =>
      this.runPhaseBody(step, scopedCtx, scopedId, iteration),
    );
  }

  private async runPhaseBody(
    step: PipelineStep,
    ctx: PhaseContext,
    sessionId: string,
    iteration: Iteration,
  ): Promise<void> {
    this.state.currentPhase = step.phase;
    const key = this.attemptKey(iteration.index, step.phase);
    const attempts = this.state.phaseAttempts[key] ?? 0;
    const attempt = attempts + 1;

    events.emit("phaseStart", {
      iteration: iteration.index,
      totalIterations: this.plan.iterations.length,
      iterationTitle: sanitizeTerminalText(iteration.title),
      phase: step.phase,
      attempt,
      model: formatModel(this.models.executor),
      startedAt: new Date().toISOString(),
    });

    for (let attemptRun = 0; attemptRun < this.cfg.maxRetries + 1; attemptRun++) {
      await this.waitIfPaused();
      if (this.abortRequested) return;

      const curAttempt = attempts + 1 + attemptRun;
      const model = this.models.executor;

      let result: GatedPhaseResult;
      try {
        result = await this.runOnce(step, ctx, sessionId, iteration, curAttempt, model);
      } catch (err) {
        if (this.abortRequested) return; // deliberate abort, not a phase failure
        // Phase-level failure (provider stall / timeout / API error): retry the
        // phase, then escalate instead of letting one stall kill the whole run.
        const msg = err instanceof Error ? err.message : String(err);
        events.emit("log", {
          level: "warn",
          message: `[${step.phase}] attempt ${curAttempt} failed: ${msg}`,
          timestamp: new Date().toISOString(),
        });
        this.recordError(iteration.index, step, curAttempt, sessionId, formatModel(model), msg);
        this.persist();
        if (attemptRun < this.cfg.maxRetries) continue;
        const decision = await this.requestDecision({
          id: crypto.randomUUID(),
          kind: "gate-blocked",
          iteration: iteration.index,
          phase: step.phase,
          attempt: curAttempt,
          message: `Phase ${step.phase} failed (timeout/error): ${msg}. Retry, force-continue, or abort?`,
        });
        if (decision === "abort") {
          this.abortRequested = true;
          return;
        }
        if (decision === "continue") {
          return;
        }
        attemptRun = -1; // retry, reset loop
        continue;
      }

      // huginn's own verdicts decide the gate: a read-only violation (REV-001)
      // or a verdict the phase computed structurally (REV-101). Only a phase
      // without one falls back to reading its own status marker, and the judge
      // turn is paid for only when that marker is non-pass or unreadable.
      const structural = resolveStructuralVerdict(result);
      const marker = step.gate === "audit-status" ? parseAuditGateVerdict(result.raw) : undefined;
      let parsed: Verdict | undefined;
      if (!structural) {
        if (step.gate === "spec-audit") {
          parsed = this.gatedVerdict(step.phase, result, parseSpecAuditVerdict(result.raw));
        } else if (step.gate === "validate-step") {
          parsed = this.gatedVerdict(step.phase, result, parseValidateStepVerdict(result.raw));
        }
      }
      const gate = gateDecision({
        gate: step.gate,
        blocking: step.blocking,
        structural,
        auditStatus: marker,
        parsed,
      });
      let verdict = gate.verdict;
      if (gate.judge) {
        const judge = await this.runJudge(step, result, sessionId);
        verdict = mergeAuditVerdict(marker ?? null, judge.status);
      }
      result.verdict = verdict;
      this.lastVerdict = verdict;
      const durationMs = new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime();
      this.record(result, iteration.index, step, curAttempt, durationMs);
      this.persist();

      if (verdict !== "blocked" || !step.blocking) {
        return;
      }

      events.emit("log", {
        level: "warn",
        message: `[${step.phase}] blocked (attempt ${curAttempt})`,
        timestamp: new Date().toISOString(),
      });

      // A signal death is an environment failure, not a failing expectation. The
      // fix rounds exist to change the source, and no source edit can stop a
      // driver crash — so escalate now with an explicit message instead of
      // spending the retry budget on a blind "fix" (see `PhaseOutput.crash`).
      if (result.crash) {
        const crash = result.crash;
        events.emit("log", {
          level: "warn",
          message:
            `[${step.phase}] crashed (${crash.signal}) in \`${crash.command}\` — ` +
            "environment failure, not a source defect; skipping the fix rounds",
          timestamp: new Date().toISOString(),
        });
        const decision = await this.requestDecision({
          id: crypto.randomUUID(),
          kind: "gate-blocked",
          iteration: iteration.index,
          phase: step.phase,
          attempt: curAttempt,
          message:
            `Verification crashed (${crash.signal}): \`${crash.command}\` died from a signal, ` +
            "so no fix round was attempted — this is the environment, not the source. " +
            "Fix the environment (isolate/serialize the test, pin the driver, or drop the " +
            "command from `Verification:`) and retry, force-continue, or abort?",
        });
        if (decision === "abort") {
          this.abortRequested = true;
          return;
        }
        if (decision === "continue") {
          return;
        }
        attemptRun = -1; // retry, reset loop
        continue;
      }

      // Blocking → escalate. A first failure of a purely mechanical gate
      // (VERIFY / TEST) is fixed directly by the executor from the console
      // output and the judge's action items (zero thinker tokens). Anything
      // architectural — or any repeat failure — is diagnosed read-only by the
      // thinker first, and the executor then applies that plan.
      if (attemptRun < this.cfg.maxRetries && step.fixPhase) {
        await this.waitIfPaused();
        if (this.abortRequested) return;

        const tactical = step.fixPhase === "FIX_VERIFY" || step.fixPhase === "FIX_TEST";
        const direct = tactical && curAttempt === 1;
        let remediation: Remediation = { actionItems: result.actionItems };
        if (!direct) {
          const diagnosed = await this.runDiagnosis(
            step,
            ctx,
            iteration,
            curAttempt,
            result.raw,
            result.actionItems,
          );
          remediation = { plan: diagnosed.plan, actionItems: result.actionItems };
        }

        events.emit("phaseStart", {
          iteration: iteration.index,
          totalIterations: this.plan.iterations.length,
          iterationTitle: sanitizeTerminalText(iteration.title),
          phase: step.fixPhase,
          attempt: curAttempt,
          model: formatModel(this.models.executor),
          startedAt: new Date().toISOString(),
        });
        const fixPhase = step.fixPhase;
        const fixRes = await this.withPhaseSession(
          ctx,
          iteration,
          fixPhase,
          this.models.executor,
          async (fixCtx) => {
            if (fixPhase === "FIX_SPEC") return fixSpec(fixCtx, result.raw, remediation);
            if (fixPhase === "FIX_SECURITY") return fixSecurity(fixCtx, result.raw, remediation);
            return fixFindings(fixCtx, step.fixLabel, result.raw, undefined, remediation);
          },
        );
        const fixKey = this.attemptKey(iteration.index, fixPhase);
        this.state.phaseAttempts[fixKey] = (this.state.phaseAttempts[fixKey] ?? 0) + 1;
        this.recordFix(fixRes, iteration.index, step, curAttempt, formatModel(this.models.executor));
        this.persist();
        continue;
      }

      // supervised mode: pause at every non-pass gate for a human decision
      if (this.cfg.mode === "supervised" && verdict === "blocked") {
        const decision = await this.requestDecision({
          id: crypto.randomUUID(),
          kind: "gate-blocked",
          iteration: iteration.index,
          phase: step.phase,
          attempt: curAttempt,
          message: `Gate ${step.phase} is blocked. Retry (thinker diagnosis → executor), force-continue, or abort?`,
        });
        if (decision === "abort") {
          this.abortRequested = true;
          return;
        }
        if (decision === "continue") {
          return;
        }
        // retry: reset retry budget and loop again
        // (allows the human to keep fixing manually then re-running)
        attemptRun = -1;
        continue;
      }

      // out of retries in auto mode → escalate
      const decision = await this.requestDecision({
        id: crypto.randomUUID(),
        kind: "gate-blocked",
        iteration: iteration.index,
        phase: step.phase,
        attempt: curAttempt,
        message: `Gate ${step.phase} still blocked after ${this.cfg.maxRetries} fix attempts (${this.cfg.mode} mode). Retry, force-continue, or abort?`,
      });
      if (decision === "abort") {
        this.abortRequested = true;
        return;
      }
      if (decision === "continue") {
        return;
      }
      attemptRun = -1; // retry, reset loop
    }
  }

  /**
   * The judge turn: a structured read of a non-pass report. The role already
   * stated its verdict, so the only new information is the action items the
   * remediation turn consumes.
   */
  private async runJudge(
    step: PipelineStep,
    result: GatedPhaseResult,
    sessionId: string,
  ): Promise<Awaited<ReturnType<typeof judgePhase>>> {
    const session = this.activeSession;
    if (!session) {
      throw new Error("No agent session available for judge phase");
    }
    const judge = await judgePhase(
      session,
      this.models.executor,
      step.phase,
      result.raw,
      MAX_JUDGE_ACTION_ITEMS,
      this.cfg.phaseTimeoutMs,
    );
    // Keep the structured items for the remediation turn instead of discarding
    // them and forcing the fixer to re-read the prose.
    if (judge.actionItems.length > 0) result.actionItems = judge.actionItems;
    if (!judge.parsed) {
      events.emit("log", {
        level: "warn",
        message: `[judge ${step.phase}] judge output was unparseable; fail-closed verdict: ${judge.status}`,
        timestamp: new Date().toISOString(),
      });
    }
    events.emit("log", {
      level: "info",
      message: `[judge ${step.phase}] ${judge.summary}`,
      timestamp: new Date().toISOString(),
    });
    return judge;
  }

  /**
   * Gates fail closed: a report with no parseable verdict marker (empty,
   * truncated, or hallucinated output) is treated as BLOCKED rather than
   * silently passed, and the decision is surfaced in the log stream.
   */
  private gatedVerdict(phase: PhaseName, result: PhaseResult, parsed: Verdict | null): Verdict {
    if (parsed !== null) return parsed;
    events.emit("log", {
      level: "warn",
      message:
        `[${phase}] report had no parseable verdict marker; fail-closed → BLOCKED. ` +
        `Inspect ${result.reportPath ?? "the raw report"}.`,
      timestamp: new Date().toISOString(),
    });
    return "blocked";
  }

  private async runOnce(
    step: PipelineStep,
    ctx: PhaseContext,
    sessionId: string,
    iteration: Iteration,
    attempt: number,
    model: Models[keyof Models],
  ): Promise<GatedPhaseResult> {
    const startedAt = new Date().toISOString();
    // REV-001: a read-only phase must not touch the repository. Snapshot a hash
    // of the working tree around the step and fail closed if it moved — the
    // guarantee is enforced here, not by the agent's own permission
    // configuration. Best-effort by construction: see `treeHash` for what the
    // signature cannot see (write-and-restore, writes outside the hashed work
    // tree, ignored paths) and {@link readOnlyTreeViolation} for why a missing
    // signature blocks instead of passing.
    const before = step.readOnly ? treeHash(ctx.projectPath) : undefined;
    const res = await step.fn(ctx);
    const readOnlyViolation =
      step.readOnly === true &&
      readOnlyTreeViolation(before, treeHash(ctx.projectPath));
    // Fail closed on an empty EXECUTE result: `session.prompt` can resolve on
    // a step boundary (e.g. a reasoning-only turn) while the build agent is
    // still working, yielding a report with no output. That must never count
    // as a pass — throw before any (empty) report artifact is persisted.
    if (step.phase === "EXECUTE" && res.text.trim() === "") {
      throw new Error("EXECUTE produced an empty report (the build agent returned no output)");
    }
    const finishedAt = new Date().toISOString();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    const reportText = readOnlyViolation
      ? this.readOnlyViolationReport(step.phase, res.text)
      : res.text;
    // Phase output is model output that echoes repository content: strip terminal
    // escapes at the boundary where it is persisted in `.harness` (and rendered
    // from there into PROGRESS.md) so nothing reachable from here can control a
    // terminal (SEC-004).
    const persistedText = sanitizeTerminalText(reportText);
    const reportPath = writeReport(this.cfg.projectPath, iteration.index, step.phase, attempt, persistedText);
    const result: GatedPhaseResult = {
      iteration: iteration.index,
      phase: step.phase,
      attempt,
      model: formatModel(model),
      sessionId,
      messageId: res.messageId,
      summary: persistedText.slice(0, SUMMARY_MAX_LENGTH),
      raw: reportText,
      reportPath,
      startedAt,
      finishedAt,
      // A read-only violation wins over the phase's own structured verdict.
      ...(readOnlyViolation
        ? { forcedVerdict: "blocked" as Verdict }
        : res.authoritativeVerdict
          ? { authoritativeVerdict: res.authoritativeVerdict }
          : {}),
      ...(res.crash && !readOnlyViolation ? { crash: res.crash } : {}),
    };
    events.emit("phaseEnd", { result, durationMs });
    return result;
  }

  /**
   * A read-only phase mutated the working tree (REV-001). Log the violation and
   * build the fail-closed report huginn records instead of the phase's output.
   * Nothing is reverted — blocking is the whole response, so the caller's own
   * edits are never destroyed.
   */
  private readOnlyViolationReport(phase: PhaseName, output: string): string {
    const message = `[${phase}] read-only phase modified the working tree; fail-closed → BLOCKED`;
    events.emit("log", {
      level: "warn",
      message,
      timestamp: new Date().toISOString(),
    });
    return [
      `# ${phase} — read-only violation`,
      "",
      message,
      "",
      "This phase is read-only (REV-001): it must not create, modify or delete",
      "repository files. The working tree changed while it ran, so its output is",
      "discarded and the phase is treated as BLOCKED. No changes were reverted.",
      "",
      "## Phase output (untrusted, discarded)",
      output,
    ].join("\n");
  }

  private record(
    result: PhaseResult & { raw: string },
    iteration: number,
    step: PipelineStep,
    attempt: number,
    durationMs?: number,
  ): void {
    const entry: HistoryEntry = {
      iteration,
      phase: step.phase,
      attempt,
      verdict: result.verdict,
      model: result.model,
      sessionId: result.sessionId,
      messageId: result.messageId,
      // The summary is persisted in `.harness/state.json` and rendered into
      // PROGRESS.md, so model-derived text is sanitized here too (SEC-004).
      summary: sanitizeTerminalText(result.summary),
      reportPath: result.reportPath,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };
    this.state.history.push(entry);
    this.state.phaseAttempts[this.attemptKey(iteration, step.phase)] = attempt;
    this.emitVerdict(iteration, step.phase, result.verdict ?? "warning", attempt, durationMs);
  }

  private emitVerdict(iteration: number, phase: PhaseName, verdict: Verdict, attempt: number, durationMs?: number): void {
    events.emit("verdict", { iteration, phase, verdict, attempt, durationMs });
  }

  private recordSkippedSpecAudit(
    iteration: Iteration,
    reason: "greenfield" | "unchanged",
    docHash: string,
  ): void {
    const now = new Date().toISOString();
    const model = formatModel(this.models.executor);
    const lastIteration = this.state.specAudit?.iteration;
    const shortHash = docHash.slice(0, 8);
    const message =
      reason === "greenfield"
        ? "[SPEC_AUDIT] skipped — no implementation code to audit (greenfield)"
        : `[SPEC_AUDIT] skipped — spec/adr/plan unchanged since the audit in iteration ${lastIteration ?? "?"} (doc ${shortHash})`;
    const summary =
      reason === "greenfield"
        ? "Skipped — no implementation code to audit (greenfield)."
        : `Skipped — spec/adr/plan unchanged since the audit in iteration ${lastIteration ?? "?"} (doc ${shortHash}).`;
    events.emit("phaseStart", {
      iteration: iteration.index,
      phase: "SPEC_AUDIT",
      attempt: 1,
      model,
    });
    events.emit("log", { level: "info", message });
    const entry: HistoryEntry = {
      iteration: iteration.index,
      phase: "SPEC_AUDIT",
      attempt: 1,
      verdict: "skipped",
      model,
      sessionId: "",
      messageId: "",
      summary,
      startedAt: now,
      finishedAt: now,
    };
    this.state.history.push(entry);
    // a skip is not an attempt: leave phaseAttempts untouched so a later real
    // audit on resume still starts at attempt 1.
    this.emitVerdict(iteration.index, "SPEC_AUDIT", "skipped", 1);
    events.emit("phaseEnd", {
      result: {
        iteration: iteration.index,
        phase: "SPEC_AUDIT",
        attempt: 1,
        verdict: "skipped",
        model,
        sessionId: "",
        messageId: "",
        summary: entry.summary,
        raw: "",
        startedAt: now,
        finishedAt: now,
      },
    });
  }

  /**
   * Ask the architect (`thinker`) to root-cause a blocked gate in READ-ONLY
   * mode, under the same worker-tree guard the auditors use.
   *
   * The diagnosis is persisted to `.harness/reports/II-FIX_*-N-diagnosis.md` and
   * recorded as its own history entry naming the real thinker model, so the model
   * that reasoned and the executor that edits are both auditable. A tree
   * mutation discards the plan (the architect cannot be trusted after writing)
   * and the executor falls back to the raw report + action items.
   */
  private async runDiagnosis(
    step: PipelineStep,
    ctx: PhaseContext,
    iteration: Iteration,
    attempt: number,
    report: string,
    actionItems: string[] | undefined,
  ): Promise<{ plan?: string; reportPath?: string }> {
    const fixPhase = step.fixPhase;
    if (!fixPhase) return {};

    const before = treeHash(ctx.projectPath);
    let res: { text: string; messageId: string };
    try {
      res = await this.withPhaseSession(ctx, iteration, `${fixPhase} diagnosis`, this.models.thinker, (diagnosisCtx) =>
        diagnoseFindings(diagnosisCtx, step.fixLabel, report, undefined, actionItems),
      );
    } catch (err) {
      events.emit("log", {
        level: "warn",
        message: `[${fixPhase}] diagnosis failed (${
          err instanceof Error ? err.message : String(err)
        }); the executor will fix from the report`,
        timestamp: new Date().toISOString(),
      });
      return {};
    }

    const violation = readOnlyTreeViolation(before, treeHash(ctx.projectPath));
    const text = violation ? this.readOnlyViolationReport(fixPhase, res.text) : res.text;
    const reportPath = writeReport(
      this.cfg.projectPath,
      iteration.index,
      fixPhase,
      attempt,
      sanitizeTerminalText(text),
      "-diagnosis",
    );
    this.recordFix(
      { text, messageId: res.messageId },
      iteration.index,
      step,
      attempt,
      formatModel(this.models.thinker),
      { reportPath, label: "Diagnosis", emitLifecycle: false },
    );
    if (violation) {
      events.emit("log", {
        level: "warn",
        message: `[${fixPhase}] read-only violation during diagnosis; its remediation plan was discarded`,
        timestamp: new Date().toISOString(),
      });
      return { reportPath };
    }
    return { plan: res.text, reportPath };
  }

  private recordFix(
    res: { text: string; messageId: string },
    iteration: number,
    step: PipelineStep,
    attempt: number,
    model: string,
    opts: { reportPath?: string; label?: string; emitLifecycle?: boolean } = {},
  ): void {
    if (!step.fixPhase) return;
    const now = new Date().toISOString();
    const prefix = opts.label ? `${opts.label}: ` : "";
    const entry: HistoryEntry = {
      iteration,
      phase: step.fixPhase,
      attempt,
      model,
      sessionId: "",
      messageId: res.messageId,
      summary: sanitizeTerminalText(`${prefix}${res.text}`).slice(0, SUMMARY_MAX_LENGTH),
      ...(opts.reportPath ? { reportPath: opts.reportPath } : {}),
      startedAt: now,
      finishedAt: now,
    };
    this.state.history.push(entry);
    // A diagnosis is recorded for traceability only; the application turn owns
    // the UI row and its verdict.
    if (opts.emitLifecycle === false) return;
    // A finished fix phase must terminate its UI row: runPhase already emitted
    // `phaseStart` for the FIX phase, so close the loop with a pass verdict.
    this.emitVerdict(iteration, step.fixPhase, "pass", attempt);
    events.emit("phaseEnd", {
      result: {
        iteration,
        phase: step.fixPhase,
        attempt,
        verdict: "pass",
        model: entry.model,
        sessionId: "",
        messageId: res.messageId,
        summary: entry.summary,
        raw: res.text,
        startedAt: now,
        finishedAt: now,
      },
    });
  }

  private recordError(
    iteration: number,
    step: PipelineStep,
    attempt: number,
    sessionId: string,
    model: string,
    message: string,
  ): void {
    const now = new Date().toISOString();
    const reason = sanitizeTerminalText(message);
    const reportPath = writeReport(
      this.cfg.projectPath,
      iteration,
      step.phase,
      attempt,
      `# ${step.phase} — attempt ${attempt} (error)\n\n${reason}\n`,
    );
    const entry: HistoryEntry = {
      iteration,
      phase: step.phase,
      attempt,
      verdict: "blocked",
      model,
      sessionId,
      messageId: "",
      summary: sanitizeTerminalText(`Phase ${step.phase} errored: ${message}`).slice(
        0,
        SUMMARY_MAX_LENGTH,
      ),
      reportPath,
      startedAt: now,
      finishedAt: now,
    };
    this.state.history.push(entry);
    this.state.phaseAttempts[this.attemptKey(iteration, step.phase)] = attempt;
    events.emit("verdict", {
      iteration,
      phase: step.phase,
      verdict: "blocked",
      attempt,
    });
  }
}
