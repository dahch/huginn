import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Iteration } from "../plan/types";
import { formatModel, type Models } from "./modelRouter";
import { prompt, runCommand } from "../server/client";
import type { IAgentSession, PromptResult } from "./agent/types.js";
import { git, pendingChanges, changedFilesSince } from "./diff";
import {
  verifyTypeScriptContracts,
  formatDiagnosticsReport,
} from "../contracts/compiler.js";
import { indexFilesIntoMuninn } from "../muninn/indexer/ast-indexer.js";
import { MemoryService } from "../muninn/service/memory-service.js";
import { resolveDatabasePath } from "../muninn/db/client.js";

export interface PhaseContext {
  client?: OpencodeClient;
  session?: IAgentSession;
  sessionId: string;
  models: Models;
  projectPath: string;
  /**
   * Directory the server-side agent session is scoped to (REQ-17). When
   * sandboxing is enabled this is the worktree path, so the agent's tools edit
   * the sandbox rather than the primary working tree. Falls back to
   * {@link projectPath} when omitted.
   */
  directory?: string;
  iteration: Iteration;
  specPath: string;
  adrPath: string;
  planPath: string;
  modules: string[];
  baseCommit?: string;
  phaseTimeoutMs: number;
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
}

/** The sandbox-scoped directory every prompt/command should run against. */
function agentDirectory(ctx: PhaseContext): string {
  return ctx.directory ?? ctx.projectPath;
}

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

async function runCommandWithContext(
  ctx: PhaseContext,
  opts: {
    command: string;
    arguments: string;
    agent?: string;
    model?: string;
    timeoutMs?: number;
    directory?: string;
  },
): Promise<PromptResult> {
  if (ctx.session) {
    if (typeof ctx.session.runCommand === "function") {
      return ctx.session.runCommand(opts.command, opts.arguments, opts);
    }
    const text = `/${opts.command}${opts.arguments ? ` ${opts.arguments}` : ""}`;
    return ctx.session.prompt(text, {
      agent: opts.agent,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      directory: opts.directory,
    });
  }
  if (!ctx.client) {
    throw new Error("No agent session or OpenCode client available for command");
  }
  return runCommand(ctx.client, ctx.sessionId, opts);
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
  return promptWithContext(ctx, { text, agent: "spec-auditor", model: ctx.models.executor, timeoutMs: ctx.phaseTimeoutMs, directory: agentDirectory(ctx) });
}

export async function execute(ctx: PhaseContext): Promise<PromptResult> {
  const text = [
    `Execute the following iteration of the plan. Follow it exactly.`,
    ``,
    `## Iteration ${ctx.iteration.index} — ${ctx.iteration.title}`,
    ``,
    ctx.iteration.prompt,
  ].join("\n");
  return promptWithContext(ctx, { text, agent: "build", model: ctx.models.executor, timeoutMs: ctx.phaseTimeoutMs, directory: agentDirectory(ctx) });
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

export async function validateStep(ctx: PhaseContext): Promise<PromptResult> {
  // 1. Contract verification: Check for TypeScript compiler contract violations
  try {
    const iterationFiles = getIterationFiles(ctx.projectPath, ctx.modules);
    if (iterationFiles.length > 0) {
      const contractResult = verifyTypeScriptContracts(ctx.projectPath, iterationFiles);
      if (!contractResult.valid && contractResult.errorsCount > 0) {
        const report = formatDiagnosticsReport(contractResult);
        return {
          messageId: "contract-compiler-failure",
          text: report,
          raw: {
            info: { id: "contract-compiler-failure" },
            parts: [{ type: "text", text: report }],
          },
        };
      }
    }
  } catch {
    // Contract verification failure should not crash harness; fallback to standard validate-step command
  }

  // 2. Standard validation slash command
  const args = [...ctx.modules, ctx.specPath].join(" ");
  return runCommandWithContext(ctx, {
    command: "validate-step",
    arguments: args,
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function testModule(ctx: PhaseContext): Promise<PromptResult> {
  return runCommandWithContext(ctx, {
    command: "test-module",
    arguments: ctx.modules.join(" "),
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function secureCheck(ctx: PhaseContext): Promise<PromptResult> {
  return runCommandWithContext(ctx, {
    command: "secure-check",
    arguments: "",
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function review(ctx: PhaseContext): Promise<PromptResult> {
  return runCommandWithContext(ctx, {
    command: "review",
    arguments: "",
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function docSync(ctx: PhaseContext): Promise<PromptResult> {
  return runCommandWithContext(ctx, {
    command: "doc-sync",
    arguments: "",
    model: formatModel(ctx.models.executor),
    timeoutMs: ctx.phaseTimeoutMs,
    directory: agentDirectory(ctx),
  });
}

export async function commitAll(ctx: PhaseContext): Promise<PromptResult> {
  // Capture modified files before running commit-all, because commit-all will clean the working tree (REV-008)
  let preModified: string[] = [];
  try {
    preModified = ctx.baseCommit
      ? changedFilesSince(ctx.projectPath, ctx.baseCommit)
      : pendingChanges(ctx.projectPath);
  } catch {
    // ignore git error
  }

  const result = await runCommandWithContext(ctx, {
    command: "commit-all",
    arguments: "",
    model: formatModel(ctx.models.executor),
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
  return promptWithContext(ctx, { text, agent: "build", model: ctx.models.thinker, timeoutMs: ctx.phaseTimeoutMs, directory: agentDirectory(ctx) });
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
