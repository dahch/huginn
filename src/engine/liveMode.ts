import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RunConfig } from "../config";
import { createClient, createSession, prompt, abortSession } from "../server/client";
import type { IAgentRuntime, IAgentSession } from "./agent/types.js";
import { OpencodeRuntimeAdapter } from "./agent/adapters/opencode.js";
import { getAgentRuntime } from "./agent/registry.js";
import type { AgentTarget } from "../agents/integrator.js";
import { MemoryService } from "../muninn/service/memory-service.js";
import { resolveDatabasePath } from "../muninn/db/client.js";
import { DecisionBroker } from "./decisionBroker";
import { events, type LiveStage } from "./engineEvents";
import { formatQuestionAnswer, parseQuestionBlock } from "./questionBlock.js";
import { randomUUID } from "node:crypto";
import type { DecisionChoice, DecisionRequest, QuestionItem } from "./types";
import { formatModel, resolveModels, type Models } from "./modelRouter";
import { appendAdrPrompt, remainingPlanPrompt, unwrapFences, updateSpecPrompt, validateDraftFormat, type DraftDocType } from "./planMode";
import { CycleEngine } from "./cycle";
import { loadPlan } from "../plan/parser";
import { commitDocs, readOptional, repoContext, resetHarnessState, stageDocsForReview, unstageDocs, writeDoc } from "./liveRepo";
import { git } from "./diff.js";
import { sanitizeTerminalText } from "../util/text.js";

/** How long an unanswered clarifying question waits before the turn aborts (AC-37.4). */
const QUESTION_TIMEOUT_MS = 10 * 60_000;
const LIVE_PROMPT_TIMEOUT_MS = 20 * 60 * 1000;

export interface DiagnosticsInfo {
  gitBranch: string;
  gitClean: boolean;
  worktreeSandbox: boolean;
  runtimeName: string;
  thinkerModel: string;
  executorModel: string;
  memoryStats: {
    entitiesCount: number;
    observationsCount: number;
    /**
     * Present when the Muninn database could not be opened or queried
     * (REQ-30 / AC-30.5). "Unavailable" must never be indistinguishable from
     * "empty": with this set, the counts are meaningless and `/status` shows the
     * sanitized reason instead of `0 entities, 0 observations`.
     */
    error?: string;
  };
}


/** Raised when the user aborts a live session (refine/draft/approve). */
export class LiveAbortError extends Error {
  constructor() {
    super("live session aborted");
    this.name = "LiveAbortError";
  }
}

export interface LiveEngineOptions {
  cfg: RunConfig;
  client?: OpencodeClient;
  runtime?: IAgentRuntime;
  /** Optional factory used by `switchRuntime` to resolve a runtime for a target (tests inject stubs). */
  runtimeFactory?: (target: AgentTarget) => IAgentRuntime;
  /** Initial idea. The TUI sends messages one at a time; headless passes the whole idea here. */
  idea?: string;
}

/**
 * Extracts the refined scope from the thinker's reply. The contract is a
 * "SCOPE:" label followed by a fenced markdown block (or a bare paragraph).
 * Returns null when nothing parseable is present — callers fail closed.
 */
export function extractScopeBlock(text: string): string | null {
  const fenced = text.match(/^SCOPE:\s*\n?```(?:markdown|md)?\s*\n([\s\S]*?)```/im);
  if (fenced) {
    const inner = fenced[1].trim();
    return inner || null;
  }
  const bare = text.match(/^SCOPE:\s*\n?([\s\S]+)/im);
  if (!bare) return null;
  const rest = bare[1].replace(/```\s*$/g, "").trim();
  return rest || null;
}

function refineSystemPrompt(projectPath: string): string {
  const existingSpec = readOptional(`${projectPath}/spec.md`);
  const existingAdr = readOptional(`${projectPath}/adr.md`);
  const existingPlan = readOptional(`${projectPath}/plan.md`);
  const planSummary = existingPlan
    ? existingPlan
        .split("\n")
        .filter((l) => /^#{1,4}\s*iteration\s+\d+/i.test(l))
        .join("\n")
    : "(none)";
  return `You are the thinker/architect for the huginn build harness, refining a project idea together with a human.

CURRENT REPOSITORY STATE:
\`\`\`
${repoContext(projectPath)}
\`\`\`

EXISTING SPECIFICATION (preserved in git history once updated):
${existingSpec.trim() ? `\`\`\`markdown\n${existingSpec}\n\`\`\`` : "(none — greenfield project)"}

EXISTING ADR:
${existingAdr.trim() ? `\`\`\`markdown\n${existingAdr}\n\`\`\`` : "(none)"}

EXISTING PLAN (iteration titles only):
${planSummary || "(none)"}

Your job: help the human refine their idea into a concrete, well-scoped plan for THIS existing project. Iterate with them:
- Ask clarifying questions a few at a time (not a wall of them).
- Probe scope, non-goals, constraints, and what must NOT change.
- Ground yourself in the repository state above — reference real modules/files.
- Stay concise: one focused question or a short clarification per turn.
- Output your questions and responses directly in conversational markdown text (do not invoke interactive question tools). If you genuinely need the user to choose before you can continue, emit a single question block instead of guessing:
<<<HUGINN_QUESTION>>> followed by a JSON array of {"question": string, "options": [{"label": string, "description"?: string}]} and <<<END_HUGINN_QUESTION>>> on their own lines. Huginn shows the options and resumes the turn with the user's choice..

When the human types /draft, respond with ONLY the refined scope in this shape:

SCOPE:
\`\`\`markdown
<complete refined scope: what to build or change, goals, non-goals, constraints>
\`\`\``;
}

function firstLine(text: string): string {
  const l = text.split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  return l.length > 80 ? `${l.slice(0, 77)}...` : l;
}

export class LiveEngine {
  readonly client?: OpencodeClient;
  private _runtime: IAgentRuntime;
  private session?: IAgentSession;
  private cfg: RunConfig;
  private models: Models;
  private decisions = new DecisionBroker();
  private sessionId?: string;
  private messages: Array<{ role: "user" | "assistant" | "system"; text: string }> = [];
  private aborted = false;
  private cycle?: CycleEngine;
  private stage: LiveStage = "refine";
  private scope?: string;
  private idea?: string;
  private runtimeFactory?: (target: AgentTarget) => IAgentRuntime;
  private needsSystemPrompt = false;

  constructor(opts: LiveEngineOptions) {
    this.cfg = opts.cfg;
    this.runtimeFactory = opts.runtimeFactory;
    if (opts.runtime) {
      this._runtime = opts.runtime;
      if (opts.client) {
        this.client = opts.client;
      } else if ("client" in opts.runtime && (opts.runtime as unknown as { client?: OpencodeClient }).client) {
        this.client = (opts.runtime as unknown as { client: OpencodeClient }).client;
      }
      // Non-OpenCode runtimes: leave client undefined — all prompts go through session
    } else {
      this.client = opts.client ?? createClient(`http://127.0.0.1:${opts.cfg.port}`);
      this._runtime = new OpencodeRuntimeAdapter({
        client: this.client,
        port: opts.cfg.port,
        projectPath: opts.cfg.projectPath,
      });
    }
    this.models = resolveModels(opts.cfg.thinker, opts.cfg.executor);
    this.idea = opts.idea;
  }

  /** Public accessor for the active agent runtime (mutable via switchRuntime). */
  get runtime(): IAgentRuntime {
    return this._runtime;
  }

  get currentStage(): LiveStage {
    return this.stage;
  }

  get cycleEngine(): CycleEngine | undefined {
    return this.cycle;
  }

  get hasAborted(): boolean {
    return this.aborted;
  }

  get ideaText(): string {
    return this.idea ?? "";
  }

  getModels(): Models {
    return this.models;
  }

  getConfig(): RunConfig {
    return this.cfg;
  }

  updateModels(models: { thinker?: string; executor?: string }): Models {
    const newThinker = models.thinker ?? formatModel(this.models.thinker);
    const newExecutor = models.executor ?? formatModel(this.models.executor);
    this.models = resolveModels(newThinker, newExecutor);
    this.cfg.thinker = newThinker;
    this.cfg.executor = newExecutor;
    return this.models;
  }

  async switchRuntime(agentId: string): Promise<IAgentRuntime> {
    const target = agentId as AgentTarget;
    const newRuntime = this.runtimeFactory
      ? this.runtimeFactory(target)
      : getAgentRuntime(target, {
          client: target === "opencode" ? this.client : undefined,
          port: this.cfg.port,
          projectPath: this.cfg.projectPath,
        });

    if (!(await newRuntime.isAvailable())) {
      throw new Error(
        `Agent runtime "${target}" is not available (binary not found or unreachable).`,
      );
    }

    if (this.session) {
      try {
        await this.session.abort();
      } catch {
        // Safe fallback on session abort error
      }
    } else if (this.client && this.sessionId) {
      try {
        await abortSession(this.client, this.sessionId);
      } catch {
        // Safe fallback on client abort error
      }
    }

    this._runtime = newRuntime;
    this.session = undefined;
    this.sessionId = undefined;
    // The old session carried the architect/system prompt; re-seed it on the
    // first prompt of the new runtime so the switched agent keeps its context.
    this.needsSystemPrompt = true;

    // Visible acknowledgement of the switch, in the console's feedback voice
    // (REQ-31 / AC-31.1: the `✓` prefix mirrors `src/tui/feedback.ts`). The
    // engine owns this line so a headless switch is announced too; the TUI only
    // adds a `… Switching…` line while the probe runs.
    events.emit("liveChat", {
      role: "system",
      text: `✓ Switched agent runtime to ${newRuntime.name} (${newRuntime.id}).`,
    });

    return newRuntime;
  }

  async getDiagnostics(): Promise<DiagnosticsInfo> {
    let gitBranch = "unknown";
    let gitClean = true;
    let worktreeSandbox = false;

    try {
      const branchRes = git(this.cfg.projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branchRes.code === 0 && branchRes.stdout) {
        gitBranch = branchRes.stdout;
      }
      const statusRes = git(this.cfg.projectPath, ["status", "--porcelain"]);
      if (statusRes.code === 0) {
        gitClean = statusRes.stdout.trim().length === 0;
      }
      const gitDirRes = git(this.cfg.projectPath, ["rev-parse", "--git-dir"]);
      if (
        (gitDirRes.code === 0 && gitDirRes.stdout.includes("/worktrees/")) ||
        this.cfg.projectPath.includes("/.huginn/worktrees/")
      ) {
        worktreeSandbox = true;
      }
    } catch {
      // Safe fallback on git command failure
    }

    let entitiesCount = 0;
    let observationsCount = 0;
    let memoryError: string | undefined;
    try {
      // Same resolution as `CycleEngine` (the project's own database, not
      // whatever `process.cwd()` happens to be), so `/status` can never read a
      // different project's memory.
      const service = new MemoryService({
        projectRoot: this.cfg.projectPath,
        dbPath: resolveDatabasePath(undefined, this.cfg.projectPath),
      });
      try {
        const stats = service.getStats(service.currentProject.id);
        entitiesCount = stats.entities;
        observationsCount = stats.observations;
      } finally {
        service.close();
      }
    } catch (err) {
      // AC-30.5: a failed DB open/query is *not* an empty database — report the
      // (sanitized) reason so `/status` cannot claim "0 entities, 0 observations".
      memoryError = sanitizeTerminalText(err instanceof Error ? err.message : String(err));
    }

    return {
      gitBranch,
      gitClean,
      worktreeSandbox,
      runtimeName: this.runtime.name,
      thinkerModel: formatModel(this.models.thinker),
      executorModel: formatModel(this.models.executor),
      memoryStats: {
        entitiesCount,
        observationsCount,
        ...(memoryError ? { error: memoryError } : {}),
      },
    };
  }


  /** After handoff, decisions route to the running CycleEngine. */
  ask(req: DecisionRequest): Promise<DecisionChoice> {
    if (this.cycle) return this.cycle.ask(req);
    return this.decisions.request(req);
  }

  /**
   * Resolve the pending decision. `answers` carries the option labels a
   * clarifying question was answered with (REQ-37 / AC-37.3) — the five-value
   * `DecisionChoice` cannot express them.
   */
  resolveDecision(choice: DecisionChoice, answers?: string[]): void {
    // Resolve on *both* brokers: whichever holds the pending request answers, the
    // other is a no-op. Routing only to the cycle deadlocked a question raised by
    // `chat` after a cycle had run (REV-004).
    this.decisions.resolve(choice, answers);
    this.cycle?.resolveDecision(choice);
  }

  requestAbort(): void {
    this.aborted = true;
    this.decisions.resolveAll("abort");
    if (this.session) void this.session.abort();
    else if (this.client && this.sessionId) void abortSession(this.client, this.sessionId);
    if (this.cycle) this.cycle.requestAbort();
    events.emit("done", { reason: "aborted", error: "live session aborted" });
  }

  private setStage(stage: LiveStage, message?: string): void {
    this.stage = stage;
    events.emit("liveStage", { stage, message });
  }

  private pushMessage(role: "user" | "assistant" | "system", text: string): void {
    this.messages.push({ role, text });
    if (this.messages.length > 100) this.messages.shift();
  }

  private lastUserMessage(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") return this.messages[i].text;
    }
    return "";
  }

  /**
   * Prefixes the architect system prompt onto the next prompt issued after a
   * runtime switch, so the new runtime's session regains project context.
   */
  private takeReseedPrompt(text: string): string {
    if (!this.needsSystemPrompt) return text;
    this.needsSystemPrompt = false;
    return `${refineSystemPrompt(this.cfg.projectPath)}\n\n${text}`;
  }

  async start(): Promise<void> {
    if (this.sessionId && this.session) return;
    this.session = await this.runtime.createSession({
      title: `huginn live: ${this.cfg.projectPath}`,
      directory: this.cfg.projectPath,
    });
    this.sessionId = this.session.id;
    this.setStage("refine");
    events.emit("liveChat", {
      role: "system",
      text:
        `Refinement session open. Context: project ${this.cfg.projectPath}, thinker ${formatModel(this.models.thinker)}.\n` +
        `Describe what you want to do, refine together, then type /draft when ready.`,
    });
  }

  /**
   * Sends one user message in the refinement conversation and returns the
   * assistant's reply. The session history carries context across turns.
   */
  async chat(text: string): Promise<string> {
    await this.start();
    this.pushMessage("user", text);
    events.emit("liveChat", { role: "user", text });
    const reseed = this.needsSystemPrompt;
    this.needsSystemPrompt = false;
    const first = reseed || this.messages.filter((m) => m.role === "user").length === 1;
    const body = first ? `${refineSystemPrompt(this.cfg.projectPath)}\n\nUSER IDEA:\n${text}` : text;
    let replyText: string;
    if (this.session) {
      const res = await this.session.prompt(body, {
        model: formatModel(this.models.thinker),
        timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
        directory: this.cfg.projectPath,
      });
      replyText = res.text;
    } else {
      if (!this.client) throw new Error("No agent session or OpenCode client available for chat");
      const res = await prompt(this.client, this.sessionId!, {
        text: body,
        model: this.models.thinker,
        timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
      });
      replyText = res.text;
    }
    // Agent-agnostic question protocol (REQ-37 / AC-37.1): a marked block lets any
    // runtime ask, even a one-shot subprocess CLI that closes stdin after the
    // prompt. The block is stripped from what the user sees, presented through the
    // normal decision UI, and the chosen answers resume the turn.
    const parsed = parseQuestionBlock(replyText);
    if (parsed.warning) {
      events.emit("liveChat", { role: "system", text: `⚠ ${parsed.warning}` });
    }
    replyText = parsed.cleanedText;

    if (parsed.questions.length > 0) {
      const choice = await this.askQuestion(parsed.questions);
      const answers = this.decisions.takeAnswers();
      if (choice === "deny" || choice === "abort") {
        events.emit("liveChat", {
          role: "system",
          text: "Question declined — continuing without those answers.",
        });
      } else {
        const followUp = await this.sendPrompt(
          formatQuestionAnswer(parsed.questions, answers),
        );
        const followParsed = parseQuestionBlock(followUp);
        if (followParsed.warning) {
          events.emit("liveChat", { role: "system", text: `⚠ ${followParsed.warning}` });
        }
        replyText = `${replyText}\n\n${followParsed.cleanedText}`.trim();
      }
    }

    this.pushMessage("assistant", replyText);
    events.emit("liveChat", { role: "assistant", text: replyText });
    return replyText;
  }

  /**
   * Ask the user, with a deadline (AC-37.4): a question that is never answered
   * must abort the turn with a message rather than hanging forever.
   */
  private async askQuestion(questions: QuestionItem[]): Promise<DecisionChoice> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DecisionChoice>((resolve) => {
      timer = setTimeout(() => resolve("abort"), QUESTION_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      return await Promise.race([
        this.decisions.request({
          id: randomUUID(),
          kind: "question",
          iteration: 0,
          phase: "LIVE",
          attempt: 1,
          message: questions.map((q) => q.question).join("\n"),
          questionItems: questions,
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Send one prompt through whichever transport this engine has (shared by chat). */
  private async sendPrompt(body: string): Promise<string> {
    if (this.session) {
      const res = await this.session.prompt(body, {
        model: formatModel(this.models.thinker),
        timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
        directory: this.cfg.projectPath,
      });
      return res.text;
    }
    if (!this.client) throw new Error("No agent session or OpenCode client available for chat");
    const res = await prompt(this.client, this.sessionId!, {
      text: body,
      model: this.models.thinker,
      timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
    });
    return res.text;
  }

  private throwIfAborted(): void {
    if (this.aborted) throw new LiveAbortError();
  }

  private async requestDecision(req: DecisionRequest): Promise<DecisionChoice> {
    this.throwIfAborted();
    return this.decisions.request(req);
  }

  private async extractScope(): Promise<string> {
    this.throwIfAborted();
    const promptLines = [
      `The user is ready to proceed. Based on the entire conversation, produce the refined scope for this project.`,
      ``,
      `Respond with ONLY a fenced block:`,
      ``,
      `SCOPE:`,
      "```markdown",
      `<complete refined scope: what to build or change, goals, non-goals, constraints>`,
      "```",
      ``,
      `OUTPUT FORMAT CONTRACT — obey strictly:`,
      `- The reply must start with the line "SCOPE:" followed by a fenced markdown block.`,
      `- The block contains ONLY the refined scope: what to build or change, goals, non-goals, constraints.`,
      `- No preamble, no closing remarks, no commentary outside the block.`,
    ].join("\n");

    const body = this.takeReseedPrompt(promptLines);

    let replyText: string;
    if (this.session) {
      const res = await this.session.prompt(body, {
        model: formatModel(this.models.thinker),
        timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
        directory: this.cfg.projectPath,
      });
      replyText = res.text;
    } else {
      if (!this.client) throw new Error("No agent session or OpenCode client available for scope extraction");
      const res = await prompt(this.client, this.sessionId!, {
        text: body,
        model: this.models.thinker,
        timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
      });
      replyText = res.text;
    }
    this.pushMessage("assistant", replyText);
    const scope = extractScopeBlock(replyText);
    if (scope) {
      events.emit("liveChat", { role: "system", text: `✓ Refined scope captured: ${firstLine(scope)}` });
      return scope;
    }
    events.emit("log", {
      level: "warn",
      message: "scope extraction produced no parseable SCOPE block; fail-closed",
    });
    const fallback = this.lastUserMessage();
    const decision = await this.requestDecision({
      id: crypto.randomUUID(),
      kind: "scope-extraction",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message:
        `The thinker did not emit a parseable SCOPE block.\n` +
        `[r] Retry extraction · [c] Proceed with your last message as the scope · [a] Abort`,
    });
    this.throwIfAborted();
    if (decision === "continue") return fallback;
    return this.extractScope(); // retry
  }

  private async promptModel(text: string, label: string): Promise<string> {
    this.throwIfAborted();
    events.emit("log", { level: "info", message: `${label} (${formatModel(this.models.thinker)})...` });
    const body = this.takeReseedPrompt(text);
    if (this.session) {
      const res = await this.session.prompt(body, {
        model: formatModel(this.models.thinker),
        timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
        directory: this.cfg.projectPath,
      });
      return res.text;
    }
    if (!this.client) throw new Error("No agent session or OpenCode client available for prompt");
    const res = await prompt(this.client, this.sessionId!, {
      text: body,
      model: this.models.thinker,
      timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
    });
    return res.text;
  }

  /**
   * Drafts a final document with format enforcement: validate against the
   * output contract, retry once with the violation as feedback, then ask the
   * human (retry / accept as-is / abort). Returns validated content.
   */
  private async draftDocWithFormat(label: string, docType: DraftDocType, buildPrompt: () => string): Promise<string> {
    let lastError: string | null = null;
    for (let attempt = 1; ; attempt++) {
      this.throwIfAborted();
      const base = buildPrompt();
      const text =
        attempt === 1
          ? base
          : `${base}\n\nYour previous response violated the OUTPUT FORMAT CONTRACT:\n${lastError}\nRegenerate the document strictly following the contract.`;
      const raw = await this.promptModel(text, `${label} (attempt ${attempt})`);
      const content = unwrapFences(raw);
      const error = validateDraftFormat(docType, content);
      if (!error) return content;
      lastError = error;
      events.emit("log", { level: "warn", message: `[${label}] format contract violation: ${error}` });
      if (attempt >= 2) {
        const decision = await this.requestDecision({
          id: crypto.randomUUID(),
          kind: "draft-format",
          iteration: 0,
          phase: "LIVE",
          attempt,
          message:
            `The drafted ${label} violates the output format contract:\n  ${error}\n` +
            `[r] Retry with the contract re-emphasized · [c] Accept as-is · [a] Abort`,
        });
        this.throwIfAborted();
        if (decision === "abort") {
          this.aborted = true;
          throw new LiveAbortError();
        }
        if (decision === "continue") return content;
        // retry: loop again with the accumulated format feedback
      }
    }
  }

  private async generateDocs(scope: string): Promise<void> {
    this.setStage("draft");
    const repoState = repoContext(this.cfg.projectPath);
    const existingSpec = readOptional(this.cfg.specPath);
    const existingAdr = readOptional(this.cfg.adrPath);

    events.emit("liveStage", { stage: "draft", message: "Drafting spec.md" });
    const specContent = await this.draftDocWithFormat("spec.md", "spec", () =>
      updateSpecPrompt(scope, existingSpec, repoState),
    );
    writeDoc(this.cfg.specPath, specContent);
    events.emit("log", { level: "info", message: `✓ wrote ${this.cfg.specPath}` });

    const spec = specContent;
    events.emit("liveStage", { stage: "draft", message: "Drafting adr.md (append)" });
    const newEntries = await this.draftDocWithFormat("adr.md", "adr", () => appendAdrPrompt(spec, existingAdr));
    if (newEntries.trim() && !/^NONE$/i.test(newEntries.trim())) {
      const w = writeDoc(this.cfg.adrPath, existingAdr.trim() ? `${existingAdr.trimEnd()}\n\n${newEntries.trim()}\n` : `${newEntries.trim()}\n`);
      events.emit("log", { level: "info", message: `✓ appended ${w.bytes} bytes to ${this.cfg.adrPath}` });
    } else {
      events.emit("log", { level: "info", message: "no new ADR entries required; adr.md unchanged" });
    }

    const adr = readOptional(this.cfg.adrPath);
    events.emit("liveStage", { stage: "draft", message: "Drafting plan.md (remaining iterations)" });
    const planContent = await this.draftDocWithFormat("plan.md", "plan", () =>
      remainingPlanPrompt(spec, adr, repoState),
    );
    writeDoc(this.cfg.planPath, planContent);
    events.emit("log", { level: "info", message: `✓ wrote ${this.cfg.planPath}` });

    // intent-to-add so `git diff HEAD -- <docs>` (used by the approval prompt) shows the drafts
    stageDocsForReview(this.cfg.projectPath, this.docPaths());

    const plan = loadPlan(this.cfg.planPath); // throws when the draft is unparseable
    events.emit("log", { level: "info", message: `plan parsed: ${plan.iterations.length} remaining iteration(s)` });
  }

  private docPaths(): string[] {
    return [this.cfg.specPath, this.cfg.adrPath, this.cfg.planPath];
  }

  /**
   * Refinement → docs draft → human approval. Resolves once the user decides.
   * "approved" → call `execute()`; "aborted" → the session ended (intent-to-add
   * staging is dropped so no review-only state lingers in the index).
   */
  async draft(): Promise<"approved" | "aborted"> {
    await this.start();
    this.throwIfAborted();
    const scope = await this.extractScope();
    this.scope = scope;
    await this.generateDocs(scope);
    this.setStage("approve");
    const decision = await this.requestDecision({
      id: crypto.randomUUID(),
      kind: "approve-draft",
      iteration: 0,
      phase: "LIVE",
      attempt: 1,
      message:
        `Docs drafted for review:\n` +
        `  ${this.cfg.specPath}\n  ${this.cfg.adrPath}\n  ${this.cfg.planPath}\n` +
        `Inspect with: git diff HEAD -- spec.md adr.md plan.md\n` +
        `[r] Re-draft (regenerate with latest chat) · [c] OK — commit & execute · [a] Abort`,
    });
    this.throwIfAborted();
    if (decision === "abort") {
      this.aborted = true;
      unstageDocs(this.cfg.projectPath, this.docPaths());
      return "aborted";
    }
    if (decision === "retry") return this.draft();
    return "approved";
  }

  /**
   * Commits the updated docs and hands off to a fresh CycleEngine. Only valid
   * after `draft()` returned "approved".
   */
  async execute(): Promise<CycleEngine> {
    this.throwIfAborted();
    this.setStage("execute");
    const docs = this.docPaths();
    const subject = this.scope ? firstLine(this.scope).slice(0, 60) : "update spec/adr/plan";
    const committed = commitDocs(this.cfg.projectPath, docs, subject);
    if (committed) {
      events.emit("log", { level: "info", message: `✓ committed docs: ${committed.join(", ")}` });
    } else {
      events.emit("log", { level: "info", message: "docs unchanged — nothing to commit" });
    }
    resetHarnessState(this.cfg.projectPath);
    const plan = loadPlan(this.cfg.planPath);
    const engine = new CycleEngine({
      cfg: this.cfg,
      plan,
      client: this.client,
      runtime: this.runtime,
    });
    this.cycle = engine;
    return engine;
  }

  /** Headless entry point: idea → draft → approve → execute. */
  async runFromIdea(): Promise<CycleEngine | null> {
    await this.start();
    if (this.idea) await this.chat(this.idea);
    const outcome = await this.draft();
    if (outcome !== "approved") return null;
    return this.execute();
  }
}