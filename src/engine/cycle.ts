import type { OpencodeClient } from "@opencode-ai/sdk";
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

type PhaseFn = (ctx: PhaseContext) => Promise<{ text: string; messageId: string }>;

interface PipelineStep {
  phase: PhaseName;
  fn: PhaseFn;
  gate: "spec-audit" | "validate-step" | "judge" | "none";
  fixPhase: PhaseName | null;
  fixLabel: string;
  blocking: boolean;
}

const PIPELINE: PipelineStep[] = [
  { phase: "SPEC_AUDIT", fn: specAudit, gate: "spec-audit", fixPhase: "FIX_SPEC", fixLabel: "spec audit", blocking: true },
  { phase: "EXECUTE", fn: execute, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
  { phase: "VALIDATE_STEP", fn: validateStep, gate: "validate-step", fixPhase: "FIX_VALIDATE", fixLabel: "validation gate", blocking: true },
  { phase: "TEST_MODULE", fn: testModule, gate: "judge", fixPhase: "FIX_TEST", fixLabel: "test failures", blocking: true },
  { phase: "SECURE_CHECK", fn: secureCheck, gate: "judge", fixPhase: "FIX_SECURITY", fixLabel: "security audit", blocking: true },
  { phase: "REVIEW", fn: review, gate: "judge", fixPhase: "FIX_REVIEW", fixLabel: "code review", blocking: true },
  { phase: "DOC_SYNC", fn: docSync, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
  { phase: "COMMIT_ALL", fn: commitAll, gate: "none", fixPhase: null, fixLabel: "", blocking: false },
];

const PAUSE_POLL_MS = 200;
const SUMMARY_MAX_LENGTH = 300;
const MAX_JUDGE_ACTION_ITEMS = 8;

export interface CycleEngineOptions {
  cfg: RunConfig;
  client?: OpencodeClient;
  plan: { content: string; iterations: Iteration[] };
  state?: HarnessState;
}

export class CycleEngine {
  private cfg: RunConfig;
  readonly client: OpencodeClient;
  private plan: { content: string; iterations: Iteration[] };
  private state: HarnessState;
  private models: Models;
  private decisions = new DecisionBroker();
  private paused = false;
  private abortRequested = false;
  private outcome: { reason: "completed" | "aborted" | "error"; error?: string } = { reason: "completed" };

  constructor(opts: CycleEngineOptions) {
    this.cfg = opts.cfg;
    this.client = opts.client ?? createClient(`http://127.0.0.1:${opts.cfg.port}`);
    this.plan = opts.plan;
    this.models = resolveModels(opts.cfg.thinker, opts.cfg.executor);
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
    this.decisions.resolveAll("abort");
    // Interrupt the in-flight agent request so the loop can observe the abort
    // immediately instead of waiting out a long phase timeout: aborting the
    // session server-side rejects the pending `session.prompt`/`command`.
    if (this.state.iterationSessionId) {
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
    const sessionId = await this.ensureSession(iteration);
    const baseCommit = headCommit(this.cfg.projectPath) ?? undefined;
    this.state.iterationBaseCommit = baseCommit;
    this.persist();

    const explicitModules = iteration.modules ?? [];
    const ctx: PhaseContext = {
      client: this.client,
      sessionId,
      models: this.models,
      projectPath: this.cfg.projectPath,
      iteration,
      specPath: this.cfg.specPath,
      adrPath: this.cfg.adrPath,
      planPath: this.cfg.planPath,
      modules: explicitModules,
      baseCommit,
      phaseTimeoutMs: this.cfg.phaseTimeoutMs,
    };

    // resume point: only meaningful when resuming the exact iteration we are on.
    // Capture it once; currentPhase advances as steps run.
    const resumePhase =
      !this.cfg.onlyPhase && this.state.currentIteration === iteration.index
        ? this.state.currentPhase
        : null;
    let pastResume = resumePhase === null;

    for (const step of PIPELINE) {
      if (this.abortRequested) return;
      if (this.cfg.onlyPhase && step.phase !== this.cfg.onlyPhase) continue;
      if (!pastResume) {
        if (step.phase === resumePhase) pastResume = true;
        else continue;
      }

      this.state.currentPhase = step.phase;

      // refresh modules once the iteration has produced changes
      if (step.phase === "VALIDATE_STEP" || step.phase === "TEST_MODULE") {
        if (explicitModules.length === 0) {
          ctx.modules = inferModules(this.cfg.projectPath, ctx.baseCommit);
        }
      }

      if (step.phase === "SPEC_AUDIT" && !hasImplementationCode(this.cfg.projectPath)) {
        // greenfield: nothing to audit until the iteration produces code
        this.recordSkippedSpecAudit(iteration);
      } else {
        await this.runPhase(step, ctx, sessionId, iteration);
      }

      if (this.abortRequested) return;
      this.persist();
    }
  }

  private async ensureSession(iteration: Iteration): Promise<string> {
    const existing = this.state.iterationSessionId;
    if (existing && (await sessionExists(this.client, existing))) {
      return existing;
    }
    const created = await createSession(this.client, `iter ${iteration.index}: ${iteration.title}`);
    this.state.iterationSessionId = created.id;
    this.persist();
    return created.id;
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
        const judge = await judgePhase(
          this.client,
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
