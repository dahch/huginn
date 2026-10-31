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
/**
 * The shell kills itself, so the process really dies from SIGSEGV. The tests
 * that use it run with the memory scope disabled: systemd 255 (the CI runner)
 * expands `$` in `ExecStart` differently from 259, and `$$` is what makes this
 * command mean "my own pid". Scoped signal propagation is covered by
 * `sandbox.test.ts`; here the mapping from a signal to a crash is what matters.
 */
const crashes = "kill -SEGV $$";

/** Run `fn` with the memory scope disabled, restoring the previous value. */
async function withoutScope<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HUGINN_MEMORY_MAX;
  process.env.HUGINN_MEMORY_MAX = "off";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HUGINN_MEMORY_MAX;
    else process.env.HUGINN_MEMORY_MAX = previous;
  }
}

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

  it("reports a signal death as a crash, not as an assertion failure", async () => {
    if (process.platform === "win32") return; // no SIGSEGV there
    await withoutScope(async () => {
      const result = await runVerificationCommand(crashes, {
        cwd: workdir(),
        timeoutMs: 5000,
      });
      expect(result.crashed).toBe(true);
      expect(result.signal).toBe("SIGSEGV");
      expect(result.timedOut).toBe(false);

      const report = formatVerificationReport(iteration, { results: [result], ok: false });
      expect(report).toContain("CRASHED (SIGSEGV)");
      expect(report).toContain("### Crash, not an assertion");
      expect(report).toContain("environment failure, not a source defect");
    });
  });

  it("maps a shell's 128+n status to the signal that killed the command", async () => {
    const result = await runVerificationCommand(exits(139), { cwd: workdir(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(139);
    expect(result.crashed).toBe(true);
    expect(result.signal).toBe("SIGSEGV");
  });

  it("never calls an ordinary failure a crash", async () => {
    const result = await runVerificationCommand(exits(1), { cwd: workdir(), timeoutMs: 5000 });
    expect(result.crashed).toBe(false);
    expect(result.signal).toBeNull();
    const report = formatVerificationReport(iteration, { results: [result], ok: false });
    expect(report).toContain("FAILED (exit 1)");
    expect(report).not.toContain("Crash, not an assertion");
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

  it("flags a crashing command structurally so the engine can skip the fix rounds", async () => {
    if (process.platform === "win32") return;
    await withoutScope(async () => {
      const result = await verifyIteration(context([crashes]));
      expect(result.authoritativeVerdict).toBe("blocked");
      expect(result.crash?.signal).toBe("SIGSEGV");
      expect(result.crash?.command).toBe(crashes);
    });
  });
});
