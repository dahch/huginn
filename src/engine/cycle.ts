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
  secureCheck,
  review,
  docSync,
  commitAll,
  fixFindings,
  fixSpec,
  fixSecurity,
  type PhaseContext,
} from "./phases";
import { parseValidateStepVerdict, parseSpecAuditVerdict, judgePhase } from "./gate";
import { profilePreamble, profileSpec, validateProfilePhases, type ProfileName } from "./profiles";
import { buildIterationReceipt, treeHash, writeIterationReceipt } from "./receipts";
import type { Verdict, PhaseName, PhaseResult, DecisionRequest, DecisionChoice } from "./types";
import { events } from "./engineEvents";
import { DecisionBroker } from "./decisionBroker";
import {
  headCommit,
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
import type { HarnessState, HistoryEntry } from "../state/schema";
import { createClient, createSession, sessionExists, abortSession } from "../server/client";
import { WorktreeManager, type Sandbox } from "./worktree";
import { resolveDatabasePath } from "../muninn/db/client.js";
import type { IAgentRuntime, IAgentSession } from "./agent/types.js";
import { OpencodeRuntimeAdapter } from "./agent/adapters/opencode.js";

type PhaseFn = (ctx: PhaseContext) => Promise<{ text: string; messageId: string }>;

interface PipelineStep {
  phase: PhaseName;
  fn: PhaseFn;
  gate: "spec-audit" | "validate-step" | "judge" | "none";
  fixPhase: PhaseName | null;
  fixLabel: string;
  blocking: boolean;
}

/**
 * The phase implementations, keyed by phase. A methodology profile (REQ-36 /
 * ADR-35) is just an ordered selection of these, so a profile can reorder or
 * subset the pipeline — and `strict-tdd` can run `TEST_MODULE` twice (tests
 * first, then the gate) — without touching the engine.
 */
const STEP_BY_PHASE: Partial<Record<PhaseName, PipelineStep>> = {
  SPEC_AUDIT: { phase: "SPEC_AUDIT", fn: specAudit, gate: "spec-audit", fixPhase: "FIX_SPEC", fixLabel: "spec audit", blocking: true },
  EXECUTE: { phase: "EXECUTE", fn: execute, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
  VALIDATE_STEP: { phase: "VALIDATE_STEP", fn: validateStep, gate: "validate-step", fixPhase: "FIX_VALIDATE", fixLabel: "validation gate", blocking: true },
  TEST_MODULE: { phase: "TEST_MODULE", fn: testModule, gate: "judge", fixPhase: "FIX_TEST", fixLabel: "test failures", blocking: true },
  SECURE_CHECK: { phase: "SECURE_CHECK", fn: secureCheck, gate: "judge", fixPhase: "FIX_SECURITY", fixLabel: "security audit", blocking: true },
  REVIEW: { phase: "REVIEW", fn: review, gate: "judge", fixPhase: "FIX_REVIEW", fixLabel: "code review", blocking: true },
  DOC_SYNC: { phase: "DOC_SYNC", fn: docSync, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
  COMMIT_ALL: { phase: "COMMIT_ALL", fn: commitAll, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
};

/**
 * Resolve a profile into runnable steps, failing closed (AC-36.6) if it names a
 * phase the engine cannot run — a broken profile must never silently degrade to
 * the default.
 */
function pipelineFor(profile: ProfileName | undefined): PipelineStep[] {
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
  const steps = spec.phases.map((phase) => ({ ...STEP_BY_PHASE[phase]! }));
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
  client?: OpencodeClient;
  runtime?: IAgentRuntime;
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
  readonly client?: OpencodeClient;
  readonly runtime: IAgentRuntime;
  private activeSession?: IAgentSession;
  private plan: { content: string; iterations: Iteration[] };
  private state: HarnessState;
  private models: Models;
  private decisions = new DecisionBroker();
  private paused = false;
  /** Verdict of the most recently completed phase (for the iteration receipt). */
  private lastVerdict?: Verdict;
  private abortRequested = false;
  private worktrees?: WorktreeManager;
  private sandboxEnabledCache?: boolean;
  private outcome: { reason: "completed" | "aborted" | "error"; error?: string } = { reason: "completed" };

  constructor(opts: CycleEngineOptions) {
    this.cfg = opts.cfg;
    if (opts.runtime) {
      this.runtime = opts.runtime;
      if (opts.client) {
        this.client = opts.client;
      } else if ("client" in opts.runtime && (opts.runtime as unknown as { client?: OpencodeClient }).client) {
        this.client = (opts.runtime as unknown as { client: OpencodeClient }).client;
      }
      // Non-OpenCode runtimes: leave client undefined — all prompts go through session
    } else {
      this.client = opts.client ?? createClient(`http://127.0.0.1:${opts.cfg.port}`);
      this.runtime = new OpencodeRuntimeAdapter({
        client: this.client,
        port: opts.cfg.port,
        projectPath: opts.cfg.projectPath,
      });
    }
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
   * Best-effort removal of every sandbox worktree. Registered on process
   * termination so an unexpected exit never leaves `.huginn/worktrees` behind.
   */
  cleanupSandboxes(): void {
    try {
      this.getWorktrees().cleanupAll();
    } catch (err) {
      events.emit("log", {
        level: "warn",
        message: `[sandbox] cleanup failed: ${(err as Error).message}`,
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
      void this.activeSession.abort();
    } else if (this.runtime.id === "opencode" && this.client && this.state.iterationSessionId) {
      void abortSession(this.client, this.state.iterationSessionId);
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

  async run(): Promise<{ reason: "completed" | "aborted" | "error"; error?: string }> {
    if (!isGitRepo(this.cfg.projectPath)) {
      throw new Error(`"${this.cfg.projectPath}" is not a git repository.`);
    }

    // Best-effort: reclaim worktrees (and orphaned branches) left behind by a
    // previous interrupted run before creating this run's sandboxes.
    if (this.sandboxingEnabled()) {
      try {
        const reclaimed = this.getWorktrees().cleanupAll();
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
      this.outcome = { reason: "error", error: (err as Error).message };
      this.state.finishedAt = new Date().toISOString();
      this.state.aborted = true;
      this.persist();
      events.emit("done", { reason: "error", error: (err as Error).message });
      return this.outcome;
    }

    if (this.abortRequested) return this.finishAborted();

    this.outcome = { reason: "completed" };
    if (!this.cfg.onlyPhase) {
      // debug mode (--only-phase) keeps state resumable
      this.state.finishedAt = new Date().toISOString();
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

      events.emit("iterationStart", {
        iteration: iteration.index,
        totalIterations: iterations.length,
        title: iteration.title,
        modules: iteration.modules,
      });
      events.emit("log", {
        level: "info",
        message: `▶ Iteration ${iteration.index}/${iterations.length} — ${iteration.title}`,
        timestamp: new Date().toISOString(),
      });
      await this.runIteration(iteration);

      // don't mark an aborted iteration as complete, or a resume would skip
      // it entirely even though its phases never finished
      if (this.abortRequested) return;

      events.emit("iterationEnd", {
        iteration: iteration.index,
        title: iteration.title,
      });

      if (this.cfg.onlyPhase) {
        // debug mode: run the phase on a single iteration, leave state resumable
        return;
      }
      // mark iteration complete
      this.state.currentIteration = iteration.index + 1;
      this.state.currentPhase = "SPEC_AUDIT";
      this.persist();
    }
  }

  private async runIteration(iteration: Iteration): Promise<void> {
    // When sandboxing is enabled, isolate the iteration in a git worktree and
    // run every phase against `workPath`; the primary working tree is only
    // touched by `promoteSandbox` on success. The sandbox is created first so
    // its path can scope the agent session. `settled` guarantees the sandbox is
    // cleaned up exactly once (promoted OR discarded), even on abort/throw.
    const sandbox = this.sandboxingEnabled()
      ? this.getWorktrees().createSandbox(this.cfg.projectPath, iteration.index)
      : undefined;
    const workPath = sandbox?.path ?? this.cfg.projectPath;

    // Muninn memory is durable state that must outlive an ephemeral sandbox:
    // always resolve the database from the PRIMARY project root so the
    // harness-side symbol graph (indexed by `commitAll`) is never written into
    // the worktree and silently lost when the sandbox is promoted/discarded.
    // `projectPath`/`directory` stay on the sandbox so code edits and compiler
    // reads target the isolated worktree.
    const primaryDbPath = resolveDatabasePath(undefined, this.cfg.projectPath);

    // Scope the server-side agent session to `workPath` so the build agent's
    // tools edit the sandbox rather than the primary tree (REQ-17). Under
    // sandboxing a fresh session is required: any persisted `iterationSessionId`
    // was bound to a different directory and must not be reused.
    const sessionId = await this.ensureSession(iteration, workPath, sandbox !== undefined);

    let settled = false;
    try {
      const baseCommit = headCommit(workPath) ?? undefined;
      this.state.iterationBaseCommit = baseCommit;
      this.persist();

      const explicitModules = iteration.modules ?? [];
      const ctx: PhaseContext = {
        client: this.client,
        session: this.activeSession,
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
        phaseTimeoutMs: this.cfg.phaseTimeoutMs,
      };

      // resume point: only meaningful when resuming the exact iteration we are on.
      // Capture it once; currentPhase advances as steps run. An ephemeral sandbox
      // cannot resume mid-iteration: a prior run's worktree was discarded at
      // startup (cleanupAll), so any earlier phase's changes are gone and must re-run.
      const steps = pipelineFor(this.cfg.profile);
      // Resume at the first step this iteration has not recorded yet. Keying the
      // cursor off a phase *id* was wrong: `currentPhase` starts at SPEC_AUDIT every
      // iteration, so a profile that does not begin with SPEC_AUDIT (odd/rdd/
      // strict-tdd) matched no step and silently ran nothing (REV-001).
      let resumeIndex = 0;
      if (!this.cfg.onlyPhase && !sandbox && this.state.currentIteration === iteration.index) {
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

        // refresh modules once the iteration has produced changes
        if (step.phase === "VALIDATE_STEP" || step.phase === "TEST_MODULE") {
          if (explicitModules.length === 0) {
            ctx.modules = inferModules(workPath, ctx.baseCommit);
          }
        }

        if (step.phase === "SPEC_AUDIT" && !hasImplementationCode(workPath)) {
          // greenfield: nothing to audit until the iteration produces code
          this.recordSkippedSpecAudit(iteration);
        } else {
          await this.runPhase(step, ctx, sessionId, iteration);
        }

        if (this.abortRequested) return;
        verdicts.push({ phase: step.phase, verdict: this.lastVerdict ?? "skipped" });
        this.persist();
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
        const path = writeIterationReceipt(this.cfg.projectPath, receipt);
        if (path) {
          events.emit("log", {
            level: "info",
            message: `[huginn] receipt written: ${relative(this.cfg.projectPath, path)}`,
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
        if (result.method === "none") {
          events.emit("log", {
            level: "info",
            message: `[sandbox] iteration ${iteration.index}: no changes to promote`,
            timestamp: new Date().toISOString(),
          });
        } else if (result.promoted) {
          events.emit("log", {
            level: "info",
            message: `[sandbox] iteration ${iteration.index}: promoted via ${result.method} (${result.commits.length} commit(s))`,
            timestamp: new Date().toISOString(),
          });
        } else {
          // Conflict: the primary tree was restored and the branch preserved by
          // `promoteSandbox`. Fail closed so the run finishes as an error rather
          // than silently reporting success (REQ-17, AC-17.4).
          events.emit("log", {
            level: "warn",
            message: `[sandbox] iteration ${iteration.index}: promotion (${result.method}) conflicted; branch ${sandbox.branch} preserved for recovery`,
            timestamp: new Date().toISOString(),
          });
          throw new Error(
            `Sandbox promotion for iteration ${iteration.index} conflicted (method: ${result.method}). ` +
              `The primary tree is intact and branch ${sandbox.branch} was preserved for manual recovery; ` +
              `resolve or delete that branch, then re-run.`,
          );
        }
      }
    } finally {
      // Aborted, --only-phase, or a thrown phase error: never touch the primary
      // tree — discard the sandbox (worktree + branch). Exactly once.
      if (sandbox && !settled) {
        this.getWorktrees().discardSandbox(sandbox);
      }
    }
  }

  private async ensureSession(
    iteration: Iteration,
    directory: string,
    sandboxed: boolean,
  ): Promise<string> {
    // A persisted session was bound to the directory it was created with; under
    // sandboxing that directory changes every run, so never reuse it.
    const existing = this.state.iterationSessionId;
    if (!sandboxed && existing && this.activeSession && this.activeSession.id === existing) {
      return existing;
    }
    const session = await this.runtime.createSession({
      title: `iter ${iteration.index}: ${iteration.title}`,
      directory,
    });
    this.activeSession = session;
    this.state.iterationSessionId = session.id;
    this.persist();
    return session.id;
  }

  private attemptKey(iteration: number, phase: PhaseName): string {
    return `${iteration}:${phase}`;
  }

  private async runPhase(
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
      iterationTitle: iteration.title,
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

      let result: PhaseResult & { raw: string };
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

      let verdict: Verdict | undefined;
      if (step.gate === "spec-audit") {
        verdict = this.gatedVerdict(step.phase, result, parseSpecAuditVerdict(result.raw));
      } else if (step.gate === "validate-step") {
        verdict = this.gatedVerdict(step.phase, result, parseValidateStepVerdict(result.raw));
      } else if (step.gate === "judge") {
        const sessionOrClient = this.activeSession ?? this.client;
        if (!sessionOrClient) {
          throw new Error("No agent session or OpenCode client available for judge phase");
        }
        const judge = await judgePhase(
          sessionOrClient,
          sessionId,
          this.models.executor,
          step.phase,
          result.raw,
          MAX_JUDGE_ACTION_ITEMS,
          this.cfg.phaseTimeoutMs,
        );
        verdict = judge.status;
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
      } else {
        verdict = "pass";
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

      // blocking → fix with thinker, unless out of retries
      if (attemptRun < this.cfg.maxRetries && step.fixPhase) {
        await this.waitIfPaused();
        if (this.abortRequested) return;
        events.emit("phaseStart", {
          iteration: iteration.index,
          totalIterations: this.plan.iterations.length,
          iterationTitle: iteration.title,
          phase: step.fixPhase,
          attempt: curAttempt,
          model: formatModel(this.models.thinker),
          startedAt: new Date().toISOString(),
        });
        const fixCtx = ctx;
        let fixRes;
        if (step.fixPhase === "FIX_SPEC") fixRes = await fixSpec(fixCtx, result.raw);
        else if (step.fixPhase === "FIX_SECURITY") fixRes = await fixSecurity(fixCtx, result.raw);
        else fixRes = await fixFindings(fixCtx, step.fixLabel, result.raw);
        const fixKey = this.attemptKey(iteration.index, step.fixPhase);
        this.state.phaseAttempts[fixKey] = (this.state.phaseAttempts[fixKey] ?? 0) + 1;
        this.recordFix(fixRes, iteration.index, step, curAttempt);
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
          message: `Gate ${step.phase} is blocked. Retry with thinker, force-continue, or abort?`,
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
  ): Promise<PhaseResult & { raw: string }> {
    const startedAt = new Date().toISOString();
    const res = await step.fn(ctx);
    // Fail closed on an empty EXECUTE result: `session.prompt` can resolve on
    // a step boundary (e.g. a reasoning-only turn) while the build agent is
    // still working, yielding a report with no output. That must never count
    // as a pass — throw before any (empty) report artifact is persisted.
    if (step.phase === "EXECUTE" && res.text.trim() === "") {
      throw new Error("EXECUTE produced an empty report (the build agent returned no output)");
    }
    const finishedAt = new Date().toISOString();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    const reportPath = writeReport(this.cfg.projectPath, iteration.index, step.phase, attempt, res.text);
    const result: PhaseResult = {
      iteration: iteration.index,
      phase: step.phase,
      attempt,
      model: formatModel(model),
      sessionId,
      messageId: res.messageId,
      summary: res.text.slice(0, SUMMARY_MAX_LENGTH),
      raw: res.text,
      reportPath,
      startedAt,
      finishedAt,
    };
    events.emit("phaseEnd", { result, durationMs });
    return result;
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
      summary: result.summary,
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

  private recordSkippedSpecAudit(iteration: Iteration): void {
    const now = new Date().toISOString();
    const model = formatModel(this.models.executor);
    events.emit("phaseStart", {
      iteration: iteration.index,
      phase: "SPEC_AUDIT",
      attempt: 1,
      model,
    });
    events.emit("log", {
      level: "info",
      message: "[SPEC_AUDIT] skipped — no implementation code to audit (greenfield)",
    });
    const entry: HistoryEntry = {
      iteration: iteration.index,
      phase: "SPEC_AUDIT",
      attempt: 1,
      verdict: "skipped",
      model,
      sessionId: "",
      messageId: "",
      summary: "Skipped — no implementation code to audit (greenfield).",
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

  private recordFix(
    res: { text: string; messageId: string },
    iteration: number,
    step: PipelineStep,
    attempt: number,
  ): void {
    if (!step.fixPhase) return;
    const now = new Date().toISOString();
    const entry: HistoryEntry = {
      iteration,
      phase: step.fixPhase,
      attempt,
      model: formatModel(this.models.thinker),
      sessionId: "",
      messageId: res.messageId,
      summary: res.text.slice(0, SUMMARY_MAX_LENGTH),
      startedAt: now,
      finishedAt: now,
    };
    this.state.history.push(entry);
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
    const reportPath = writeReport(
      this.cfg.projectPath,
      iteration,
      step.phase,
      attempt,
      `# ${step.phase} — attempt ${attempt} (error)\n\n${message}\n`,
    );
    const entry: HistoryEntry = {
      iteration,
      phase: step.phase,
      attempt,
      verdict: "blocked",
      model,
      sessionId,
      messageId: "",
      summary: `Phase ${step.phase} errored: ${message}`.slice(0, SUMMARY_MAX_LENGTH),
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
