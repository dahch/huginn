import type { DecisionChoice } from "./types.js";
import type { PromotionRecord } from "../state/schema";

/**
 * The outcome of a promotion recovery attempt (ADR-62).
 *
 * `promoted` is the only success signal: a retry that finds nothing to integrate
 * (`method: "none"`) is a no-op for the primary tree, not a recovered iteration.
 */
export interface PromotionRetryResult {
  promoted: boolean;
  method: "ff" | "merge" | "cherry-pick" | "none";
  commits: string[];
  /** The record huginn persisted for this attempt (`state.promotion`). */
  record: PromotionRecord;
  /** Why the recovery failed, sanitized; absent when it promoted. */
  error?: string;
}

/**
 * Whether huginn may hand a failed promotion to the **model** to repair.
 *
 * Only a real integration **conflict** qualifies: huginn already attempted the
 * merge/cherry-pick, its branch is intact and the two histories genuinely
 * disagree. A `failed` promotion means huginn could not even attempt it (a
 * partially staged file, a staged-new file, an unreadable branch, an unusable
 * backup destination) — those are statements about the *user's* working tree, and
 * a model rewriting files around them could silently drop uncommitted work
 * (ADR-48 §2). The answer there is a human `git commit`/`unstage`/`stash`,
 * followed by the deterministic retry.
 */
export function promotionRepairEligibility(
  record: PromotionRecord | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!record) {
    return { ok: false, reason: "there is no promotion record to repair" };
  }
  if (record.status === "promoted" || record.status === "none") {
    return { ok: false, reason: `the last promotion is "${record.status}"; nothing to repair` };
  }
  if (record.status === "failed") {
    const detail = record.detail ? ` (${record.detail})` : "";
    return {
      ok: false,
      reason:
        `huginn could not even attempt the integration${detail}. That is a state of your ` +
        `working tree, not a content conflict: commit, unstage or stash the file(s) and run ` +
        `\`huginn promote --retry\`; branch ${record.branch} keeps the iteration's commits`,
    };
  }
  return { ok: true };
}

/**
 * The choices a `post-cycle-live` prompt offers, given the promotion record.
 *
 * The recovery options never exist without a preserved branch, so the modal can
 * advertise exactly what it can deliver instead of a key that fails closed.
 */
export function promotionRecoveryChoices(
  record: PromotionRecord | undefined,
): DecisionChoice[] {
  const preserved = record?.status === "conflict" || record?.status === "failed";
  return [
    ...(preserved ? (["retry-promotion"] as DecisionChoice[]) : []),
    ...(promotionRepairEligibility(record).ok ? (["repair"] as DecisionChoice[]) : []),
    "retry",
    "continue",
    "abort",
  ];
}

/** One-line human description of a recovery result, for the console/modal. */
export function describePromotionRetry(result: PromotionRetryResult): string {
  if (result.promoted) {
    return (
      `Promotion recovered via ${result.method} (${result.commits.length} commit(s)); ` +
      `branch ${result.record.branch} is integrated and removed.`
    );
  }
  if (result.method === "none" && !result.error) {
    return `Nothing left to integrate from ${result.record.branch}: the primary branch already has it.`;
  }
  return `Promotion still failing: ${result.error ?? result.record.detail ?? "unknown reason"}. ` +
    `Branch ${result.record.branch} still holds the iteration's commits.`;
}
