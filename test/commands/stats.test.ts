import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRunStats,
  handleStatsCommand,
  median,
  readRunStats,
} from "../../src/commands/stats";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function makeProject(): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "huginn-stats-test-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(join(project, ".harness"), { recursive: true });
  mkdirSync(join(project, ".huginn", "receipts"), { recursive: true });
  return { root, project };
}

const STATE = {
  version: 1,
  planHash: "abc",
  planPath: "/p/plan.md",
  specPath: "/p/spec.md",
  adrPath: "/p/adr.md",
  models: { thinker: "anthropic/claude", executor: "openai/gpt" },
  mode: "auto",
  currentIteration: 2,
  currentPhase: "COMMIT_ALL",
  phaseAttempts: {},
  startedAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:06:00.000Z",
  finishedAt: "2026-11-01T10:06:00.000Z",
  promotion: { status: "promoted", branch: "huginn/iter-2" },
  usage: { inputTokens: 120_000, outputTokens: 30_000, costUsd: 1.25 },
  history: [
    { phase: "EXECUTE", attempt: 1, verdict: "pass", startedAt: "2026-11-01T10:00:00.000Z", finishedAt: "2026-11-01T10:00:10.000Z" },
    { phase: "TEST_MODULE", attempt: 1, verdict: "blocked", startedAt: "2026-11-01T10:00:10.000Z", finishedAt: "2026-11-01T10:00:40.000Z" },
    { phase: "FIX_TEST", attempt: 1, verdict: "pass", startedAt: "2026-11-01T10:00:40.000Z", finishedAt: "2026-11-01T10:01:00.000Z" },
    { phase: "EXECUTE", attempt: 1, verdict: "warning", startedAt: "2026-11-01T10:01:00.000Z", finishedAt: "2026-11-01T10:01:20.000Z" },
  ],
};

describe("huginn stats", () => {
  it("computes the median without inventing one for an empty list", () => {
    expect(median([])).toBeNull();
    expect(median([10])).toBe(10);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20])).toBe(15);
    expect(median([Number.NaN, -5, 4])).toBe(4);
  });

  it("reads state and receipts into one comparable object", () => {
    const { project } = makeProject();
    writeFileSync(join(project, ".harness", "state.json"), JSON.stringify(STATE));
    writeFileSync(
      join(project, ".huginn", "receipts", "iter-1.json"),
      JSON.stringify({ verdicts: [{ phase: "VERIFY", verdict: "pass" }] }),
    );
    writeFileSync(
      join(project, ".huginn", "receipts", "iter-2.json"),
      JSON.stringify({ verdicts: [{ phase: "VERIFY", verdict: "blocked" }] }),
    );
    // Not a receipt: must not be counted.
    writeFileSync(join(project, ".huginn", "receipts", "notes.txt"), "ignore me");

    const stats = readRunStats(project);

    expect(stats.hasState).toBe(true);
    expect(stats.attempts).toBe(4);
    expect(stats.fixRounds).toBe(1);
    expect(stats.receipts).toBe(2);
    expect(stats.verifiedReceipts).toBe(1);
    expect(stats.receiptedIterations).toEqual([1, 2]);
    expect(stats.promotion).toBe("promoted");
    expect(stats.durationMs).toBe(6 * 60 * 1000);
    expect(stats.usage).toEqual({ inputTokens: 120_000, outputTokens: 30_000, costUsd: 1.25 });

    const execute = stats.phases.find((phase) => phase.phase === "EXECUTE");
    expect(execute).toMatchObject({ attempts: 2, pass: 1, warning: 1 });
    // Two attempts at 10s and 20s.
    expect(execute?.medianMs).toBe(15_000);
  });

  it("reports a project that never ran here instead of an empty table", () => {
    const { project } = makeProject();
    const stats = readRunStats(project);
    expect(stats.hasState).toBe(false);
    expect(stats.attempts).toBe(0);

    const text = stripAnsi(formatRunStats(stats).join("\n"));
    expect(text).toContain("no .harness/state.json");
  });

  it("survives a corrupt state file and a corrupt receipt", () => {
    const { project } = makeProject();
    writeFileSync(join(project, ".harness", "state.json"), "{not json");
    writeFileSync(join(project, ".huginn", "receipts", "iter-1.json"), "{not json");
    const stats = readRunStats(project);
    expect(stats.hasState).toBe(false);
    expect(stats.receipts).toBe(1);
    expect(stats.verifiedReceipts).toBe(0);
  });

  it("summarizes verdicts, retries, promotion and usage on one screen", () => {
    const { project } = makeProject();
    writeFileSync(join(project, ".harness", "state.json"), JSON.stringify(STATE));
    const text = stripAnsi(formatRunStats(readRunStats(project)).join("\n"));

    expect(text).toContain("[huginn] stats");
    expect(text).toContain("anthropic/claude");
    expect(text).toContain("4 attempts");
    expect(text).toContain("1 fix round");
    expect(text).toContain("pass 2");
    expect(text).toContain("warning 1");
    expect(text).toContain("blocked 1");
    expect(text).toContain("promotion promoted");
    expect(text).toContain("EXECUTE");
  });

  it("prints the collected object with --json, and only that", () => {
    const { project } = makeProject();
    writeFileSync(join(project, ".harness", "state.json"), JSON.stringify(STATE));
    const lines: string[] = [];
    handleStatsCommand({ "--project": project, "--json": true }, { log: (line) => lines.push(line) });

    const parsed = JSON.parse(lines.join("\n")) as { attempts: number; phases: unknown[] };
    expect(parsed.attempts).toBe(4);
    expect(Array.isArray(parsed.phases)).toBe(true);
  });

  it("keeps exit code 0 with no state, and documents itself with --help", () => {
    const { project } = makeProject();
    const log = vi.fn();
    handleStatsCommand({ "--project": project }, { log });
    expect(log).toHaveBeenCalled();

    const helpLines: string[] = [];
    handleStatsCommand({ "--help": true }, { log: (line) => helpLines.push(line) });
    expect(helpLines.join("\n")).toContain("huginn stats");
    expect(process.exitCode ?? 0).toBe(0);
  });
});
