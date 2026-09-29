/**
 * Phase 4C — the CLI flags that manage persisted live sessions on top of the 4B
 * store (`src/state/liveSession.ts`):
 *
 *   - `--continue` / `-c`        resume the *latest* live session of the project
 *   - `--session <id>`           resume that exact session
 *   - `--list-sessions` / `-sl`  print the stored sessions and exit 0
 *
 * Two things are asserted here and nothing else: the flags parse the way `runLive`
 * reads them (a boolean never eats the next argv entry), and the resolution /
 * listing is exactly the semantics documented in `usage()` — `--session` wins,
 * `--continue` takes the newest, *no flag means no resume*, an unknown handle
 * falls through to a new session (where the engine warns), and listing is a
 * read-only report that always exits 0. Reattaching an opencode session is
 * covered in `test/engine/liveSessionPersistence.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, main, parseArgs, printLiveSessions, resolveResume, usage, usageCore } from "../../src/cli.js";
import { liveDir, liveSessionsPath, saveLiveSession, type LiveSession } from "../../src/state/liveSession";
import { sanitizeTerminalText } from "../../src/util/text";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-live-flags-"));
  // A stray exit code from another suite must never look like ours.
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

/** Runs `main()` with both console channels captured, like the CLI's own tests. */
async function captureMain(argv: string[]): Promise<{ output: string; errors: string }> {
  const lines: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map((part) => String(part)).join(" "));
  });
  try {
    await main(argv);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { output: stripAnsi(lines.join("\n")), errors: stripAnsi(errors.join("\n")) };
}

/** Captures `console.log` for a direct call (no `main()`). */
function captureSync(run: () => void): string {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map((part) => String(part)).join(" "));
  });
  try {
    run();
  } finally {
    logSpy.mockRestore();
  }
  return stripAnsi(lines.join("\n"));
}

function makeSession(overrides: Partial<LiveSession> = {}): LiveSession {
  const now = new Date().toISOString();
  return {
    id: "session-id",
    createdAt: now,
    updatedAt: now,
    runtimeId: "opencode",
    projectPath: dir,
    messages: [],
    ...overrides,
  };
}

/** Two stored sessions: `older` (written first) and `newer` (written last). */
function seedSessions(): { older: LiveSession; newer: LiveSession } {
  const older = saveLiveSession(
    dir,
    makeSession({
      id: "11111111-1111-1111-1111-111111111111",
      title: "add notifications",
      messages: [
        { role: "user", text: "add notifications" },
        { role: "assistant", text: "which channel?" },
      ],
    }),
  );
  const newer = saveLiveSession(
    dir,
    makeSession({
      id: "22222222-2222-2222-2222-222222222222",
      runtimeId: "claude",
      messages: [{ role: "user", text: "second conversation" }],
    }),
  );
  // the records as they landed on disk (the store refreshes `updatedAt`)
  return { older, newer };
}

describe("Phase 4C — live session flags parse as documented", () => {
  it("treats --continue/-c and --list-sessions/-sl as boolean flags", () => {
    for (const flag of ["--continue", "-c", "--list-sessions", "-sl"]) {
      const parsed = parseArgs([flag]);
      expect(parsed[flag]).toBe(true);
      expect(parsed._positional).toBeUndefined();
      expect(parsed._positionals).toEqual([]);
    }
  });

  it("never lets a boolean live-session flag consume the next argv entry", () => {
    // `huginn live -c "keep going"` must keep the idea as the positional.
    const withIdea = parseArgs(["live", "-c", "keep going"]);
    expect(withIdea["-c"]).toBe(true);
    expect(withIdea._command).toBe("live");
    expect(withIdea._positional).toBe("keep going");

    const withList = parseArgs(["live", "--list-sessions", "trailing"]);
    expect(withList["--list-sessions"]).toBe(true);
    expect(withList._positional).toBe("trailing");
  });

  it("reads --session as a value flag, both spellings", () => {
    const spaced = parseArgs(["live", "--session", "abc-123"]);
    expect(spaced["--session"]).toBe("abc-123");

    const equals = parseArgs(["live", "--session=abc-123"]);
    expect(equals["--session"]).toBe("abc-123");

    // the value is not also treated as a positional idea
    expect(spaced._positional).toBeUndefined();
    expect(spaced._positionals).toEqual([]);
  });

  it("documents every flag in both help views", () => {
    for (const flag of ["--continue, -c", "--session <id>", "--list-sessions, -sl"]) {
      expect(usage()).toContain(flag);
      expect(usageCore()).toContain(flag);
    }
  });
});

describe("Phase 4C — resolveResume", () => {
  it("resolves no session at all without a flag (a plain live run starts fresh)", () => {
    seedSessions();
    // sessions exist, and still nothing is adopted: resume must stay explicit
    expect(resolveResume(parseArgs(["live"]), dir)).toBeUndefined();
  });

  it("resolves the latest session for --continue and -c", () => {
    const { newer } = seedSessions();
    expect(resolveResume(parseArgs(["live", "--continue"]), dir)).toEqual({ id: newer.id });
    expect(resolveResume(parseArgs(["live", "-c"]), dir)).toEqual({ id: newer.id });
  });

  it("takes the newest session, not the first written", () => {
    const { older, newer } = seedSessions();
    // the newest write wins the ordering (`listLiveSessions`)
    expect(resolveResume(parseArgs(["-c"]), dir)).toEqual({ id: newer.id });
    expect(resolveResume(parseArgs(["-c"]), dir)!.id).not.toBe(older.id);

    // touching the older session (a new turn) makes it the latest again
    saveLiveSession(dir, { ...older, messages: [{ role: "user", text: "back" }] });
    expect(resolveResume(parseArgs(["-c"]), dir)).toEqual({ id: older.id });
  });

  it("resolves exactly the id given by --session", () => {
    const { older, newer } = seedSessions();
    expect(resolveResume(parseArgs(["--session", older.id]), dir)).toEqual({ id: older.id });
    expect(resolveResume(parseArgs(["--session=" + newer.id]), dir)).toEqual({ id: newer.id });
  });

  it("lets --session win over --continue", () => {
    const { older, newer } = seedSessions();
    expect(resolveResume(parseArgs(["--continue", "--session", older.id]), dir)).toEqual({
      id: older.id,
    });
    // …in either order, and with the short flag too
    expect(resolveResume(parseArgs(["--session", newer.id, "-c"]), dir)).toEqual({ id: newer.id });
  });

  it("passes an unknown handle through, so the engine can warn and start new", () => {
    seedSessions();
    expect(resolveResume(parseArgs(["--session", "not-a-real-session"]), dir)).toEqual({
      id: "not-a-real-session",
    });
  });

  it("sanitizes the handle before it is echoed or matched (SEC-4B-003b)", () => {
    // A CLI handle is attacker-shaped input like any other: it reaches a log line
    // and is matched against the store, so the escapes must never travel with it.
    const { older } = seedSessions();
    const handle = `${older.id}\u001b]0;pwned\u0007`;
    const resolved = resolveResume(parseArgs(["--session", handle]), dir);

    expect(resolved).toEqual({ id: sanitizeTerminalText(handle) });
    expect(resolved!.id.startsWith(older.id)).toBe(true);
    expect(resolved!.id).not.toContain("\u001b");
    expect(resolved!.id).not.toContain("\u0007");
  });

  it("says so, and starts a new session, when --continue has nothing to continue", () => {
    const output = captureSync(() => {
      expect(resolveResume(parseArgs(["-c"]), dir)).toBeUndefined();
    });
    expect(output).toContain("no live session to continue");
    expect(output).toContain(dir);
  });

  it("fails closed on a handle-less --session", () => {
    const errors: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map((part) => String(part)).join(" "));
    });
    try {
      expect(() => resolveResume({ "--session": true, _positionals: [] }, dir)).toThrow("exit");
      expect(stripAnsi(errors.join("\n"))).toContain("--session requires a session id");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("Phase 4C — --list-sessions", () => {
  it("prints the stored sessions (id, updatedAt, runtime, message count, title) and exits 0", async () => {
    const { older, newer } = seedSessions();

    const { output, errors } = await captureMain(["live", "--project", dir, "--list-sessions"]);

    expect(output).toContain(`[huginn] live sessions for ${canonicalize(dir)}`);
    expect(output).toContain("— 2");
    // newest first, both ids
    expect(output.indexOf(newer.id)).toBeLessThan(output.indexOf(older.id));
    expect(output).toContain(older.updatedAt);
    expect(output).toContain(newer.updatedAt);
    // runtime ids and the message counts
    expect(output).toContain("opencode");
    expect(output).toContain("claude");
    expect(output).toContain("  2 msg");
    expect(output).toContain("  1 msg");
    // the title, and a placeholder where there is none
    expect(output).toContain("add notifications");
    expect(output).toContain("(untitled)");
    expect(errors).toBe("");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports the sessions from the live-first route too (no subcommand)", async () => {
    const { newer } = seedSessions();

    const { output } = await captureMain(["--project", dir, "-sl"]);

    expect(output).toContain(`[huginn] live sessions for ${canonicalize(dir)}`);
    expect(output).toContain(newer.id);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("says there is nothing to list, exits 0 and touches nothing", async () => {
    const { output, errors } = await captureMain(["live", "--project", dir, "--list-sessions"]);

    expect(output).toContain(`[huginn] no live sessions for ${canonicalize(dir)}`);
    expect(errors).toBe("");
    expect(process.exitCode ?? 0).toBe(0);
    // read-only: the report is not a run, so it neither writes state nor
    // initializes a git repository (the work-path checks never ran)
    expect(existsSync(join(dir, ".huginn"))).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("still exits 0 on a corrupt store, but says why on stderr", async () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(liveSessionsPath(dir), "{not json at all");

    const { output, errors } = await captureMain(["live", "--project", dir, "--list-sessions"]);

    // "no sessions" and "damaged store" must not look the same
    expect(output).toContain(`no live sessions for ${canonicalize(dir)}`);
    expect(errors).toContain("could not read live sessions");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("never echoes a hostile id/title to the terminal (SEC-4B-003b)", async () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "hostile\u001b]0;pwned\u0007",
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
            runtimeId: "opencode\u001b[31m",
            title: "a\u001b[2Jb",
            messages: [{ role: "user", text: "hi" }],
          },
        ],
      }),
    );

    const { output } = await captureMain(["live", "--project", dir, "--list-sessions"]);

    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    // the sanitized values are what is shown
    expect(output).toContain("hostile]0;pwned");
    expect(output).toContain("ab");
  });

  it("prints the empty report from the helper itself", () => {
    expect(existsSync(liveSessionsPath(dir))).toBe(false);
    const output = captureSync(() => printLiveSessions(dir));
    expect(output).toContain(`[huginn] no live sessions for ${dir}`);
  });

  it("never echoes a hostile project path to the terminal (SEC-4C-002)", () => {
    // The path comes straight from `--project`: the report names it twice (empty
    // and non-empty), and neither line may carry escapes.
    const hostile = `${dir}\u001b]0;pwned\u0007/\u202Ereversed`;
    saveLiveSession(dir, makeSession({ id: "shown" }));

    const empty = captureSync(() => printLiveSessions(hostile));
    const listed = captureSync(() => printLiveSessions(dir));
    const both = `${empty}\n${listed}`;

    expect(both).not.toContain("\u001b");
    expect(both).not.toContain("\u0007");
    expect(both).not.toContain("\u202E");
    // the sanitized path is what both lines show, escapes gone and the rest intact
    expect(empty).toContain(`${dir}]0;pwned/reversed`);
    expect(listed).toContain(dir);

    // …and the *no sessions* line of `resolveResume` is sanitized too
    const noContinue = captureSync(() => {
      expect(resolveResume(parseArgs(["-c"]), hostile)).toBeUndefined();
    });
    expect(noContinue).not.toContain("\u001b");
    expect(noContinue).not.toContain("\u0007");
    expect(noContinue).not.toContain("\u202E");
  });
});
