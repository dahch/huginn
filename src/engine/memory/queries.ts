import type { MemoryService } from "@dahch/muninn";

export interface DecisionRow {
  id: string;
  title: string;
  content: string;
  topicKey: string | null;
  updatedAt: string;
}

export interface ObservationRow {
  id: string;
  category: string;
  title: string;
  content: string;
  topicKey: string | null;
  updatedAt: string;
}

export interface SymbolRow {
  identifier: string;
  entityType: string;
  filePath: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * The most relevant decisions, recency-first.
 *
 * BM25 is an AND over the sanitized terms, so a long synthetic query matches
 * nothing. The recent decisions are therefore always included, and the ranked
 * matches only top them up — which also makes the block stable for an increment
 * whose goal does not share vocabulary with any ADR.
 */
export function queryDecisions(
  service: MemoryService,
  opts: { limit: number; query?: string },
): DecisionRow[] {
  const recent = service.getContext({
    category: "decision",
    limit: Math.min(8, opts.limit),
  });
  const matched = opts.query
    ? service.search({ query: opts.query, category: "decision", limit: Math.min(6, opts.limit) })
    : [];

  const seen = new Set<string>();
  const out: DecisionRow[] = [];
  for (const row of [...matched, ...recent]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      id: row.id,
      title: row.title,
      content: row.content,
      topicKey: row.topic_key ?? null,
      updatedAt: row.updated_at,
    });
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** Free-text observations (prior increments, discoveries, conventions), ranked. */
export function searchObservations(
  service: MemoryService,
  opts: { query: string; limit: number },
): ObservationRow[] {
  return service.search({ query: opts.query, limit: opts.limit }).map((row) => ({
    id: row.id,
    category: row.category,
    title: row.title,
    content: row.content,
    topicKey: row.topic_key ?? null,
    updatedAt: row.updated_at,
  }));
}

/**
 * The symbols declared under the iteration's modules.
 *
 * `entities.file_path` is project-relative, so a module path is a prefix match.
 * No public API covers a path prefix, hence the parameterized statement (the
 * same access `doctor.ts` already uses for its attribution check).
 */
export function queryModuleSymbols(
  service: MemoryService,
  opts: { projectId: string; modules: string[]; limit: number },
): SymbolRow[] {
  if (opts.modules.length === 0) return [];
  const statement = service.db.prepare(
    `SELECT identifier, entity_type, file_path
       FROM entities
      WHERE project_id = ?
        AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')
      ORDER BY file_path ASC, identifier ASC
      LIMIT ?`,
  );
  const seen = new Set<string>();
  const out: SymbolRow[] = [];
  const perModule = Math.max(4, Math.ceil(opts.limit / opts.modules.length));
  for (const modulePath of opts.modules) {
    const rows = statement.all(
      opts.projectId,
      modulePath,
      `${escapeLike(modulePath)}/%`,
      perModule,
    ) as Array<{ identifier: string; entity_type: string; file_path: string }>;
    for (const row of rows) {
      const key = `${row.file_path}\0${row.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        identifier: row.identifier,
        entityType: row.entity_type,
        filePath: row.file_path,
      });
    }
  }
  return out.slice(0, opts.limit);
}

/** Observations already linked to a symbol under one of the iteration's modules. */
export function queryModuleObservations(
  service: MemoryService,
  opts: { projectId: string; modules: string[]; limit: number },
): ObservationRow[] {
  if (opts.modules.length === 0) return [];
  const statement = service.db.prepare(
    `SELECT DISTINCT o.id, o.category, o.title, o.content, o.topic_key, o.updated_at
       FROM observations o
       JOIN observation_entities oe ON oe.observation_id = o.id
       JOIN entities e ON e.id = oe.entity_id
      WHERE o.project_id = ? AND e.project_id = ?
        AND (e.file_path = ? OR e.file_path LIKE ? ESCAPE '\\')
      ORDER BY o.updated_at DESC
      LIMIT ?`,
  );
  const seen = new Set<string>();
  const out: ObservationRow[] = [];
  for (const modulePath of opts.modules) {
    const rows = statement.all(
      opts.projectId,
      opts.projectId,
      modulePath,
      `${escapeLike(modulePath)}/%`,
      opts.limit,
    ) as Array<{
      id: string;
      category: string;
      title: string;
      content: string;
      topic_key: string | null;
      updated_at: string;
    }>;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({
        id: row.id,
        category: row.category,
        title: row.title,
        content: row.content,
        topicKey: row.topic_key,
        updatedAt: row.updated_at,
      });
      if (out.length >= opts.limit) return out;
    }
  }
  return out;
}
