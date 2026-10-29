import { spawn, type ChildProcess } from "node:child_process";
import type { Iteration } from "../plan/types";
import { sanitizeTerminalText } from "../util/text.js";

/** Bound each captured stream so a runaway command cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 64 * 1024;

/** How much of a command's output the human report keeps. */
const REPORT_TAIL_LINES = 40;

export interface VerificationCommandResult {
  command: string;
  exitCode: number | null;
  /** Signal the process died from, when it did. `null` for an ordinary exit. */
  signal: string | null;
  /** The process died from a signal instead of returning an exit status. */
  crashed: boolean;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface VerificationResult {
  results: VerificationCommandResult[];
  ok: boolean;
}

/**
 * The fatal signals a verification command can plausibly die from. A crash is
 * *not* an assertion failure: it says nothing about the source, so the fixer must
 * not be asked to "fix" it blind (see {@link formatVerificationReport}).
 */
const FATAL_SIGNALS: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGUSR1",
  11: "SIGSEGV",
  12: "SIGUSR2",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
  31: "SIGSYS",
};

/**
 * The signal an exit status encodes, if any.
 *
 * Commands run through `shell: true`, so the direct child is the shell: when the
 * real command dies from SIGSEGV the shell survives and reports `128 + 11`
 * (139) with `signal === null`. Without this mapping that crash is
 * indistinguishable from a command that deliberately exited 139.
 */
export function signalFromExitCode(exitCode: number | null): string | null {
  if (exitCode === null || exitCode <= 128 || exitCode > 128 + 31) return null;
  return FATAL_SIGNALS[exitCode - 128] ?? null;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // best-effort: the process may already be gone
    }
  }
}

/**
 * Run one non-interactive verification command in `cwd`.
 *
 * The command comes from the plan, which the user owns; it runs inside the
 * iteration's sandbox with the same shell semantics a Makefile would use. The
 * contract is the same as the rest of the engine: never throw, always report
 * what happened, and always terminate (process-group kill on timeout).
 */
export function runVerificationCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> },
): Promise<VerificationCommandResult> {
  const startedAt = Date.now();
  return new Promise<VerificationCommandResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (exitCode: number | null, timedOut: boolean, signal: string | null = null) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // A timeout is our own SIGKILL, so it is reported as a timeout and never
      // as a crash: the command did not die on its own.
      const diedBySignal = timedOut ? null : (signal ?? signalFromExitCode(exitCode));
      resolve({
        command,
        exitCode,
        signal: diedBySignal,
        crashed: diedBySignal !== null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    };

    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      stderr = sanitizeTerminalText(err instanceof Error ? err.message : String(err));
      finish(null, false);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes >= MAX_CAPTURE_BYTES) return;
      const remaining = MAX_CAPTURE_BYTES - stdoutBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stdout += slice.toString("utf8");
      stdoutBytes += slice.length;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes >= MAX_CAPTURE_BYTES) return;
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;
    });

    child.on("error", (err) => {
      stderr += `\n${sanitizeTerminalText(err instanceof Error ? err.message : String(err))}`;
      finish(null, false);
    });
    child.on("close", (code, signal) => finish(code, false, signal ?? null));

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        stderr += `\n[huginn] verification command timed out after ${options.timeoutMs}ms`;
        finish(null, true);
      }, options.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  });
}

/** Run every command, sequentially, and collapse the outcome into one verdict. */
export async function runVerification(
  commands: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> },
): Promise<VerificationResult> {
  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    results.push(await runVerificationCommand(command, options));
  }
  return {
    results,
    ok: results.every((result) => !result.timedOut && result.exitCode === 0),
  };
}

function tail(text: string, lines = REPORT_TAIL_LINES): string {
  const all = sanitizeTerminalText(text).trimEnd().split(/\r?\n/);
  if (all.length <= lines) return all.join("\n");
  return [`… ${all.length - lines} line(s) omitted …`, ...all.slice(-lines)].join("\n");
}

/** A human- and fixer-readable report for one iteration's verification. */
export function formatVerificationReport(
  iteration: Iteration,
  result: VerificationResult,
): string {
  const title = sanitizeTerminalText(iteration.title);
  if (result.results.length === 0) {
    return [
      `# Verification — Iteration ${iteration.index} — ${title}`,
      "",
      "No `Verification:` commands were declared by this plan.",
      "The increment is gated by the existing QA / validation phases instead.",
      "",
      "### Verification status: PASS (nothing to run)",
    ].join("\n");
  }

  const lines: string[] = [
    `# Verification — Iteration ${iteration.index} — ${title}`,
    "",
    `The harness ran ${result.results.length} verification command(s) inside the iteration sandbox.`,
    "",
  ];

  for (const command of result.results) {
    const status = command.timedOut
      ? "TIMED OUT"
      : command.crashed
        ? `CRASHED (${command.signal ?? `exit ${command.exitCode ?? "unknown"}`})`
        : command.exitCode === 0
          ? "PASS"
          : `FAILED (exit ${command.exitCode ?? "unknown"})`;
    lines.push(`## \`${sanitizeTerminalText(command.command)}\``);
    lines.push(`- Status: **${status}**`);
    lines.push(`- Duration: ${(command.durationMs / 1000).toFixed(1)}s`);
    if (command.stdout.trim().length > 0) {
      lines.push("", "### stdout", "```", tail(command.stdout), "```");
    }
    if (command.stderr.trim().length > 0) {
      lines.push("", "### stderr", "```", tail(command.stderr), "```");
    }
    lines.push("");
  }

  const crashes = result.results.filter((command) => command.crashed);
  if (crashes.length > 0) {
    // huginn writes this section itself, so it is trusted text and reaches the
    // fixer verbatim — unlike the command's output, which is untrusted data.
    const names = crashes
      .map((command) => command.signal ?? `exit ${command.exitCode ?? "unknown"}`)
      .join(", ");
    lines.push(
      "### Crash, not an assertion",
      "",
      `The verification command died from ${names}. No source edit caused this and none can fix it: ` +
        "a signal death is a crash, not a failing expectation.",
      "",
      "A crash while a suite starts is usually the environment — conflicting GPU/display drivers " +
        "(e.g. Mesa and a vendor Vulkan/EGL driver loaded in the same process), no display, " +
        "out of memory, or a stack overflow. Before touching code: isolate or serialize the " +
        "offending test, pin the driver, or remove the command from `Verification:`.",
      "",
    );
  }

  lines.push(
    result.ok
      ? "### Verification status: PASS"
      : crashes.length > 0
        ? "### Verification status: BLOCKED — the verification command crashed " +
          `(${crashes[0]!.signal ?? "signal"}); this is an environment failure, not a source defect.`
        : "### Verification status: BLOCKED — fix the failing command(s) before this increment can be promoted.",
  );
  return lines.join("\n");
}
