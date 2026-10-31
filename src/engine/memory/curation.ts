import type { Iteration } from "../../plan/types.js";
import { withMemoryService, upsertObservationByTopicKey } from "./db.js";

export interface IterationVerdict {
  phase: string;
  verdict?: string;
}

export interface RecordIterationOptions {
  dbPath?: string;
  /** Primary project root the observation is attributed to. */
  projectRoot: string;
  iteration: Iteration;
  verdicts: IterationVerdict[];
  /** Project-relative files the increment changed. */
  filesChanged: string[];
  commit?: string | null;
}

const MAX_CONTENT = 2_000;

function slug(value: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return out.length > 0 ? out : "increment";
}

/**
 * Curate one observation per promoted increment (REQ-65).
 *
 * A clean increment is settled `architecture`; one that needed warnings or was
 * skipped is a `discovery`, which future increments retrieve by module. Keyed by
 * `iter-<n>`, so re-running the same iteration updates rather than duplicates.
 */
export function recordIterationObservation(
  opts: RecordIterationOptions,
): { id: string } | undefined {
  const { iteration } = opts;
  const category = opts.verdicts.some(
    (v) => v.verdict === "warning" || v.verdict === "skipped",
  )
    ? "discovery"
    : "architecture";

  const lines: string[] = [];
  if (iteration.goal) lines.push(`Goal: ${iteration.goal}`);
  const criteria = (iteration.acceptanceCriteria ?? []).slice(0, 8);
  if (criteria.length > 0) {
    lines.push("Acceptance criteria:");
    for (const criterion of criteria) lines.push(`- ${criterion}`);
  }
  const verification = (iteration.verification ?? []).slice(0, 3);
  if (verification.length > 0) lines.push(`Verification: ${verification.join("; ")}`);
  const files = opts.filesChanged.slice(0, 12);
  if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
  const verdicts = opts.verdicts
    .filter((v) => v.verdict !== undefined)
    .map((v) => `${v.phase}=${v.verdict}`)
    .join(" ");
  if (verdicts) lines.push(`Verdicts: ${verdicts}`);
  if (opts.commit) lines.push(`Commit: ${opts.commit.slice(0, 12)}`);

  const content = lines.join("\n").slice(0, MAX_CONTENT);
  if (content.trim() === "") return undefined;

  const result = withMemoryService(
    { dbPath: opts.dbPath, projectRoot: opts.projectRoot, create: true },
    "iteration curation",
    (service) => {
      const outcome = upsertObservationByTopicKey(service, {
        category,
        title: `iter ${iteration.index}: ${slug(iteration.title)}`,
        content,
        topicKey: `iter-${iteration.index}`,
        symbols: files,
      });
      void outcome;
      const stored = service.getContext({ topicKey: `iter-${iteration.index}`, limit: 1 });
      return stored[0] ? { id: stored[0].id } : undefined;
    },
  );
  return result ?? undefined;
}
