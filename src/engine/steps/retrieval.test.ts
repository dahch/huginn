import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryService, indexFilesIntoMuninn } from "@dahch/muninn";
import {
  MAX_MEMORY_CONTEXT,
  incrementSignals,
  memoryBlockFor,
  retrieveIncrementContext,
} from "./retrieval";
import { recordIterationObservation } from "../memory/curation";
import type { Iteration } from "../../plan/types";
import type { StepContext } from "./types";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-retrieval-"));
  dbPath = join(dir, ".huginn", "muninn.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  const service = new MemoryService({ projectRoot: dir, dbPath });
  try {
    service.saveObservation({
      category: "decision",
      title: "ADR-14: Muninn memory",
      content: "Muninn is SQLite + FTS5 and stores decisions as observations.",
      topicKey: "adr-14",
      symbols: ["src/engine/memory/db.ts"],
    });
    service.saveObservation({
      category: "architecture",
      title: "iter 1: scaffold",
      content: "Created the engine skeleton and the memory adapter.",
      topicKey: "iter-1",
      symbols: ["src/engine/memory/db.ts"],
    });
  } finally {
    service.close();
  }
}

describe("retrieveIncrementContext", () => {
  it("returns nothing without an explicit database path", () => {
    const empty = mkdtempSync(join(tmpdir(), "huginn-retrieval-none-"));
    try {
      expect(retrieveIncrementContext({ projectRoot: empty, modules: ["src"] })).toBe("");
      expect(existsSync(join(empty, ".huginn"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("never creates the database when it does not exist", () => {
    expect(retrieveIncrementContext({ projectRoot: dir, dbPath, modules: ["src"] })).toBe("");
    expect(existsSync(join(dir, ".huginn"))).toBe(false);
  });

  it("renders decisions, prior increments and module symbols as untrusted data", () => {
    seed();
    const block = retrieveIncrementContext({
      projectRoot: dir,
      dbPath,
      modules: ["src/engine/memory"],
      signals: ["scaffold the memory engine"],
    });

    expect(block).toContain("<<<BEGIN UNTRUSTED-");
    expect(block).toContain("not instructions");
    expect(block).toContain("### Decisions (ADRs)");
    expect(block).toContain("ADR-14: Muninn memory");
    expect(block).toContain("iter 1: scaffold");
    expect(block).toContain("src/engine/memory/db.ts");
    expect(block.length).toBeLessThanOrEqual(MAX_MEMORY_CONTEXT + 1_000);
  });

  it("is disabled by HUGINN_MEMORY=0", () => {
    seed();
    const previous = process.env.HUGINN_MEMORY;
    process.env.HUGINN_MEMORY = "0";
    try {
      expect(retrieveIncrementContext({ projectRoot: dir, dbPath, modules: ["src"] })).toBe("");
    } finally {
      if (previous === undefined) delete process.env.HUGINN_MEMORY;
      else process.env.HUGINN_MEMORY = previous;
    }
  });

  it("memoryBlockFor is empty when the step context has no dbPath", () => {
    const ctx = {
      projectPath: dir,
      iteration: { index: 1, title: "t", prompt: "p", startLine: 1 },
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      planPath: join(dir, "plan.md"),
      modules: ["src"],
    } as StepContext;
    expect(memoryBlockFor(ctx)).toBe("");
    expect(memoryBlockFor({ ...ctx, dbPath })).toBe("");
  });

  it("derives retrieval signals from the iteration", () => {
    const signals = incrementSignals({
      index: 1,
      title: "Scaffold",
      prompt: "work",
      startLine: 1,
      goal: "the app answers /health",
      acceptanceCriteria: ["REQ-1"],
      verification: ["bun test"],
    });
    expect(signals).toContain("Scaffold");
    expect(signals).toContain("the app answers /health");
    expect(signals).toContain("REQ-1");
  });

  it("returns a non-empty, bounded block for a real indexed increment", () => {
    // A self-contained fixture, never the repository's own database: the real
    // indexer builds the symbol graph, the real curation writes `iter-1`, and
    // retrieval has to find both by the iteration's module.
    const moduleDir = join(dir, "src", "engine");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      join(moduleDir, "demo.ts"),
      "export function demoIncrement(value: string): string {\n  return value.trim();\n}\n",
    );
    const service = new MemoryService({ projectRoot: dir, dbPath });
    try {
      indexFilesIntoMuninn(service, ["src/engine/demo.ts"], { projectRoot: dir });
    } finally {
      service.close();
    }

    const iteration: Iteration = {
      index: 1,
      title: "Demo increment",
      prompt: "build it",
      startLine: 1,
      modules: ["src/engine"],
      goal: "demoIncrement trims its input",
      acceptanceCriteria: ["REQ-DEMO-1"],
      verification: ["bun test"],
    } as Iteration;
    recordIterationObservation({
      projectRoot: dir,
      dbPath,
      iteration,
      verdicts: [],
      filesChanged: ["src/engine/demo.ts"],
    });

    const block = retrieveIncrementContext({
      projectRoot: dir,
      dbPath,
      modules: ["src/engine"],
      signals: incrementSignals(iteration),
    });

    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("<<<BEGIN UNTRUSTED-");
    expect(block).toContain("iter 1: demo-increment");
    expect(block).toContain("demoIncrement");
    // The injected body is hard-capped at 8 KB; only the nonce wrapper may add.
    expect(block.length).toBeLessThanOrEqual(MAX_MEMORY_CONTEXT + 1_000);
  });
});
