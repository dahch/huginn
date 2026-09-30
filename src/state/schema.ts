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
  history: z.array(historyEntrySchema),
});

export type HarnessState = z.infer<typeof stateSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type PromotionRecord = z.infer<typeof promotionSchema>;
