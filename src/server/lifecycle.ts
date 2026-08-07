import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
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

  const proc = Bun.spawn(
    ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    },
  );

  const append = (chunk: string) => {
    try {
      writeFileSync(logFile, chunk, { flag: "a" });
    } catch {
      /* ignore */
    }
  };

  (async () => {
    for await (const chunk of proc.stdout) append(new TextDecoder().decode(chunk));
  })();
  (async () => {
    for await (const chunk of proc.stderr) append(new TextDecoder().decode(chunk));
  })();

  const exited = proc.exited.catch(() => undefined);

  let url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, timeoutMs);
  } catch (err) {
    const code = await Promise.race([exited, Promise.resolve(undefined)]);
    if (code !== undefined) {
      const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-2000) : "";
      throw new Error(`opencode serve exited with code ${code} before becoming healthy.\n${log}`);
    }
    await proc.kill();
    throw err;
  }

  return {
    url,
    port,
    async close() {
      try {
        await proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}
