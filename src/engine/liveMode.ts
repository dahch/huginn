import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RunConfig } from "../config";
import { createClient, createSession, prompt, abortSession } from "../server/client";
import { DecisionBroker } from "./decisionBroker";
import { events, type LiveStage } from "./engineEvents";
import type { DecisionChoice, DecisionRequest } from "./types";
import { formatModel, resolveModels, type Models } from "./modelRouter";
import { appendAdrPrompt, remainingPlanPrompt, unwrapFences, updateSpecPrompt, validateDraftFormat, type DraftDocType } from "./planMode";
import { CycleEngine } from "./cycle";
import { loadPlan } from "../plan/parser";
import { commitDocs, readOptional, repoContext, resetHarnessState, stageDocsForReview, unstageDocs, writeDoc } from "./liveRepo";

const LIVE_PROMPT_TIMEOUT_MS = 20 * 60 * 1000;

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
- Output your questions and responses directly in conversational markdown text (do not invoke interactive question tools).

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
  readonly client: OpencodeClient;
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

  constructor(opts: LiveEngineOptions) {
    this.cfg = opts.cfg;
    this.client = opts.client ?? createClient(`http://127.0.0.1:${opts.cfg.port}`);
    this.models = resolveModels(opts.cfg.thinker, opts.cfg.executor);
    this.idea = opts.idea;
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

  /** After handoff, decisions route to the running CycleEngine. */
  ask(req: DecisionRequest): Promise<DecisionChoice> {
    if (this.cycle) return this.cycle.ask(req);
    return this.decisions.request(req);
  }

  resolveDecision(choice: DecisionChoice): void {
    if (this.cycle) {
      this.cycle.resolveDecision(choice);
      return;
    }
    this.decisions.resolve(choice);
  }

  requestAbort(): void {
    this.aborted = true;
    this.decisions.resolveAll("abort");
    if (this.sessionId) void abortSession(this.client, this.sessionId);
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

  async start(): Promise<void> {
    if (this.sessionId) return;
    const session = await createSession(this.client, `huginn live: ${this.cfg.projectPath}`);
    this.sessionId = session.id;
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
    const first = this.messages.filter((m) => m.role === "user").length === 1;
    const body = first ? `${refineSystemPrompt(this.cfg.projectPath)}\n\nUSER IDEA:\n${text}` : text;
    const res = await prompt(this.client, this.sessionId!, {
      text: body,
      model: this.models.thinker,
      timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
    });
    this.pushMessage("assistant", res.text);
    events.emit("liveChat", { role: "assistant", text: res.text });
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
    const res = await prompt(this.client, this.sessionId!, {
      text: [
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
      ].join("\n"),
      model: this.models.thinker,
      timeoutMs: LIVE_PROMPT_TIMEOUT_MS,
    });
    this.pushMessage("assistant", res.text);
    const scope = extractScopeBlock(res.text);
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
    const res = await prompt(this.client, this.sessionId!, {
      text,
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
    const engine = new CycleEngine({ cfg: this.cfg, plan, client: this.client });
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