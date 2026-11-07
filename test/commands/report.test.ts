import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatReceipt,
  handleReportCommand,
  listReceipts,
  readReceipt,
} from "../../src/commands/report";
import { evidenceClassForPhase, unprovenClaims } from "../../src/engine/evidence";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "huginn-report-test-"));
  roots.push(root);
  mkdirSync(join(root, ".huginn", "receipts"), { recursive: true });
  return root;
}

function writeReceipt(project: string, iteration: number, payload: unknown): string {
  const path = join(project, ".huginn", "receipts", `iter-${iteration}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

const V2 = {
  version: 2,
  profile: "rdd",
  evidence: "receipt",
  iteration: 3,
  baseCommit: "6ec69a2e993ce6f106763edfe7311a0c4954d59a",
  headCommit: "ea9fbf21352ac465400c52be5044c14307c26a82",
  treeHash: "f0aae13bc03500cf0519830872f0b79ea0ada344b122dee5a9b47996f28a4de5",
  verdicts: [
    { phase: "EXECUTE", verdict: "pass" },
    { phase: "TEST_MODULE", verdict: "pass" },
    { phase: "VERIFY", verdict: "pass" },
  ],
  lanes: {
    deterministic: [{ phase: "VERIFY", verdict: "pass", basis: "command exit codes, run by huginn" }],
    judgment: [
      { phase: "EXECUTE", verdict: "pass", basis: "agent implementation turn" },
      { phase: "TEST_MODULE", verdict: "pass", basis: "agent-reported suite result, not executed by huginn" },
    ],
  },
  unproven: ["the suite result is the agent's report; huginn did not run it"],
  createdAt: "2026-11-02T21:02:14.794Z",
};

describe("evidence classification", () => {
  it("puts the phases the engine executes in the deterministic lane", () => {
    expect(evidenceClassForPhase("VERIFY")).toBe("deterministic");
    expect(evidenceClassForPhase("COMMIT_ALL")).toBe("deterministic");
    // The agent runs the suite today: the phase is a report, not a test run.
    expect(evidenceClassForPhase("TEST_MODULE")).toBe("judgment");
    expect(evidenceClassForPhase("REVIEW")).toBe("judgment");
    expect(evidenceClassForPhase("FIX_VERIFY")).toBe("judgment");
  });

  it("states what a receipt cannot prove instead of implying it proved everything", () => {
    const claims = unprovenClaims(["EXECUTE", "TEST_MODULE", "REVIEW"]);
    expect(claims.some((claim) => claim.includes("agent's report"))).toBe(true);
    expect(claims.some((claim) => claim.includes("worktree"))).toBe(true);
  });
});

describe("huginn report", () => {
  it("reads the lanes recorded by a v2 receipt", () => {
    const project = makeProject();
    const path = writeReceipt(project, 3, V2);
    const view = readReceipt(path, 3);
    expect(view).toBeDefined();
    expect(view?.derived).toBe(false);
    expect(view?.lanes.deterministic.map((entry) => entry.phase)).toEqual(["VERIFY"]);
    expect(view?.lanes.judgment.map((entry) => entry.phase)).toEqual(["EXECUTE", "TEST_MODULE"]);
    expect(view?.unproven).toHaveLength(1);
  });

  it("derives the lanes from a v1 receipt and says the split was not recorded", () => {
    const project = makeProject();
    const path = writeReceipt(project, 1, {
      profile: "huginn",
      iteration: 1,
      verdicts: [
        { phase: "REVIEW", verdict: "pass" },
        { phase: "VERIFY", verdict: "pass" },
      ],
    });
    const view = readReceipt(path, 1);
    expect(view?.version).toBe(1);
    expect(view?.derived).toBe(true);
    expect(view?.lanes.deterministic.map((entry) => entry.phase)).toEqual(["VERIFY"]);
    const text = stripAnsi(formatReceipt(view!).join("\n"));
    expect(text).toContain("derived from the phase names");
    expect(text).toContain("comprobado");
    expect(text).toContain("opinado");
  });

  it("prints both lanes, the commits and the unproven claims", () => {
    const project = makeProject();
    const path = writeReceipt(project, 3, V2);
    const text = stripAnsi(formatReceipt(readReceipt(path, 3)!).join("\n"));
    expect(text).toContain("[huginn] report · iter 3 · rdd");
    expect(text).toContain("base 6ec69a2 → head ea9fbf2");
    expect(text).toContain("comprobado");
    expect(text).toContain("VERIFY");
    expect(text).toContain("opinado");
    expect(text).toContain("TEST_MODULE");
    expect(text).toContain("no probado");
  });

  it("picks the newest receipt, or the requested iteration", () => {
    const project = makeProject();
    writeReceipt(project, 1, { version: 2, iteration: 1, verdicts: [], lanes: { deterministic: [], judgment: [] }, unproven: [] });
    writeReceipt(project, 2, { version: 2, iteration: 2, verdicts: [], lanes: { deterministic: [], judgment: [] }, unproven: [] });

    const lines: string[] = [];
    handleReportCommand({ "--project": project }, { log: (line) => lines.push(line) });
    expect(stripAnsi(lines.join("\n"))).toContain("iter 2");

    const older: string[] = [];
    handleReportCommand({ "--project": project, "--iteration": "1" }, { log: (line) => older.push(line) });
    expect(stripAnsi(older.join("\n"))).toContain("iter 1");

    expect(listReceipts(project).map((entry) => entry.iteration)).toEqual([2, 1]);
  });

  it("says there is nothing to report instead of failing silently", () => {
    const project = makeProject();
    const errors: string[] = [];
    process.exitCode = 0;
    handleReportCommand({ "--project": project }, { log: () => {}, error: (line) => errors.push(line) });
    expect(errors.join("\n")).toContain("no receipts");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("prints the collected object with --json", () => {
    const project = makeProject();
    writeReceipt(project, 3, V2);
    const lines: string[] = [];
    handleReportCommand({ "--project": project, "--json": true }, { log: (line) => lines.push(line) });
    const parsed = JSON.parse(lines.join("\n")) as { iteration: number; lanes: { deterministic: unknown[] } };
    expect(parsed.iteration).toBe(3);
    expect(parsed.lanes.deterministic).toHaveLength(1);
  });
});
