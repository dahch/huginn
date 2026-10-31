import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryService } from "@dahch/muninn";
import { recordIterationObservation } from "./curation";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-curation-"));
  dbPath = join(dir, ".huginn", "muninn.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const iteration = {
  index: 1,
  title: "Scaffold",
  prompt: "work",
  startLine: 1,
  goal: "the app answers /health",
  acceptanceCriteria: ["REQ-1: /health returns 200"],
  verification: ["bun test"],
};

function rows(): Array<{ topic_key: string | null; category: string; content: string }> {
  const service = new MemoryService({ projectRoot: dir, dbPath });
  try {
    return service.getContext({ limit: 10 }).map((row) => ({
      topic_key: row.topic_key,
      category: row.category,
      content: row.content,
    }));
  } finally {
    service.close();
  }
}

describe("recordIterationObservation", () => {
  it("records one architecture observation per increment", () => {
    const result = recordIterationObservation({
      projectRoot: dir,
      dbPath,
      iteration,
      verdicts: [
        { phase: "EXECUTE", verdict: "pass" },
        { phase: "REVIEW", verdict: "pass" },
      ],
      filesChanged: ["src/a.ts"],
      commit: "abcdef1234567890",
    });

    expect(result?.id).toBeDefined();
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic_key).toBe("iter-1");
    expect(stored[0]!.category).toBe("architecture");
    expect(stored[0]!.content).toContain("the app answers /health");
    expect(stored[0]!.content).toContain("REQ-1: /health returns 200");
    expect(stored[0]!.content).toContain("abcdef123456");
  });

  it("marks an increment that needed warnings as a discovery", () => {
    recordIterationObservation({
      projectRoot: dir,
      dbPath,
      iteration,
      verdicts: [{ phase: "TEST_MODULE", verdict: "warning" }],
      filesChanged: ["src/a.ts"],
    });
    expect(rows()[0]!.category).toBe("discovery");
  });

  it("updates instead of duplicating when the same iteration is recorded twice", () => {
    const base = {
      projectRoot: dir,
      dbPath,
      iteration,
      verdicts: [{ phase: "EXECUTE", verdict: "pass" }],
      filesChanged: ["src/a.ts"],
    };
    recordIterationObservation(base);
    recordIterationObservation({
      ...base,
      iteration: { ...iteration, title: "Scaffold (renamed)" },
    });
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.topic_key).toBe("iter-1");
  });

  it("returns undefined instead of throwing when the database path is unusable", () => {
    const result = recordIterationObservation({
      projectRoot: dir,
      dbPath: dir, // a directory, not a database
      iteration,
      verdicts: [],
      filesChanged: [],
    });
    expect(result).toBeUndefined();
  });
});
