import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import chalk from "chalk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { startServer } from "../server/lifecycle";
import { createClient, createSession, prompt } from "../server/client";
import { resolveModel, formatModel } from "./modelRouter";
import { parsePlan } from "../plan/parser";

const PLAN_PROMPT_TIMEOUT_MS = 20 * 60 * 1000;

export interface PlanModeOptions {
  projectPath: string;
  idea: string;
  thinker: string;
  specPath: string;
  adrPath: string;
  planPath: string;
  port: number;
  serverTimeoutMs: number;
}

export function unwrapFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = trimmed.match(fence);
  return m ? m[1].trim() + "\n" : trimmed + "\n";
}

export type DraftDocType = "spec" | "adr" | "plan";

/**
 * Shared output-format contract, appended to every prompt that produces a final
 * file (spec/adr/plan). Acts like a system prompt appended to the user message:
 * the model's reply is post-validated against these rules, so compliance does
 * not depend only on obedience.
 */
export const OUTPUT_FORMAT_CONTRACT: Record<DraftDocType, string> = {
  spec: `OUTPUT FORMAT CONTRACT — obey strictly:
- Respond with ONLY the complete spec.md content. No preamble, no closing remarks, no meta-commentary about what you did.
- Code fences will be stripped; the content must be valid standalone markdown.
- Start with a top-level heading "# Spec: <name>".
- Number every functional requirement "REQ-1", "REQ-2", ... — never prose bullets.
- Give acceptance criteria "AC-1", "AC-2", ... for each major requirement.`,
  adr: `OUTPUT FORMAT CONTRACT — obey strictly:
- Respond with ONLY the new ADR entries (or exactly "NONE"). No preamble, no closing remarks, no meta-commentary.
- Code fences will be stripped; each entry must be valid standalone markdown.
- Every entry MUST start with a heading "## ADR-<N>: <Title>", with <N> continuing after the existing entries.
- Each entry follows the classic template: Context / Decision / Consequences.`,
  plan: `OUTPUT FORMAT CONTRACT — obey strictly:
- Respond with ONLY the plan.md content. No preamble, no closing remarks, no commentary.
- Code fences will be stripped; the content must be valid standalone markdown.
- Start with "# Plan: <short project name>".
- Iterations are "## Iteration N — <Title>" numbered from 1 (space after "##", capital "Iteration", " — " separator).
- Optionally a "modules:" line immediately after each heading.
- The body of each heading is the verbatim executor prompt for that iteration.`,
};

export function withOutputContract(text: string, docType: DraftDocType): string {
  return `${text.trimEnd()}\n\n${OUTPUT_FORMAT_CONTRACT[docType]}\n`;
}

/**
 * Validates a drafted document against the output contract. Returns a
 * human-readable error describing the violation, or null when the draft is
 * well-formed. Callers fail closed: a violation triggers a retry / decision.
 */
export function validateDraftFormat(docType: DraftDocType, content: string): string | null {
  const text = content.trim();
  if (!text) return docType === "adr" ? null : `${docType} draft is empty`;
  switch (docType) {
    case "spec": {
      if (!/^#\s+\S+/m.test(text)) return 'spec must start with a top-level heading "# Spec: <name>"';
      if (!/REQ-\d+/i.test(text)) return 'spec must contain numbered requirements (e.g. "REQ-1")';
      return null;
    }
    case "adr": {
      if (/^NONE$/i.test(text)) return null;
      // Level-2 headings delimit entries and MUST be "## ADR-<N>:". Level-3+
      // headings (e.g. "### Context") are legitimate sub-structure of the
      // classic template and are allowed.
      const h2 = text.split("\n").filter((l) => /^#{2}\s+/.test(l.trim()));
      if (h2.length === 0) return 'adr must contain at least one entry starting with "## ADR-<N>: <Title>" (or exactly "NONE")';
      const bad = h2.find((l) => !/^#{2}\s+ADR-\d+\s*:/i.test(l.trim()));
      if (bad) return `adr contains a non-ADR entry heading: "${bad.trim()}" — every entry must start with "## ADR-<N>: <Title>"`;
      return null;
    }
    case "plan": {
      if (!/^#\s+Plan\s*:/im.test(text)) return 'plan must start with "# Plan: <name>"';
      try {
        if (parsePlan(text).length === 0) {
          return 'plan must contain at least one "## Iteration N — <Title>" heading';
        }
      } catch {
        return "plan is not parseable";
      }
      return null;
    }
  }
}

function specPrompt(idea: string): string {
  return `You are the thinker for a build harness. Draft a functional and behavioral SPECIFICATION for the idea below.

Write it as a single markdown document "spec.md". Structure it so a build agent can implement it iteratively and an auditor can verify semantic alignment against it. Include:

- A short title and one-paragraph description of the product.
- Goals and non-goals.
- Users / personas (if relevant).
- Functional requirements, numbered, grouped by area/module.
- Non-functional requirements (performance, security, reliability, observability).
- Out of scope (explicitly).
- Acceptance criteria per major requirement, as concrete, testable statements.

Be precise and unambiguous. Do not invent a project name; use a neutral placeholder where needed. Prefer explicit numbered requirements (REQ-1, REQ-2, ...) over prose so they can be traced.

IDEA:
---
${idea}
---

Respond with ONLY the spec.md markdown content.`;
}

function adrPrompt(spec: string): string {
  return `You are the thinker for a build harness. Based on the specification below, produce an ARCHITECTURE DECISION RECORD document "adr.md".

Use one or more ADR entries, each following the classic template: Title/Context/Decision/Consequences (Status, date, decision-makers optional). Cover the most consequential architecture decisions implied by the spec:

- Overall structure / module layout.
- Data model and storage.
- External integrations / APIs.
- Concurrency, state, and failure handling.
- Testing and observability strategy.

Prefer a small number of high-impact decisions over exhaustive enumeration. Each decision must name clear alternatives and state why the chosen one was selected (tradeoffs explicit). Keep the whole document focused and useful for future maintainers.

SPECIFICATION:
---
${spec}
---

Respond with ONLY the adr.md markdown content.`;
}

function planPrompt(spec: string, adr: string): string {
  return `You are the thinker for a build harness. Based on the specification and architecture decisions below, produce an EXECUTION PLAN document "plan.md".

The plan is consumed by a harness that runs iterations one by one. Format rules (STRICT):

- Top-level title: "# Plan: <short project name>"
- Each iteration is a heading: "## Iteration N — <Title>", numbered sequentially starting at 1. Use a space after "##", capitalize "Iteration", and separate the number from the title with " — ".
- Immediately after each heading, optionally a "modules:" line with comma-separated source paths the iteration touches (e.g. "modules: src/audio/, src/export/"). Only include it if you can be confident about the paths.
- The body of each heading is the verbatim prompt that will be sent to the executor to build that iteration. It must be self-contained and actionable.
- Order iterations so each builds on the previous (foundations first, then features, then hardening/polish). 3 to 8 iterations is typical.

Iterations should map cleanly to the numbered requirements in the spec so progress is auditable.

SPECIFICATION:
---
${spec}
---

ARCHITECTURE DECISIONS:
---
${adr}
---

Respond with ONLY the plan.md markdown content.`;
}

/**
 * Update-mode spec prompt: produces a COMPLETE replacement spec for an existing
 * project (greenfield or not). The git history preserves the previous version,
 * so the scope change is auditable via `git diff`.
 */
export function updateSpecPrompt(idea: string, existingSpec: string, repoState: string): string {
  const promptBody = `You are the thinker for a build harness. Produce an updated functional and behavioral SPECIFICATION for the idea below, for an EXISTING project.

Write it as a single markdown document "spec.md". Structure it so a build agent can implement it iteratively and an auditor can verify semantic alignment against it. Include:

- A short title and one-paragraph description of the product (reflecting the full current + new scope).
- Goals and non-goals.
- Users / personas (if relevant).
- Functional requirements, numbered, grouped by area/module. Use numbered REQ-1, REQ-2, ... so they can be traced. Renumber freely — the document replaces the old one.
- Non-functional requirements (performance, security, reliability, observability).
- Out of scope (explicitly).
- Acceptance criteria per major requirement, as concrete, testable statements.

CRITICAL: this is an UPDATE to an existing project, not a greenfield draft. Incorporate what already exists — new requirements are ADDED or AMENDED, existing shipped functionality is preserved (possibly restated more precisely). The whole document is the complete current contract; do not mark new work with placeholders.

REFINED SCOPE / IDEA:
---
${idea}
---

EXISTING SPECIFICATION (the previous version, preserved in git history after this update):
${existingSpec.trim() ? `\`\`\`markdown\n${existingSpec}\n\`\`\`` : "(none — this is a greenfield project)"}

CURRENT REPOSITORY STATE:
\`\`\`
${repoState}
\`\`\`

Respond with ONLY the complete updated spec.md markdown content.`;
  return withOutputContract(promptBody, "spec");
}

/**
 * Update-mode ADR prompt: produces ONLY the NEW architecture decision entries
 * to append. Existing ADRs are preserved verbatim by the caller.
 */
export function appendAdrPrompt(spec: string, existingAdr: string): string {
  const promptBody = `You are the thinker for a build harness. Based on the specification below, produce NEW ARCHITECTURE DECISION RECORD entries to APPEND to the project's existing adr.md.

The existing adr.md already contains decisions. Do NOT repeat, restate, or re-decide them. Produce ONLY the new decisions implied by the updated spec — for genuinely new architectural choices (new modules, new integrations, changed data model, new failure-handling, etc.), or where the updated scope materially changes a previous decision (in which case say so explicitly and reference the previous entry).

Each entry follows the classic template: "## ADR-<N>: <Title>" followed by Context / Decision / Consequences (Status, date, decision-makers optional). Use ADR numbers continuing after the existing entries. Prefer a small number of high-impact decisions over exhaustive enumeration. Each decision must name clear alternatives and state why the chosen one was selected (tradeoffs explicit).

EXISTING ADR (preserved — do not repeat these decisions):
${existingAdr.trim() ? `\`\`\`markdown\n${existingAdr}\n\`\`\`` : "(none — this is the first ADR)"}

UPDATED SPECIFICATION:
---
${spec}
---

Respond with ONLY the new ADR entries (no title preamble, no closing remarks). If there are no new decisions, respond with exactly "NONE".`;
  return withOutputContract(promptBody, "adr");
}

/**
 * Update-mode plan prompt: produces ONLY the iterations that REMAIN to be done.
 * Completed iterations live in git history and must not be re-planned or
 * re-executed. Iterations are numbered from 1 (fresh run state).
 */
export function remainingPlanPrompt(spec: string, adr: string, repoState: string): string {
  const promptBody = `You are the thinker for a build harness. Produce an EXECUTION PLAN document "plan.md" for the REMAINING work of an EXISTING project.

The plan is consumed by a harness that runs iterations one by one against the current codebase. Format rules (STRICT):

- Top-level title: "# Plan: <short project name>"
- Each iteration is a heading: "## Iteration N — <Title>", numbered sequentially starting at 1. Use a space after "##", capitalize "Iteration", and separate the number from the title with " — ".
- Immediately after each heading, optionally a "modules:" line with comma-separated source paths the iteration touches (e.g. "modules: src/audio/, src/export/"). Only include it if you can be confident about the paths. Ground module paths in the actual repository state below.
- The body of each heading is the verbatim prompt that will be sent to the executor to build that iteration. It must be self-contained and actionable. Reference existing code paths and the new spec requirements (REQ-*) so the executor knows exactly what to add or change.
- Order iterations so each builds on the previous (foundations first, then features, then hardening/polish). 3 to 8 iterations is typical.

CRITICAL: this is an UPDATE, not a greenfield plan. The iterations you write cover ONLY the work that remains — the delta between the current codebase and the updated spec. Do NOT re-plan or re-run anything already shipped: previous iterations were completed and committed to git history. Assume the repository is in the state described below.

CURRENT REPOSITORY STATE:
\`\`\`
${repoState}
\`\`\`

UPDATED SPECIFICATION:
---
${spec}
---

ARCHITECTURE DECISIONS:
---
${adr}
---

Respond with ONLY the plan.md markdown content, containing only the remaining iterations.`;
  return withOutputContract(promptBody, "plan");
}

function streamToStdout(client: OpencodeClient): () => void {
  let closed = false;
  const streamPromise = client.event.subscribe();
  (async () => {
    try {
      const sse = await streamPromise;
      for await (const ev of sse.stream as AsyncGenerator<any>) {
        if (closed) break;
        if (!ev || typeof ev.type !== "string") continue;
        if (ev.type !== "message.part.updated") continue;
        const props = ev.properties as { part?: { type?: string; text?: string }; delta?: string };
        if (props.delta && (props.part?.type === "text" || props.part?.type === "reasoning")) {
          process.stdout.write(props.delta);
        }
      }
    } catch {
      /* stream ended */
    }
  })();
  return () => {
    closed = true;
  };
}

function readDoc(path: string): string {
  return readFileSync(path, "utf8");
}

async function draftDoc(
  client: OpencodeClient,
  sessionId: string,
  thinkerLabel: string,
  model: { providerID: string; modelID: string },
  stepNum: number,
  totalSteps: number,
  label: string,
  path: string,
  text: string,
): Promise<void> {
  const startedAt = Date.now();
  console.log(`\n${chalk.bgCyan.black.bold(` STEP ${stepNum}/${totalSteps} `)} ${chalk.white.bold(`Drafting ${label}`)} ${chalk.dim(`with ${thinkerLabel}...`)}`);
  const res = await prompt(client, sessionId, { text, model, timeoutMs: PLAN_PROMPT_TIMEOUT_MS });
  const content = unwrapFences(res.text);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const bytes = Buffer.byteLength(content, "utf8");
  console.log(`${chalk.green("✓")} ${chalk.white.bold(`Wrote ${label}`)} ${chalk.dim(`(${bytes} bytes in ${elapsed}s)`)} → ${chalk.cyan(path)}`);
}

export async function runPlanMode(opts: PlanModeOptions): Promise<void> {
  const steps: Array<{ label: string; path: string; build: (prior: string[]) => string }> = [
    { label: "spec", path: opts.specPath, build: () => specPrompt(opts.idea) },
    { label: "adr", path: opts.adrPath, build: (prior) => adrPrompt(prior[0]) },
    { label: "plan", path: opts.planPath, build: (prior) => planPrompt(prior[0], prior[1]) },
  ];

  for (const step of steps) {
    if (existsSync(step.path)) {
      throw new Error(`Refusing to overwrite ${step.path} (already exists). Pass --force to overwrite.`);
    }
  }

  const thinker = resolveModel(opts.thinker);
  const thinkerLabel = formatModel(thinker);

  const server = await startServer(opts.projectPath, opts.port, opts.serverTimeoutMs);
  const client = createClient(server.url);
  const stopStream = streamToStdout(client);

  try {
    const session = await createSession(client, `huginn plan: ${opts.projectPath}`);
    const sessionId = session.id;

    const prior: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await draftDoc(client, sessionId, thinkerLabel, thinker, i + 1, steps.length, step.label, step.path, step.build(prior));
      prior.push(readDoc(step.path));
    }

    console.log("");
    console.log(chalk.green("✨ All architectural documents drafted successfully!"));
    console.log(
      `${chalk.cyan("▶ Next step:")} huginn run --project ${opts.projectPath} --thinker ${opts.thinker} --executor <provider/model>`,
    );
  } finally {
    stopStream();
    await server.close();
  }
}
