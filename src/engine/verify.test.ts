import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatVerificationReport,
  runVerification,
  runVerificationCommand,
} from "./verify";
import type { Iteration } from "../plan/types";
import { verifyIteration, type PhaseContext } from "./phases";

const dirs: string[] = [];
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "huginn-verify-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const executable = JSON.stringify(process.execPath);
const exits = (code: number) => `${executable} -e "process.exit(${code})"`;

const iteration: Iteration = {
  index: 3,
  title: "Deliver the increment",
  prompt: "work",
  startLine: 1,
};

describe("deterministic verification", () => {
  it("passes when every command exits 0", async () => {
    const result = await runVerification([exits(0), exits(0)], {
      cwd: workdir(),
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.exitCode)).toEqual([0, 0]);
    expect(formatVerificationReport(iteration, result)).toContain("Verification status: PASS");
  });

  it("blocks on the first real failure and reports the exit code", async () => {
    const result = await runVerification([exits(0), exits(3)], {
      cwd: workdir(),
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(false);
    expect(result.results[1]!.exitCode).toBe(3);
    const report = formatVerificationReport(iteration, result);
    expect(report).toContain("FAILED (exit 3)");
    expect(report).toContain("Verification status: BLOCKED");
  });

  it("kills a hung command and marks it timed out", async () => {
    const command = `${executable} -e "setTimeout(() => {}, 10000)"`;
    const result = await runVerificationCommand(command, {
      cwd: workdir(),
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timed out");
  });

  it("keeps a plan with no verification commands compatible", () => {
    const report = formatVerificationReport(iteration, { results: [], ok: true });
    expect(report).toContain("No `Verification:` commands");
    expect(report).toContain("Verification status: PASS");
  });
});

describe("VERIFY phase", () => {
  function context(verification: string[], verify?: boolean): PhaseContext {
    return {
      projectPath: workdir(),
      sessionId: "",
      models: {
        thinker: { providerID: "x", modelID: "y" },
        executor: { providerID: "x", modelID: "y" },
      },
      iteration: { ...iteration, verification },
      specPath: "",
      adrPath: "",
      planPath: "",
      modules: [],
      phaseTimeoutMs: 5000,
      verify,
    };
  }

  it("returns a pass with a note when the plan declares nothing", async () => {
    const result = await verifyIteration(context([]));
    expect(result.authoritativeVerdict).toBe("pass");
    expect(result.text).toContain("No `Verification:` commands");
  });

  it("returns blocked when a command fails", async () => {
    const result = await verifyIteration(context([exits(2)]));
    expect(result.authoritativeVerdict).toBe("blocked");
    expect(result.text).toContain("FAILED (exit 2)");
  });

  it("honours the --no-verify switch without running anything", async () => {
    const result = await verifyIteration(context([exits(2)], false));
    expect(result.authoritativeVerdict).toBe("pass");
    expect(result.text).toContain("disabled");
  });
});
