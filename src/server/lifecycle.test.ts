import { describe, it, expect, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer, type ServerExitInfo } from "./lifecycle";

/**
 * A stub `opencode serve` (ADR-30.4). It answers `/global/health` while alive,
 * then exits with code 7. `HUGINN_STUB_DEAD_ON_RESTART=1` makes every *later*
 * run (i.e. the supervised restart) die immediately without serving, so the
 * recovery attempt is deterministic instead of racing a health deadline.
 */
const STUB = `#!/usr/bin/env bun
const port = Number(process.argv[process.argv.indexOf("--port") + 1] ?? 0);
const marker = process.env.HUGINN_STUB_MARKER;
// Printed so the log-append path (SEC-101) has something real to capture.
console.log("[huginn-stub] serving");
const runs = await (async () => {
  try {
    const file = Bun.file(marker);
    const previous = (await file.exists()) ? Number(await file.text()) : 0;
    const next = previous + 1;
    await Bun.write(marker, String(next));
    return next;
  } catch {
    return 1;
  }
})();
if (runs > 1 && process.env.HUGINN_STUB_DEAD_ON_RESTART === "1") {
  process.exit(9);
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    if (new URL(req.url).pathname === "/global/health") {
      return Response.json({ healthy: true });
    }
    return new Response("not found", { status: 404 });
  },
});
await new Promise((r) => setTimeout(r, Number(process.env.HUGINN_STUB_LIFETIME_MS ?? 300)));
server.stop(true);
process.exit(7);
`;

const originalPath = process.env.PATH;
const originalEnv = {
  marker: process.env.HUGINN_STUB_MARKER,
  lifetime: process.env.HUGINN_STUB_LIFETIME_MS,
  deadOnRestart: process.env.HUGINN_STUB_DEAD_ON_RESTART,
};

let tempDir: string | undefined;

afterEach(() => {
  process.env.PATH = originalPath;
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("HUGINN_STUB_MARKER", originalEnv.marker);
  restore("HUGINN_STUB_LIFETIME_MS", originalEnv.lifetime);
  restore("HUGINN_STUB_DEAD_ON_RESTART", originalEnv.deadOnRestart);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

/** Installs the stub as `opencode` on PATH and returns the temp project dir. */
function installStub(): { projectDir: string; marker: string } {
  tempDir = mkdtempSync(join(tmpdir(), "huginn-lifecycle-"));
  const binDir = join(tempDir, "bin");
  const projectDir = join(tempDir, "project");
  const marker = join(tempDir, "runs.txt");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const stub = join(binDir, "opencode");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.HUGINN_STUB_MARKER = marker;
  return { projectDir, marker };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A free loopback port (`startServer` needs a concrete one for its health probe). */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== "number") throw new Error("could not allocate a free port");
  return port;
}

describe("startServer daemon supervision (AC-30.4)", () => {
  it("marks the handle unhealthy and reports an unrecovered exit when the child dies mid-session", async () => {
    const { projectDir } = installStub();
    process.env.HUGINN_STUB_LIFETIME_MS = "1500";
    process.env.HUGINN_STUB_DEAD_ON_RESTART = "1";

    const exits: ServerExitInfo[] = [];
    const handle = await startServer(projectDir, freePort(), 5000);
    handle.onExit = (info) => exits.push(info);
    expect(handle.isHealthy()).toBe(true);

    // The stub exits ~1.5s in; the single restart then fails immediately.
    await waitFor(() => exits.length > 0, 10_000, "the supervised exit to be reported");

    expect(exits[0]!.code).toBe(7);
    expect(exits[0]!.recovered).toBe(false);
    expect(handle.isHealthy()).toBe(false);

    await handle.close();
  }, 20_000);

  it("recovers once when the restarted server becomes healthy again", async () => {
    const { projectDir } = installStub();
    process.env.HUGINN_STUB_LIFETIME_MS = "1500";
    // No HUGINN_STUB_DEAD_ON_RESTART → the restart serves health and stays up.
    delete process.env.HUGINN_STUB_DEAD_ON_RESTART;

    const exits: ServerExitInfo[] = [];
    const handle = await startServer(projectDir, freePort(), 5000);
    handle.onExit = (info) => exits.push(info);

    await waitFor(() => exits.some((e) => e.recovered), 10_000, "the successful recovery");
    expect(handle.isHealthy()).toBe(true);

    await handle.close();
    // An intentional shutdown must not be reported as a mid-session death.
    const reports = exits.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(exits.length).toBe(reports);
  }, 20_000);

  it("does not attempt a restart when the caller closes the server", async () => {
    const { projectDir } = installStub();
    process.env.HUGINN_STUB_LIFETIME_MS = "5000";

    const exits: ServerExitInfo[] = [];
    const handle = await startServer(projectDir, freePort(), 5000);
    handle.onExit = (info) => exits.push(info);

    await handle.close();
    expect(handle.isHealthy()).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(exits).toEqual([]);
  }, 20_000);
});

/**
 * SEC-101 — the server log is *repository-reachable* (`.harness/logs/server.log`
 * is an ordinary tracked-looking path a clone controls), and it used to be
 * created and truncated blind: `mkdirSync({recursive: true})` then
 * `writeFileSync(logFile, "")` both follow a symlink, so a cloned project could
 * have huginn truncate and then fill a file of its choosing anywhere on the host.
 */
describe("startServer log containment (SEC-101)", () => {
  /** `console.error` is where the degradation warning is reported. */
  function captureErrors(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    return { lines, restore: () => { console.error = original; } };
  }

  /** A directory outside the project, standing in for anything precious. */
  function victimDir(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "huginn-lifecycle-victim-"));
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  const windows = process.platform === "win32";

  it("refuses a symlinked server.log and never truncates its target", async () => {
    if (windows) return; // symlinks need privileges on Windows
    const { projectDir } = installStub();
    process.env.HUGINN_STUB_LIFETIME_MS = "5000";
    const victim = victimDir();
    const target = join(victim.root, "precious.txt");
    writeFileSync(target, "the user's file\n");
    mkdirSync(join(projectDir, ".harness", "logs"), { recursive: true });
    const link = join(projectDir, ".harness", "logs", "server.log");
    symlinkSync(target, link);

    const errors = captureErrors();
    try {
      const handle = await startServer(projectDir, freePort(), 5000);
      await handle.close();

      // The link's target is byte-for-byte untouched, and the link is still a link
      // (huginn did not replace or write through it).
      expect(readFileSync(target, "utf8")).toBe("the user's file\n");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(errors.lines.join("\n")).toContain("refusing to write");
      expect(errors.lines.join("\n")).toContain("symlink");
    } finally {
      errors.restore();
      victim.cleanup();
    }
  }, 20_000);

  it("refuses a symlinked .harness directory that escapes the project", async () => {
    if (windows) return;
    const { projectDir } = installStub();
    process.env.HUGINN_STUB_LIFETIME_MS = "5000";
    const victim = victimDir();
    symlinkSync(victim.root, join(projectDir, ".harness"));

    const errors = captureErrors();
    try {
      const handle = await startServer(projectDir, freePort(), 5000);
      await handle.close();

      // Nothing was created *through* the link, and the link was not replaced.
      expect(readdirSync(victim.root)).toEqual([]);
      expect(lstatSync(join(projectDir, ".harness")).isSymbolicLink()).toBe(true);
      expect(errors.lines.join("\n")).toContain("refusing to write");
    } finally {
      errors.restore();
      victim.cleanup();
    }
  }, 20_000);

  it("still creates and truncates the log on a safe path, 0o600", async () => {
    const { projectDir } = installStub();
    process.env.HUGINN_STUB_LIFETIME_MS = "5000";

    const handle = await startServer(projectDir, freePort(), 5000);

    const logFile = join(projectDir, ".harness", "logs", "server.log");
    expect(existsSync(logFile)).toBe(true);
    expect(lstatSync(logFile).isSymbolicLink()).toBe(false);
    // The child's output reaches the log through the `O_APPEND|O_NOFOLLOW` writer.
    await waitFor(
      () => readFileSync(logFile, "utf8").includes("[huginn-stub] serving"),
      10_000,
      "the child's output to reach the log",
    );

    await handle.close();
    if (!windows) {
      expect(lstatSync(logFile).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(projectDir, ".harness", "logs")).mode & 0o777).toBe(0o700);
    }
  }, 20_000);

  it("truncates a previous run's log instead of appending to it", async () => {
    const { projectDir } = installStub();
    process.env.HUGINN_STUB_LIFETIME_MS = "5000";
    // A clone (or an earlier run) left content behind: this session must start
    // from an empty log, never from a stale one.
    const logFile = join(projectDir, ".harness", "logs", "server.log");
    mkdirSync(join(projectDir, ".harness", "logs"), { recursive: true });
    writeFileSync(logFile, "stale output from a previous run\n");

    const handle = await startServer(projectDir, freePort(), 5000);
    expect(readFileSync(logFile, "utf8")).not.toContain("stale output");
    await handle.close();
  }, 20_000);
});
