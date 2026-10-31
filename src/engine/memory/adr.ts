import type { MemoryService } from "@dahch/muninn";
import { readFileBounded } from "../steps/context.js";
import { withMemoryService, upsertObservationByTopicKey } from "./db.js";

export interface AdrSection {
  number: number;
  title: string;
  body: string;
  topicKey: string;
}

const ADR_HEADING = /^(#{1,6})\s+ADR[- ]?(\d+)\s*[:—–-]\s*(.+?)\s*$/i;
const MAX_ADR_CONTENT = 4_000;
const FILE_PATH_PATTERN =
  /(?:^|[\s`(])((?:src|lib|app|apps|packages)\/[\w./@-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java))/g;

/**
 * Parse `## ADR-14: Title` / `### ADR-14 — Title` sections.
 *
 * A new ADR starts at an `ADR-<n>` heading; the body runs until the next heading
 * at the same or a higher level, or a `---` separator. Sub-headings inside the
 * ADR (e.g. `### Decision`) stay part of the body.
 */
export function parseAdrSections(markdown: string): AdrSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: AdrSection[] = [];
  let current:
    | { number: number; title: string; level: number; body: string[] }
    | undefined;

  const flush = () => {
    if (!current) return;
    const body = current.body.join("\n").trim();
    sections.push({
      number: current.number,
      title: current.title,
      body,
      topicKey: `adr-${current.number}`,
    });
    current = undefined;
  };

  for (const line of lines) {
    const heading = ADR_HEADING.exec(line);
    if (heading) {
      flush();
      current = {
        number: Number(heading[2]),
        title: heading[3]!.trim(),
        level: heading[1]!.length,
        body: [],
      };
      continue;
    }
    if (!current) continue;
    const generic = /^(#{1,6})\s+/.exec(line);
    if (generic && generic[1]!.length <= current.level) {
      flush();
      continue;
    }
    if (/^---\s*$/.test(line)) {
      flush();
      continue;
    }
    current.body.push(line);
  }
  flush();
  return sections;
}

function candidateSymbols(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(FILE_PATH_PATTERN)) {
    const path = match[1]!;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= 8) break;
  }
  return out;
}

/** Only paths the indexer already knows: `linkSymbol` would otherwise invent entities. */
function existingIdentifiers(service: MemoryService, projectId: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const statement = service.db.prepare(
    "SELECT identifier FROM entities WHERE project_id = ? AND identifier = ? LIMIT 1",
  );
  return paths.filter((path) => statement.get(projectId, path) !== undefined);
}

export interface RecordAdrsOptions {
  dbPath?: string;
  /** Primary project root the decisions are attributed to. */
  projectRoot: string;
  adrPath: string;
  dryRun?: boolean;
}

export interface RecordAdrsResult {
  saved: number;
  updated: number;
  unchanged: number;
  skipped: number;
  sections: AdrSection[];
}

/**
 * Persist every ADR section as a `decision` observation, idempotently keyed by
 * `adr-<n>`. Fail-open: a missing ADR file or an unavailable database yields
 * zero counts, never a throw.
 */
export function recordAdrsAsDecisions(opts: RecordAdrsOptions): RecordAdrsResult {
  const empty: RecordAdrsResult = { saved: 0, updated: 0, unchanged: 0, skipped: 0, sections: [] };
  const read = readFileBounded(opts.adrPath, 1_000_000, opts.projectRoot);
  if (read.kind !== "ok" && read.kind !== "empty") return empty;

  const sections = parseAdrSections(read.kind === "ok" ? read.content : "");
  if (opts.dryRun) return { ...empty, sections };
  if (sections.length === 0) return { ...empty, sections };

  const counts = withMemoryService(
    { dbPath: opts.dbPath, projectRoot: opts.projectRoot, create: true },
    "ADR decision save",
    (service) => {
      const projectId = service.currentProject.id;
      const result = { saved: 0, updated: 0, unchanged: 0, skipped: 0 };
      for (const section of sections) {
        const content = section.body.slice(0, MAX_ADR_CONTENT);
        if (content.trim() === "") {
          result.skipped += 1;
          continue;
        }
        const outcome = upsertObservationByTopicKey(service, {
          category: "decision",
          title: `ADR-${section.number}: ${section.title}`.slice(0, 200),
          content,
          topicKey: section.topicKey,
          symbols: existingIdentifiers(service, projectId, candidateSymbols(section.body)),
        });
        result[outcome] += 1;
      }
      return result;
    },
  );

  return { ...(counts ?? { saved: 0, updated: 0, unchanged: 0, skipped: 0 }), sections };
}
