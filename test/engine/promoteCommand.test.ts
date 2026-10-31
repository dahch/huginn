import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, runPromote } from "../../src/cli.js";
import { freshState, saveState } from "../../src/state/store.js";

/**
 * ADR-62 — `huginn promote` refuses to invent work. These exercise the guards
 * before any runtime is built: no record, nothing to do, an ineligible failure,
 * and a missing plan. The integration itself is covered by
 * `test/engine/promotionRecovery.test.ts`, which needs a real repository.
 */

const dirs: string[] = [];

function tempProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "huginn-promote-cli-")));
  dirs.push(dir);
  return dir;
}

function state(dir: string, promotion?: { status: "promoted" | "none" | "conflict" | "failed"; branch: string; detail?: string }) {
  const value = freshState({
    planHash: "h",
    planPath: path.join(dir, "plan.md"),
    specPath: path.join(dir, "spec.md"),
    adrPath: path.join(dir, "adr.md"),
    thinker: "a/b",
    executor: "c/d",
    mode: "auto",
  });
  value.currentIteration = 1;
  if (promotion) value.promotion = promotion;
  saveState(dir, value);
  return value;
}

function writePlan(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "plan.md"),
    "# Plan\n\n## Iteration 1 — Landing\n\nbuild the landing\n",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

function quiet(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("huginn promote (ADR-62)", () => {
  it("refuses when no harness state exists", async () => {
    quiet();
    const dir = tempProject();
    const code = await runPromote(parseArgs(["promote", "--retry", "--project", dir]));
    expect(code).toBe(1);
  });

  it("refuses when the last promotion was not a failure", async () => {
    quiet();
    const dir = tempProject();
    state(dir, { status: "promoted", branch: "huginn/task-iter-1" });
    writePlan(dir);
    const code = await runPromote(parseArgs(["promote", "--retry", "--project", dir]));
    expect(code).toBe(1);
  });

  it("refuses --repair for a failure about the user's index, pointing at --retry", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = tempProject();
    state(dir, {
      status: "failed",
      branch: "huginn/task-iter-1",
      detail: "cannot park a.ts (partially staged)",
    });
    writePlan(dir);

    const code = await runPromote(parseArgs(["promote", "--repair", "--project", dir]));

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("promote --retry");
  });

  it("refuses when the plan the recovery needs is missing", async () => {
    quiet();
    const dir = tempProject();
    state(dir, { status: "conflict", branch: "huginn/task-iter-1" });
    const code = await runPromote(parseArgs(["promote", "--retry", "--project", dir]));
    expect(code).toBe(1);
  });

  it("owns its --help", async () => {
    quiet();
    const dir = tempProject();
    const code = await runPromote(parseArgs(["promote", "--help", "--project", dir]));
    expect(code).toBe(0);
  });
});
