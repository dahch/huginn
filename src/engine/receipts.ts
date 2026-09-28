import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, headCommit } from "./diff.js";
import { profileSpec, type ProfileEvidence, type ProfileName } from "./profiles.js";
import type { PhaseName, Verdict } from "./types.js";

/**
 * Frozen iteration evidence (REQ-36 / AC-36.4 / ADR-35).
 *
 * The failure mode this exists for: an agent *claims* the tests passed. A receipt
 * pins the exact tree that was verified — the base commit, the resulting commit
 * and its tree hash, plus the per-phase verdicts — so the claim is checkable
 * against a hash instead of taken on faith. `strict-tdd` additionally records the
 * pre-`EXECUTE` tree, so "the tests were failing first" is evidenced too.
 */
export interface IterationReceipt {
  profile: ProfileName;
  evidence: Exclude<ProfileEvidence, "none">;
  iteration: number;
  title: string;
  baseCommit?: string;
  headCommit?: string;
  /** Tree hash of the verified state — the frozen evidence. */
  treeHash?: string;
  /** `strict-tdd` only: the tree before `EXECUTE`, so test-first is provable. */
  preExecuteTree?: string;
  verdicts: Array<{ phase: PhaseName; verdict?: Verdict }>;
  createdAt: string;
}

/** Tree hash of the current HEAD (`git rev-parse HEAD^{tree}`), or undefined. */
export function treeHash(projectPath: string): string | undefined {
  try {
    const result = git(projectPath, ["rev-parse", "HEAD^{tree}"]);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the receipt under `.huginn/receipts/iter-<n>.json` and return its path.
 * Best-effort: a receipt must never fail an otherwise-successful iteration.
 */
export function writeIterationReceipt(
  projectPath: string,
  receipt: IterationReceipt,
): string | undefined {
  try {
    const dir = join(projectPath, ".huginn", "receipts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `iter-${receipt.iteration}.json`);
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/** Build the receipt for a finished iteration, per the profile's evidence rule. */
export function buildIterationReceipt(opts: {
  profile: ProfileName | undefined;
  iteration: number;
  title: string;
  projectPath: string;
  /** Pre-iteration HEAD, so the receipt can show what changed. */
  baseCommit?: string;
  verdicts: Array<{ phase: PhaseName; verdict?: Verdict }>;
  preExecuteTree?: string;
}): IterationReceipt | undefined {
  const spec = profileSpec(opts.profile);
  if (spec.evidence === "none") return undefined;
  const head = headCommit(opts.projectPath) ?? undefined;
  return {
    profile: spec.id,
    evidence: spec.evidence,
    iteration: opts.iteration,
    title: opts.title,
    baseCommit: opts.baseCommit ?? head ?? undefined,
    headCommit: head ?? undefined,
    treeHash: treeHash(opts.projectPath),
    ...(spec.evidence === "snapshot" ? { preExecuteTree: opts.preExecuteTree } : {}),
    verdicts: opts.verdicts,
    createdAt: new Date().toISOString(),
  };
}
