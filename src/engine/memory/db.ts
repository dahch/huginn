import { existsSync, statSync } from "node:fs";
import { MemoryService, type ObservationWithEntities } from "@dahch/muninn";

export interface MemoryOpenOptions {
  /** Explicit database path. Retrieval never resolves one itself. */
  dbPath?: string;
  /** Project root new rows are attributed to (the primary project). */
  projectRoot: string;
  /**
   * Allow creating the database when it does not exist yet. Only writers
   * (ADR persistence, per-increment curation) set it: a read-only audit phase
   * must never turn a missing database into a repository write.
   */
  create?: boolean;
}

/**
 * True only for an existing regular file.
 *
 * Constructing a `MemoryService` on a missing path runs the DDL, creates the
 * directory and inserts the project row — a real repository write. A read-only
 * audit phase must never do that, and `.huginn/` is gitignored, so the tree-hash
 * guard would not see it either.
 */
export function memoryFileExists(dbPath?: string): boolean {
  if (!dbPath) return false;
  try {
    return existsSync(dbPath) && statSync(dbPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Open, run `fn`, close. `undefined` on any failure — memory is best-effort and
 * must never block a phase or a promotion.
 */
export function withMemoryService<T>(
  opts: MemoryOpenOptions,
  what: string,
  fn: (service: MemoryService) => T,
): T | undefined {
  if (!opts.dbPath || (!opts.create && !memoryFileExists(opts.dbPath))) {
    if (process.env.HUGINN_DEBUG) {
      console.error(`[huginn] muninn: no database at ${opts.dbPath ?? "(unset)"}; skipping ${what}`);
    }
    return undefined;
  }
  try {
    const service = new MemoryService({ projectRoot: opts.projectRoot, dbPath: opts.dbPath });
    try {
      return fn(service);
    } finally {
      service.close?.();
    }
  } catch (err) {
    if (process.env.HUGINN_DEBUG) {
      console.error(`[huginn] muninn: ${what} failed (non-fatal):`, err);
    }
    return undefined;
  }
}

export interface MemoryObservationInput {
  category: "decision" | "convention" | "discovery" | "bugfix" | "architecture";
  title: string;
  content: string;
  topicKey: string;
  symbols?: string[];
}

/**
 * Idempotent write keyed by `topic_key`.
 *
 * The schema has no unique constraint on `topic_key` and `saveObservation` only
 * inserts, so re-drafting an ADR or re-running an iteration would duplicate rows.
 * Deleting the previous row is safe: the `obs_ad` trigger keeps the FTS index in
 * sync and `ON DELETE CASCADE` clears `observation_entities`.
 */
export function upsertObservationByTopicKey(
  service: MemoryService,
  input: MemoryObservationInput,
): "saved" | "updated" | "unchanged" {
  const existing = service.getContext({
    category: input.category,
    topicKey: input.topicKey,
    limit: 1,
  });
  const previous: ObservationWithEntities | undefined = existing[0];
  if (previous && previous.content === input.content) return "unchanged";

  return service.db.transaction(() => {
    if (previous) {
      service.db.prepare("DELETE FROM observations WHERE id = ?").run(previous.id);
    }
    service.saveObservation({
      category: input.category,
      title: input.title,
      content: input.content,
      topicKey: input.topicKey,
      symbols: input.symbols,
    });
    return previous ? "updated" : "saved";
  })();
}
