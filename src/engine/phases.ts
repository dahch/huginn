import { readFileSync, existsSync } from "node:fs";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Iteration } from "../plan/types";
import type { Models } from "./modelRouter";
import { formatModel } from "./modelRouter";
import { prompt, runCommand, type PromptResult } from "../server/client";
import { git } from "./diff";

export interface PhaseContext {
  client: OpencodeClient;
  sessionId: string;
  models: Models;
  projectPath: string;
  iteration: Iteration;
  specPath: string;
  adrPath: string;
  planPath: string;
  modules: string[];
  baseCommit?: string;
  phaseTimeoutMs: number;
}

function readOptional(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function embedFile(path: string, label: string): string {
  const content = readOptional(path);
  if (!content) return `(${label} not found at ${path})`;
  return `\`\`\`markdown\n${content}\n\`\`\``;
}

export async function specAudit(ctx: PhaseContext): Promise<PromptResult> {
  const status = git(ctx.projectPath, ["status", "--short"]).stdout || "(clean working tree)";
  const text = [
    `Act as the spec auditor. Audit semantic alignment between the spec and the current implementation.`,
    ``,
    `## Spec`,
    embedFile(ctx.specPath, "spec"),
    ``,
    `## ADR`,
    embedFile(ctx.adrPath, "adr"),
    ``,
    `## Plan (full)`,
    embedFile(ctx.planPath, "plan"),
    ``,
    `## Current iteration to consider`,
    `Iteration ${ctx.iteration.index} — ${ctx.iteration.title}`,
    ``,
    `## Current repository state`,
    status,
    ``,
    `Produce the full Spec Audit Report as defined in your system prompt, ending with the "Overall fidelity: 🟢 ALIGNED / 🟡 MINOR DRIFT / 🔴 MAJOR DEVIATION" line.`,
  ].join("\n");
  return prompt(ctx.client, ctx.sessionId, { text, agent: "spec-auditor", model: ctx.models.executor, timeoutMs: ctx.phaseTimeoutMs });
}

export async function execute(ctx: PhaseContext): Promise<PromptResult> {
  const text = [
    `Execute the following iteration of the plan. Follow it exactly.`,
    ``,
    `## Iteration ${ctx.iteration.index} — ${ctx.iteration.title}`,
    ``,
    ctx.iteration.prompt,
  ].join("\n");
  return prompt(ctx.client, ctx.sessionId, { text, agent: "build", model: ctx.models.executor, timeoutMs: ctx.phaseTimeoutMs });
}

export async function validateStep(ctx: PhaseContext): Promise<PromptResult> {
  const args = [...ctx.modules, ctx.specPath].join(" ");
  return runCommand(ctx.client, ctx.sessionId, {
    command: "validate-step",
    arguments: args,
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
  });
}

export async function testModule(ctx: PhaseContext): Promise<PromptResult> {
  return runCommand(ctx.client, ctx.sessionId, {
    command: "test-module",
    arguments: ctx.modules.join(" "),
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
  });
}

export async function secureCheck(ctx: PhaseContext): Promise<PromptResult> {
  return runCommand(ctx.client, ctx.sessionId, {
    command: "secure-check",
    arguments: "",
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
  });
}

export async function review(ctx: PhaseContext): Promise<PromptResult> {
  return runCommand(ctx.client, ctx.sessionId, {
    command: "review",
    arguments: "",
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
  });
}

export async function docSync(ctx: PhaseContext): Promise<PromptResult> {
  return runCommand(ctx.client, ctx.sessionId, {
    command: "doc-sync",
    arguments: "",
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
  });
}

export async function commitAll(ctx: PhaseContext): Promise<PromptResult> {
  return runCommand(ctx.client, ctx.sessionId, {
    command: "commit-all",
    arguments: "",
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
  });
}

export async function fixFindings(
  ctx: PhaseContext,
  label: string,
  report: string,
  extraInstructions?: string,
): Promise<PromptResult> {
  const text = [
    `The following "${label}" findings were flagged as BLOCKING. Fix ALL of them in the codebase now.`,
    extraInstructions ?? "",
    ``,
    `## Findings report`,
    `\`\`\`markdown`,
    report,
    `\`\`\``,
    ``,
    `Apply the fixes, then summarize exactly what you changed and why.`,
  ].join("\n");
  return prompt(ctx.client, ctx.sessionId, { text, agent: "build", model: ctx.models.thinker, timeoutMs: ctx.phaseTimeoutMs });
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
