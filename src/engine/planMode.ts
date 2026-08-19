import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import chalk from "chalk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { startServer } from "../server/lifecycle";
import { createClient, createSession, prompt } from "../server/client";
import { resolveModel, formatModel } from "./modelRouter";

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

function unwrapFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = trimmed.match(fence);
  return m ? m[1].trim() + "\n" : trimmed + "\n";
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
