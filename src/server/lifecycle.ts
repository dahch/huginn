import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ServerExitInfo {
  /** Exit code reported by the child (null when it was signalled). */
  code: number | null;
  /** True when the supervised restart brought the server back to health. */
  recovered: boolean;
}

export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
  /**
   * Liveness of the supervised child (AC-30.4). `false` once it exited
   * mid-session — callers (e.g. `OpencodeRuntimeAdapter.getMcpStatus`) use it to
   * report a *recoverable* error instead of a silent, infinite green badge.
   */
  isHealthy(): boolean;
  /** Invoked on every unexpected exit, including the outcome of the restart. */
  onExit?: (info: ServerExitInfo) => void;
}

/** At most one best-effort restart per daemon (ADR-30.4). */
const MAX_AUTO_RESTARTS = 1;
/** Backoff before a restart attempt; never a reason to keep the process alive. */
const RESTART_BACKOFF_MS = 750;
/** Deadline for the restarted server to become healthy again. */
const RESTART_HEALTH_TIMEOUT_MS = 15_000;
/** How much of the log to quote when a restart fails. */
const LOG_TAIL_BYTES = 2000;

/** Outcome of a restart attempt: health, a dead replacement, or the deadline. */
type RestartOutcome =
  | { kind: "healthy" }
  | { kind: "exited"; code: number | null }
  | { kind: "timeout"; error: Error };

/**
 * Sleeps without holding the event loop open: a supervision timer must never be
 * the reason a process lingers after the agent finished (ADR-30, negative).
 */
function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  const started = Date.now();
  let lastHeartbeat = started;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/global/health`);
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean };
        if (body.healthy !== false) return;
      }
      lastErr = new Error(`health check returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
    const now = Date.now();
    if (now - lastHeartbeat >= 10000) {
      lastHeartbeat = now;
      const elapsed = Math.round((now - started) / 1000);
      console.error(`[huginn] ... still waiting for opencode server (${elapsed}s elapsed)`);
    }
  }
  throw new Error(
    `opencode server did not become healthy within ${timeoutMs}ms. ${(lastErr as Error)?.message ?? ""}. ` +
      `Check .harness/logs/server.log for details.`,
  );
}

export async function startServer(
  projectPath: string,
  port: number,
  timeoutMs: number,
): Promise<ServerHandle> {
  console.error(`[huginn] starting opencode server on port ${port}...`);
  const logFile = join(projectPath, ".harness", "logs", "server.log");
  mkdirSync(join(projectPath, ".harness", "logs"), { recursive: true });
  writeFileSync(logFile, "");

  const append = (chunk: string) => {
    try {
      writeFileSync(logFile, chunk, { flag: "a" });
    } catch {
      /* ignore */
    }
  };

  const spawnChild = () => {
    const child = Bun.spawn(
      ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd: projectPath,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );
    (async () => {
      for await (const chunk of child.stdout) append(new TextDecoder().decode(chunk));
    })();
    (async () => {
      for await (const chunk of child.stderr) append(new TextDecoder().decode(chunk));
    })();
    return child;
  };

  let proc = spawnChild();
  let exited: Promise<number | null> = proc.exited.catch(() => null);

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, timeoutMs);
  } catch (err) {
    const code = await Promise.race([exited, Promise.resolve(undefined)]);
    if (code !== undefined) {
      const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-LOG_TAIL_BYTES) : "";
      throw new Error(`opencode serve exited with code ${code} before becoming healthy.\n${log}`);
    }
    await proc.kill();
    throw err;
  }

  /**
   * Supervision state. `closing` is set by `close()` so an intentional shutdown
   * is never mistaken for a crash and never triggers a restart.
   */
  const state = { healthy: true, closing: false, restarts: 0, lastExitCode: null as number | null };

  const handle: ServerHandle = {
    url,
    port,
    isHealthy: () => state.healthy && !state.closing,
    async close() {
      state.closing = true;
      state.healthy = false;
      try {
        await proc.kill();
      } catch {
        /* ignore */
      }
    },
  };

  /**
   * Mid-session death is invisible to every caller (the endpoint simply stops
   * answering), so the child is watched for the whole session (AC-30.4): the
   * exit is logged, `isHealthy()` flips to false, and — at most once — the
   * server is restarted and re-checked before giving up.
   *
   * Both restart probes below *resolve* rather than reject, so the losing side
   * of the race can never surface as an unhandled rejection.
   */
  const supervise = async (): Promise<void> => {
    while (!state.closing) {
      const code = await exited;
      if (state.closing) return;

      state.healthy = false;
      state.lastExitCode = code;
      console.error(`[huginn] opencode server exited (code ${code})`);

      if (state.restarts >= MAX_AUTO_RESTARTS) {
        console.error("[huginn] opencode server will not be restarted again — run `/agent` to recover.");
        handle.onExit?.({ code, recovered: false });
        return;
      }
      state.restarts += 1;

      await unrefDelay(RESTART_BACKOFF_MS);
      if (state.closing) return;

      console.error("[huginn] restarting opencode server (best-effort, attempt 1)...");
      proc = spawnChild();
      exited = proc.exited.catch(() => null);

      const health = waitForHealth(url, RESTART_HEALTH_TIMEOUT_MS).then(
        (): RestartOutcome => ({ kind: "healthy" }),
        (err: unknown): RestartOutcome => ({
          kind: "timeout",
          error: err instanceof Error ? err : new Error(String(err)),
        }),
      );
      const death = exited.then((code2): RestartOutcome => ({ kind: "exited", code: code2 }));

      const outcome = await Promise.race([health, death]);
      if (outcome.kind === "healthy") {
        state.healthy = true;
        console.error("[huginn] opencode server recovered");
        handle.onExit?.({ code, recovered: true });
        continue;
      }

      const detail =
        outcome.kind === "exited"
          ? `restarted process exited with code ${outcome.code}`
          : outcome.error.message;
      console.error(`[huginn] opencode server restart failed: ${detail}`);
      handle.onExit?.({ code, recovered: false });
      return;
    }
  };

  void supervise();

  return handle;
}
