import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeTerminalText } from "../../../util/text.js";

/**
 * Hard deadline for a runtime's model-listing command (REQ-27 / NFR-6).
 *
 * Measured on the reference machine: `opencode models` ≈ 1.6 s and
 * `commandcode --list-models` ≈ 3.9 s (the latter fetches its catalog over the
 * network), so a very short bound would make honest discovery fail permanently.
 * The spawn is asynchronous (it never blocks the Ink render loop), the picker
 * shows a cancellable loading state, and the child is killed on expiry.
 */
export const MODEL_LIST_TIMEOUT_MS = 8000;

/** Bound stdout accumulation so a runaway CLI cannot exhaust memory. */
const MAX_MODEL_LIST_BYTES = 10 * 1024 * 1024;

/** Bound the (sanitized) stderr excerpt surfaced as a failure reason. */
const MAX_STDERR_REASON_CHARS = 200;
const MAX_STDERR_BYTES = 64 * 1024;

/** SIGTERM-then-SIGKILL a listing CLI's whole process group (it may spawn helpers). */
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
      // best-effort
    }
  }
}

/**
 * Outcome of a model-listing command (REQ-27 / AC-27.2, AC-27.3, REV-002).
 *
 * `error` is a short, already-sanitized explanation of *why* there is no usable
 * catalog — a missing binary, a non-zero exit (with the first stderr line), a
 * timeout or empty output — so an empty result is never indistinguishable from
 * a failure. It never carries raw terminal control sequences.
 */
export interface ModelListCommandResult {
  stdout?: string;
  error?: string;
}

/**
 * First non-empty line of `stderr`, sanitized and length-bounded, prefixed so it
 * reads as an excerpt in the picker. Returns `undefined` when stderr is blank.
 */
function describeStderr(stderr: string): string | undefined {
  const firstLine = stderr
    .split(/\r?\n/)
    .map((line) => sanitizeTerminalText(line).trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > MAX_STDERR_REASON_CHARS
    ? `${firstLine.slice(0, MAX_STDERR_REASON_CHARS)}…`
    : firstLine;
}

/**
 * Runs an external model-listing command (e.g. `opencode models`,
 * `commandcode --list-models`) with a bounded timeout and output cap.
 *
 * Resolution contract (REQ-27 / AC-27.2, AC-27.3): never throws and never
 * fabricates output. A missing binary, a non-zero exit, a timeout, a stream
 * error or empty output all resolve with an `error` reason (and no `stdout`), so
 * the caller can report an honest empty catalog instead of substituting a
 * hardcoded one.
 */
export function runModelListCommand(
  command: string,
  args: string[],
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<ModelListCommandResult> {
  const timeoutMs = options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS;

  return new Promise<ModelListCommandResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let bytes = 0;
    let stderr = "";
    let stderrBytes = 0;

    const finish = (result: ModelListCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      resolve(result);
    };

    const fail = (error: string) => finish({ error });

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...options.env },
        // SEC-001: stderr is captured (bounded) rather than discarded so failures
        // can be explained truthfully.
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group so a timeout can reap any helper the CLI spawned
        // (SEC-003), matching the session prompt path in `generic.ts`.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      fail(`failed to run \`${command} ${args.join(" ")}\`: ${sanitizeError(err)}`);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (bytes >= MAX_MODEL_LIST_BYTES) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_MODEL_LIST_BYTES - bytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stdout += slice.toString("utf8");
      bytes += slice.length;
    });
    child.stdout?.on("error", () => fail(`\`${command} ${args.join(" ")}\` stream error`));

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stderr += slice.toString("utf8");
      stderrBytes += slice.length;
    });
    child.stderr?.on("error", () => {
      // stderr is only used to explain a failure; a broken pipe is not fatal.
    });

    child.on("error", (err) => {
      // ENOENT etc. — the binary is missing or not executable.
      const detail = sanitizeError(err);
      fail(`could not run \`${command}\`: ${detail}`);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        if (stdout.trim().length === 0) {
          fail(`\`${command} ${args.join(" ")}\` printed no output`);
          return;
        }
        finish({ stdout });
        return;
      }
      const stderrExcerpt = describeStderr(stderr);
      const status = code === null ? `killed by ${signal ?? "signal"}` : `exited with code ${code}`;
      fail(`\`${command} ${args.join(" ")}\` ${status}${stderrExcerpt ? `: ${stderrExcerpt}` : ""}`);
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        fail(`\`${command} ${args.join(" ")}\` timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }
  });
}

/** Bounded, sanitized rendering of a spawn error (never leaks control chars). */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const sanitized = sanitizeTerminalText(message).replace(/\s+/g, " ").trim();
  return sanitized.length > MAX_STDERR_REASON_CHARS
    ? `${sanitized.slice(0, MAX_STDERR_REASON_CHARS)}…`
    : sanitized;
}
