import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryService } from "@dahch/muninn";
import { handleMemoryCommand } from "../../src/commands/memory.js";

let dir: string;
let dbPath: string;
let adrPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-memory-decisions-"));
  dbPath = path.join(dir, ".huginn", "muninn.db");
  adrPath = path.join(dir, "adr.md");
  fs.writeFileSync(
    adrPath,
    [
      "# ADR",
      "",
      "## ADR-1: First decision",
      "",
      "Rationale one.",
      "",
      "## ADR-2: Second decision",
      "",
      "Rationale two.",
    ].join("\n"),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function output(log: ReturnType<typeof vi.spyOn>): string {
  return log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
}

function decisionCount(): number {
  const service = new MemoryService({ projectRoot: dir, dbPath });
  try {
    return service.getContext({ category: "decision", limit: 10 }).length;
  } finally {
    service.close();
  }
}

describe("huginn memory decisions", () => {
  it("persists every ADR section and reports the counts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleMemoryCommand("decisions", { "--project": dir, "--db": dbPath, "--adr": adrPath }, []);
    expect(output(log)).toContain("2 saved");
    expect(decisionCount()).toBe(2);
  });

  it("is idempotent on a second run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleMemoryCommand("decisions", { "--project": dir, "--db": dbPath, "--adr": adrPath }, []);
    log.mockClear();
    await handleMemoryCommand("decisions", { "--project": dir, "--db": dbPath, "--adr": adrPath }, []);
    expect(output(log)).toContain("0 saved, 0 updated, 2 unchanged");
    expect(decisionCount()).toBe(2);
  });

  it("--dry-run writes nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await handleMemoryCommand(
      "decisions",
      { "--project": dir, "--db": dbPath, "--adr": adrPath, "--dry-run": true },
      [],
    );
    expect(output(log)).toContain("would save 2 decision(s)");
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
