import { z } from "zod";

export const historyEntrySchema = z.object({
  iteration: z.number(),
  phase: z.string(),
  attempt: z.number(),
  verdict: z.enum(["pass", "warning", "blocked", "skipped"]).optional(),
  model: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  summary: z.string(),
  reportPath: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
});

/**
 * The outcome of integrating an iteration's sandbox into the primary branch
 * (ADR-48 / REQ-49). Recorded structurally so a promotion failure is reported as
 * a *promotion* failure — with the preserved branch and any backup directory —
 * instead of being flattened into a generic abort. Optional so state files
 * written before Phase 8 still parse.
 */
export const promotionSchema = z.object({
  status: z.enum(["promoted", "none", "conflict", "failed"]),
  branch: z.string(),
  backups: z.array(z.string()).optional(),
  detail: z.string().optional(),
});

/**
 * Where an interrupted run stopped (ADR-56).
 *
 * `currentPhase` records the last phase that *finished*; this cursor records the
 * step that was in flight (or blocked) when the run ended, so the next run can
 * restart exactly that step instead of redoing the whole iteration. The sandbox
 * fields are what let a sandboxed run reattach the worktree that holds the
 * partially-done work. Optional so state written before the cursor still parses.
 */
export const resumeCursorSchema = z.object({
  iteration: z.number(),
  phase: z.string(),
  at: z.string(),
  sandboxBranch: z.string().optional(),
  sandboxPath: z.string().optional(),
});

/**
 * The last whole-document `SPEC_AUDIT` (REQ-62).
 *
 * The audit compares the spec/adr/plan against the implementation, so running it
 * on every iteration pays the same (now bounded) document embed again for an
 * unchanged contract. The document hash is `computePlanHash([spec, adr, plan])`,
 * the same "did the documents change" question the resume path already answers.
 * Only a non-blocking audit is memoized: a blocked one must be re-run.
 */
/** Token/cost totals a driver reported across the run (REQ-67). */
export const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});

export const specAuditSchema = z.object({
  docHash: z.string(),
  auditedAt: z.string(),
  iteration: z.number(),
  verdict: z.enum(["pass", "warning"]),
});

export const stateSchema = z.object({
  version: z.literal(1),
  planHash: z.string(),
  planPath: z.string(),
  specPath: z.string(),
  adrPath: z.string(),
  models: z.object({
    thinker: z.string(),
    executor: z.string(),
  }),
  mode: z.enum(["auto", "supervised"]),
  currentIteration: z.number(),
  currentPhase: z.string(),
  phaseAttempts: z.record(z.string(), z.number()),
  iterationSessionId: z.string().optional(),
  iterationBaseCommit: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  aborted: z.boolean().optional(),
  promotion: promotionSchema.optional(),
  resume: resumeCursorSchema.optional(),
  specAudit: specAuditSchema.optional(),
  usage: usageSchema.optional(),
  history: z.array(historyEntrySchema),
});

export type HarnessState = z.infer<typeof stateSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type PromotionRecord = z.infer<typeof promotionSchema>;
export type ResumeCursor = z.infer<typeof resumeCursorSchema>;
export type SpecAuditRecord = z.infer<typeof specAuditSchema>;
export type UsageTotalsRecord = z.infer<typeof usageSchema>;
