import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  isProfileName,
  phasesForProfile,
  profilePreamble,
  profileSpec,
  PROFILE_NAMES,
  PROFILE_PHASES,
  validateProfilePhases,
  type ProfileName,
} from "../../src/engine/profiles.js";
import { buildIterationReceipt, writeIterationReceipt } from "../../src/engine/receipts.js";
import type { PhaseName } from "../../src/engine/types.js";

/** Every phase the engine can actually run today. */
const IMPLEMENTED: PhaseName[] = [
  "SPEC_AUDIT",
  "EXECUTE",
  "VALIDATE_STEP",
  "TEST_MODULE",
  "SECURE_CHECK",
  "REVIEW",
  "DOC_SYNC",
  "COMMIT_ALL",
];

describe("methodology profiles (REQ-36 / ADR-35)", () => {
  it("defaults to the Huginn Cycle and keeps its pipeline unchanged", () => {
    expect(DEFAULT_PROFILE).toBe("huginn");
    // The default profile *is* the pipeline Huginn always ran: eight phases, in
    // order. If this changes, the default behaviour changed.
    expect(phasesForProfile(undefined)).toEqual([
      "SPEC_AUDIT",
      "EXECUTE",
      "VALIDATE_STEP",
      "TEST_MODULE",
      "SECURE_CHECK",
      "REVIEW",
      "DOC_SYNC",
      "COMMIT_ALL",
    ]);
    expect(profileSpec(undefined).name).toBe("Huginn Cycle");
  });

  it("defines the four alternative methodologies over the existing vocabulary", () => {
    expect(PROFILE_NAMES).toEqual(["huginn", "sdd", "odd", "rdd", "strict-tdd"]);

    // ODD: lightweight — no heavy gates.
    expect(phasesForProfile("odd")).toEqual(["EXECUTE", "TEST_MODULE", "COMMIT_ALL"]);

    // SDD: spec-first and archived through the docs.
    expect(phasesForProfile("sdd")[0]).toBe("SPEC_AUDIT");
    expect(phasesForProfile("sdd")).toContain("DOC_SYNC");

    // RDD: verification produces a receipt.
    expect(phasesForProfile("rdd")).toEqual([
      "EXECUTE",
      "TEST_MODULE",
      "VALIDATE_STEP",
      "COMMIT_ALL",
    ]);
    expect(profileSpec("rdd").evidence).toBe("receipt");

    // Strict TDD: tests come *first*, and the gate re-runs them after EXECUTE.
    const tdd = phasesForProfile("strict-tdd");
    expect(tdd[0]).toBe("TEST_MODULE");
    expect(tdd.filter((p) => p === "TEST_MODULE")).toHaveLength(2);
    expect(profileSpec("strict-tdd").evidence).toBe("snapshot");
  });

  it("only ever names runnable phases, and fails closed on one it cannot (AC-36.6)", () => {
    for (const name of PROFILE_NAMES) {
      expect(validateProfilePhases(name, new Set(IMPLEMENTED))).toEqual({ ok: true });
      // `--only-phase` validation and the progress renderer read this list.
      for (const phase of phasesForProfile(name)) expect(PROFILE_PHASES).toContain(phase);
    }
    // A profile that names something the engine cannot run must not degrade to the
    // default silently — it must error.
    const bogus = validateProfilePhases("sdd" as ProfileName, new Set(["EXECUTE"]));
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.missing.length).toBeGreaterThan(0);
  });

  it("carries the methodology instruction only for the profiles that need one", () => {
    expect(profilePreamble("huginn")).toBe("");
    expect(profilePreamble("odd")).toMatch(/small and direct/i);
    expect(profilePreamble("strict-tdd")).toMatch(/test-first/i);
    expect(profilePreamble("sdd")).toMatch(/spec-first/i);
  });

  it("recognises only real profile ids", () => {
    expect(isProfileName("huginn")).toBe(true);
    expect(isProfileName("strict-tdd")).toBe(true);
    expect(isProfileName("madness")).toBe(false);
  });
});

describe("frozen iteration evidence (AC-36.4)", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("produces no receipt for the profiles that do not require evidence", () => {
    expect(
      buildIterationReceipt({
        profile: "huginn",
        iteration: 1,
        title: "x",
        projectPath: "/tmp/does-not-matter",
        verdicts: [],
      }),
    ).toBeUndefined();
    expect(
      buildIterationReceipt({
        profile: "odd",
        iteration: 1,
        title: "x",
        projectPath: "/tmp/does-not-matter",
        verdicts: [],
      }),
    ).toBeUndefined();
  });

  it("freezes a receipt for rdd and a pre-EXECUTE snapshot for strict-tdd", () => {
    const rdd = buildIterationReceipt({
      profile: "rdd",
      iteration: 3,
      title: "Add receipts",
      projectPath: process.cwd(),
      verdicts: [{ phase: "TEST_MODULE", verdict: "pass" }],
    });
    expect(rdd).toBeDefined();
    expect(rdd!.evidence).toBe("receipt");
    expect(rdd!.verdicts).toEqual([{ phase: "TEST_MODULE", verdict: "pass" }]);
    expect(rdd!.preExecuteTree).toBeUndefined();

    const tdd = buildIterationReceipt({
      profile: "strict-tdd",
      iteration: 4,
      title: "Tests first",
      projectPath: process.cwd(),
      verdicts: [],
      preExecuteTree: "deadbeef",
    });
    expect(tdd!.evidence).toBe("snapshot");
    expect(tdd!.preExecuteTree).toBe("deadbeef");
  });

  it("writes the receipt to .huginn/receipts and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "huginn-receipt-"));
    dirs.push(dir);
    const receipt = buildIterationReceipt({
      profile: "rdd",
      iteration: 2,
      title: "receipt",
      projectPath: dir,
      verdicts: [],
    })!;

    const path = writeIterationReceipt(dir, receipt);
    expect(path).toBe(join(dir, ".huginn", "receipts", "iter-2.json"));
    expect(JSON.parse(readFileSync(path!, "utf8")).profile).toBe("rdd");

    // A path that cannot be created is a silent no-op, never a failed iteration.
    // A regular file used as a path component makes `mkdir` fail with ENOTDIR
    // instantly on every platform. Do NOT use a `/proc/...` path here: Node's
    // recursive `mkdirSync` spins forever on procfs (which answers EPERM),
    // hanging the whole run on Linux runners.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    expect(writeIterationReceipt(join(blocker, "nested"), receipt)).toBeUndefined();
  });
});
