import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryService } from "@dahch/muninn";
import { parseAdrSections, recordAdrsAsDecisions } from "./adr";

let dir: string;
let dbPath: string;
let adrPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-adr-"));
  dbPath = join(dir, ".huginn", "muninn.db");
  adrPath = join(dir, "adr.md");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ADR_MARKDOWN = [
  "# ADR",
  "",
  "## ADR-14: Muninn as the context engine",
  "",
  "Decision: store decisions as observations, retrieve by module.",
  "See `src/engine/memory/db.ts` and `src/engine/steps/retrieval.ts`.",
  "",
  "### Consequences",
  "- one bounded block",
  "",
  "---",
  "",
  "## ADR-15 — Deterministic commits",
  "",
  "No model turn for the commit.",
].join("\n");

describe("parseAdrSections", () => {
  it("parses headings, bodies and sub-headings", () => {
    const sections = parseAdrSections(ADR_MARKDOWN);
    expect(sections.map((s) => s.number)).toEqual([14, 15]);
    expect(sections[0]!.topicKey).toBe("adr-14");
    expect(sections[0]!.title).toBe("Muninn as the context engine");
    expect(sections[0]!.body).toContain("### Consequences");
    expect(sections[1]!.title).toBe("Deterministic commits");
  });

  it("ignores markdown without ADR headings", () => {
    expect(parseAdrSections("# Notes\n\nnothing here")).toEqual([]);
  });
});

describe("recordAdrsAsDecisions", () => {
  it("saves each ADR once and is idempotent", () => {
    writeFileSync(adrPath, ADR_MARKDOWN);

    const first = recordAdrsAsDecisions({ adrPath, projectRoot: dir, dbPath });
    expect(first.saved).toBe(2);
    expect(first.updated).toBe(0);

    const service = new MemoryService({ projectRoot: dir, dbPath });
    try {
      const rows = service.getContext({ category: "decision", limit: 10 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.topic_key).sort()).toEqual(["adr-14", "adr-15"]);
    } finally {
      service.close();
    }

    const second = recordAdrsAsDecisions({ adrPath, projectRoot: dir, dbPath });
    expect(second.unchanged).toBe(2);
    expect(second.saved + second.updated).toBe(0);
  });

  it("updates a changed ADR instead of duplicating it", () => {
    writeFileSync(adrPath, ADR_MARKDOWN);
    recordAdrsAsDecisions({ adrPath, projectRoot: dir, dbPath });

    writeFileSync(adrPath, ADR_MARKDOWN.replace("No model turn for the commit.", "Changed decision."));
    const result = recordAdrsAsDecisions({ adrPath, projectRoot: dir, dbPath });
    expect(result.updated).toBe(1);

    const service = new MemoryService({ projectRoot: dir, dbPath });
    try {
      const rows = service.getContext({ category: "decision", limit: 10 });
      expect(rows).toHaveLength(2);
      const adr15 = rows.find((r) => r.topic_key === "adr-15");
      expect(adr15?.content).toContain("Changed decision.");
    } finally {
      service.close();
    }
  });

  it("returns zero counts when the ADR file is missing", () => {
    const result = recordAdrsAsDecisions({ adrPath, projectRoot: dir, dbPath });
    expect(result).toEqual({ saved: 0, updated: 0, unchanged: 0, skipped: 0, sections: [] });
  });

  it("never resolves a database path itself", () => {
    writeFileSync(adrPath, ADR_MARKDOWN);
    const result = recordAdrsAsDecisions({ adrPath, projectRoot: dir, dbPath: undefined });
    // No dbPath → no writes, but the sections are still parsed.
    expect(result.saved).toBe(0);
    expect(result.sections).toHaveLength(2);
  });
});

describe("recordAdrsAsDecisions paths", () => {
  it("refuses a symlinked ADR file", () => {
    const outside = mkdtempSync(join(tmpdir(), "huginn-adr-out-"));
    try {
      const target = join(outside, "adr.md");
      writeFileSync(target, ADR_MARKDOWN);
      // A symlink inside the project pointing outside must be refused.
      const link = join(dir, "adr.md");
      mkdirSync(dir, { recursive: true });
      try {
        symlinkSync(target, link);
      } catch {
        return; // platform without symlink support
      }
      const result = recordAdrsAsDecisions({ adrPath: link, projectRoot: dir, dbPath });
      expect(result.saved).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
