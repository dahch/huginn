import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_LIVE_MESSAGE_CHARS,
  MAX_LIVE_MESSAGES,
  MAX_LIVE_SESSIONS,
  MAX_LIVE_STORE_BYTES,
  getLiveSession,
  latestLiveSession,
  listLiveSessions,
  liveDir,
  liveSessionsPath,
  loadLiveSessions,
  newLiveSessionId,
  saveLiveSession,
  type LiveSession,
} from "../../src/state/liveSession";
import { events } from "../../src/engine/engineEvents";
import { sanitizeTerminalText } from "../../src/util/text";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-live-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Collects the `warn` lines the store emits on the engine log channel. */
function warnings(): { messages: string[]; off: () => void } {
  const messages: string[] = [];
  const off = events.on("log", (entry) => {
    if (entry.level === "warn") messages.push(entry.message);
  });
  return { messages, off };
}

function makeSession(overrides: Partial<LiveSession> = {}): LiveSession {
  const now = new Date().toISOString();
  return {
    id: newLiveSessionId(),
    createdAt: now,
    updatedAt: now,
    runtimeId: "opencode",
    projectPath: dir,
    messages: [],
    ...overrides,
  };
}

describe("live session store", () => {
  it("round-trips a session through disk", () => {
    const session = makeSession({
      title: "add notifications",
      idea: "notify users",
      opencodeSessionId: "ses_abc",
      messages: [
        { role: "user", text: "add notifications" },
        { role: "assistant", text: "sure — which channel?" },
      ],
    });

    saveLiveSession(dir, session);
    const [loaded] = loadLiveSessions(dir);

    expect(loaded.id).toBe(session.id);
    expect(loaded.runtimeId).toBe("opencode");
    expect(loaded.projectPath).toBe(dir);
    expect(loaded.title).toBe("add notifications");
    expect(loaded.idea).toBe("notify users");
    expect(loaded.opencodeSessionId).toBe("ses_abc");
    expect(loaded.createdAt).toBe(session.createdAt);
    expect(loaded.messages).toEqual([
      { role: "user", text: "add notifications" },
      { role: "assistant", text: "sure — which channel?" },
    ]);
  });

  it("writes the versioned envelope with the session inside", () => {
    const session = makeSession();
    saveLiveSession(dir, session);
    const raw = JSON.parse(readFileSync(liveSessionsPath(dir), "utf8"));
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.sessions)).toBe(true);
    expect(raw.sessions).toHaveLength(1);
    expect(raw.sessions[0].id).toBe(session.id);
  });

  it("upserts by id instead of appending a duplicate", () => {
    const session = makeSession({ messages: [{ role: "user", text: "one" }] });
    saveLiveSession(dir, session);
    saveLiveSession(dir, {
      ...session,
      messages: [...session.messages, { role: "assistant", text: "two" }],
    });

    const sessions = loadLiveSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].messages).toHaveLength(2);
  });

  it("creates the live dir 0o700 and the file 0o600", () => {
    saveLiveSession(dir, makeSession());
    // POSIX modes: macOS/Linux honour them (a Windows run has no bit to assert)
    if (process.platform === "win32") return;
    expect(statSync(liveDir(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(liveSessionsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("tightens the store file to 0o600 but never chmods a directory it did not create", () => {
    // SEC-4B-001: the live dir was created outside huginn (possibly a mount or a
    // shared path); only the file huginn writes is tightened, because chmodding a
    // directory huginn did not create is exactly what the symlink attack abuses.
    if (process.platform === "win32") return;
    mkdirSync(liveDir(dir), { recursive: true, mode: 0o755 });
    chmodSync(liveDir(dir), 0o755);
    writeFileSync(liveSessionsPath(dir), JSON.stringify({ version: 1, sessions: [] }), { mode: 0o644 });
    chmodSync(liveSessionsPath(dir), 0o644);

    saveLiveSession(dir, makeSession());

    expect(statSync(liveDir(dir)).mode & 0o777).toBe(0o755);
    expect(statSync(liveSessionsPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("is atomic: no temp file is left behind", () => {
    saveLiveSession(dir, makeSession());
    const stray = readdirSync(liveDir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(stray).toEqual([]);
  });

  it("latestLiveSession returns the most recently updated session", () => {
    const first = makeSession({ id: "s1", updatedAt: "2020-01-01T00:00:00.000Z" });
    const second = makeSession({ id: "s2", updatedAt: "2024-01-01T00:00:00.000Z" });
    saveLiveSession(dir, first);
    saveLiveSession(dir, second);
    expect(latestLiveSession(dir)?.id).toBe("s2");
    expect(listLiveSessions(dir).map((s) => s.id)).toEqual(["s2", "s1"]);

    // touching the older session (a new turn) makes it the latest again
    saveLiveSession(dir, { ...first, messages: [{ role: "user", text: "back" }] });
    expect(latestLiveSession(dir)?.id).toBe("s1");
    expect(listLiveSessions(dir).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("orders two sessions saved within the same millisecond by write order", () => {
    // A hand-written file is the only way to pin two identical timestamps: it
    // asserts the documented tie-break (later write wins) without relying on
    // clock granularity or fake timers.
    mkdirSync(liveDir(dir), { recursive: true });
    const stamp = "2025-01-01T00:00:00.000Z";
    const record = (id: string) => ({
      id,
      createdAt: stamp,
      updatedAt: stamp,
      runtimeId: "opencode",
      projectPath: dir,
      messages: [],
    });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({ version: 1, sessions: [record("older"), record("newer")] }),
    );

    expect(latestLiveSession(dir)?.id).toBe("newer");
    expect(listLiveSessions(dir).map((s) => s.id)).toEqual(["newer", "older"]);
  });

  it("caps the messages kept per session, dropping the oldest", () => {
    const messages = Array.from({ length: MAX_LIVE_MESSAGES + 50 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn ${i}`,
    }));
    saveLiveSession(dir, makeSession({ messages }));

    const stored = latestLiveSession(dir)!;
    expect(stored.messages).toHaveLength(MAX_LIVE_MESSAGES);
    expect(stored.messages[stored.messages.length - 1].text).toBe(`turn ${MAX_LIVE_MESSAGES + 49}`);
    expect(stored.messages[0].text).toBe(`turn ${messages.length - MAX_LIVE_MESSAGES}`);
  });

  it("caps the number of sessions kept, dropping the oldest", () => {
    const total = MAX_LIVE_SESSIONS + 5;
    for (let i = 0; i < total; i++) {
      saveLiveSession(dir, makeSession({ id: `s${i}` }));
    }

    const sessions = loadLiveSessions(dir);
    expect(sessions).toHaveLength(MAX_LIVE_SESSIONS);
    // the five oldest are gone; the rest is kept in write order
    expect(sessions.map((s) => s.id)).toEqual(
      Array.from({ length: MAX_LIVE_SESSIONS }, (_, i) => `s${i + 5}`),
    );
    expect(latestLiveSession(dir)?.id).toBe(`s${total - 1}`);
  });

  it("never evicts the session it is saving, even against future-dated records", () => {
    // A clock-skewed (or hand-edited) file: every stored session claims to be
    // newer than anything written now. The save must still land on disk.
    const future = Array.from({ length: MAX_LIVE_SESSIONS }, (_, i) => ({
      id: `future-${i}`,
      createdAt: "2099-01-01T00:00:00.000Z",
      updatedAt: `2099-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      runtimeId: "opencode",
      projectPath: dir,
      messages: [],
    }));
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(liveSessionsPath(dir), JSON.stringify({ version: 1, sessions: future }));

    saveLiveSession(dir, makeSession({ id: "fresh", messages: [{ role: "user", text: "hi" }] }));

    const sessions = loadLiveSessions(dir);
    expect(sessions).toHaveLength(MAX_LIVE_SESSIONS);
    expect(sessions.map((s) => s.id)).toContain("fresh");
    expect(getLiveSession(dir, "fresh")!.messages).toEqual([{ role: "user", text: "hi" }]);
  });

  it("does not cap the caller's own session object (a copy is persisted)", () => {
    const messages = Array.from({ length: MAX_LIVE_MESSAGES + 3 }, (_, i) => ({
      role: "user" as const,
      text: `t${i}`,
    }));
    const session = makeSession({ messages });
    saveLiveSession(dir, session);
    expect(session.messages).toHaveLength(MAX_LIVE_MESSAGES + 3);
  });

  it("returns [] for a project that has no store yet, without warning", () => {
    const warnings: string[] = [];
    const off = events.on("log", (entry) => {
      if (entry.level === "warn") warnings.push(entry.message);
    });
    try {
      expect(loadLiveSessions(dir)).toEqual([]);
      expect(listLiveSessions(dir)).toEqual([]);
      expect(latestLiveSession(dir)).toBeUndefined();
      expect(getLiveSession(dir, "nope")).toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      off();
    }
  });

  it("fails open on a corrupt file (no throw) and warns on the engine log", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(liveSessionsPath(dir), "{not json at all");

    const warnings: string[] = [];
    const off = events.on("log", (entry) => {
      if (entry.level === "warn") warnings.push(entry.message);
    });
    try {
      expect(() => loadLiveSessions(dir)).not.toThrow();
      expect(loadLiveSessions(dir)).toEqual([]);
      expect(latestLiveSession(dir)).toBeUndefined();
      expect(warnings.some((m) => m.includes("could not read live sessions"))).toBe(true);
    } finally {
      off();
    }
  });

  it("fails open when the JSON has no sessions array", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(liveSessionsPath(dir), JSON.stringify({ version: 1, nope: [] }));

    const warnings: string[] = [];
    const off = events.on("log", (entry) => {
      if (entry.level === "warn") warnings.push(entry.message);
    });
    try {
      expect(loadLiveSessions(dir)).toEqual([]);
      expect(warnings.some((m) => m.includes('no "sessions" array'))).toBe(true);
    } finally {
      off();
    }
  });

  it("keeps the intact records and drops malformed ones with a warning", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    const good = makeSession({ id: "good", messages: [{ role: "user", text: "hi" }] });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [good, { runtimeId: "opencode" }, { id: "partial", messages: "not an array" }],
      }),
    );

    const warnings: string[] = [];
    const off = events.on("log", (entry) => {
      if (entry.level === "warn") warnings.push(entry.message);
    });
    try {
      const sessions = loadLiveSessions(dir);
      expect(sessions.map((s) => s.id)).toEqual(["good", "partial"]);
      // a partial record still yields a usable session, with safe defaults
      expect(sessions[1].messages).toEqual([]);
      expect(sessions[1].runtimeId).toBe("unknown");
      expect(warnings.some((m) => m.includes("1 malformed live session record"))).toBe(true);
    } finally {
      off();
    }
  });

  it("drops messages whose shape is wrong instead of failing the session", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "s",
            messages: [
              { role: "user", text: "kept" },
              { role: "wizard", text: "dropped role" },
              { role: "assistant" },
              "not an object",
              { role: "assistant", text: "kept too" },
            ],
          },
        ],
      }),
    );
    const [session] = loadLiveSessions(dir);
    expect(session.messages).toEqual([
      { role: "user", text: "kept" },
      { role: "assistant", text: "kept too" },
    ]);
  });

  it("getLiveSession finds by id and does not confuse sessions", () => {
    saveLiveSession(dir, makeSession({ id: "a", title: "A" }));
    saveLiveSession(dir, makeSession({ id: "b", title: "B" }));
    expect(getLiveSession(dir, "b")?.title).toBe("B");
    expect(getLiveSession(dir, "missing")).toBeUndefined();
  });

  it("a corrupt file does not stop the next save from recovering the store", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(liveSessionsPath(dir), "{broken");
    saveLiveSession(dir, makeSession({ id: "fresh", messages: [{ role: "user", text: "hello" }] }));
    const sessions = loadLiveSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("fresh");
  });

  it("newLiveSessionId mints distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newLiveSessionId()));
    expect(ids.size).toBe(50);
  });

  it("keeps a per-project store (two projects do not see each other)", () => {
    const other = mkdtempSync(join(tmpdir(), "huginn-live-other-"));
    try {
      saveLiveSession(dir, makeSession({ id: "mine" }));
      saveLiveSession(other, makeSession({ id: "theirs" }));
      expect(loadLiveSessions(dir).map((s) => s.id)).toEqual(["mine"]);
      expect(loadLiveSessions(other).map((s) => s.id)).toEqual(["theirs"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("never writes inside .harness (live state must survive the handoff)", () => {
    saveLiveSession(dir, makeSession());
    expect(existsSync(join(dir, ".harness"))).toBe(false);
    expect(existsSync(liveSessionsPath(dir))).toBe(true);
  });
});

describe("live session store — symlink containment (SEC-4B-001)", () => {
  /** A directory tree outside the project, standing in for anything precious. */
  function victim(): { root: string; secrets: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "huginn-live-victim-"));
    const secrets = join(root, "secrets");
    mkdirSync(secrets, { mode: 0o755 });
    chmodSync(secrets, 0o755);
    writeFileSync(join(secrets, "private.txt"), "the user's private file\n", { mode: 0o644 });
    return { root, secrets, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  /** Nothing may appear in, or be chmodded inside, the foreign directory. */
  function expectUntouched(secrets: string): void {
    if (process.platform === "win32") return;
    expect(existsSync(join(secrets, "sessions.json"))).toBe(false);
    expect(existsSync(join(secrets, "live"))).toBe(false);
    expect(statSync(secrets).mode & 0o777).toBe(0o755);
    expect(statSync(join(secrets, "private.txt")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(secrets, "private.txt"), "utf8")).toBe("the user's private file\n");
  }

  it("refuses to write through a symlinked .huginn and leaves the target alone", () => {
    if (process.platform === "win32") return; // symlinks need privileges on Windows
    const v = victim();
    const { messages, off } = warnings();
    try {
      symlinkSync(v.secrets, join(dir, ".huginn"));

      expect(() => saveLiveSession(dir, makeSession())).toThrow(/symlink/);

      expectUntouched(v.secrets);
      expect(messages.some((m) => m.includes("refusing to persist live sessions"))).toBe(true);
    } finally {
      off();
      v.cleanup();
    }
  });

  it("refuses to write through a symlinked .huginn/live and does not chmod the target", () => {
    if (process.platform === "win32") return;
    const v = victim();
    const { messages, off } = warnings();
    try {
      mkdirSync(join(dir, ".huginn"), { mode: 0o700 });
      symlinkSync(v.secrets, liveDir(dir));

      expect(() => saveLiveSession(dir, makeSession())).toThrow(/symlink/);

      expectUntouched(v.secrets);
      // the *only* thing huginn created here is .huginn itself, and a warning said so
      expect(messages.some((m) => m.includes("refusing to persist live sessions"))).toBe(true);
    } finally {
      off();
      v.cleanup();
    }
  });

  it("keeps working normally once the link is replaced by a real directory", () => {
    if (process.platform === "win32") return;
    const v = victim();
    try {
      symlinkSync(v.secrets, join(dir, ".huginn"));
      expect(() => saveLiveSession(dir, makeSession())).toThrow();

      // unlink the link itself, then let the next save create the real directory
      unlinkSync(join(dir, ".huginn"));
      saveLiveSession(dir, makeSession({ id: "after-cleanup", messages: [{ role: "user", text: "hi" }] }));

      expect(existsSync(liveSessionsPath(dir))).toBe(true);
      expect(existsSync(join(dir, ".huginn", ".gitignore"))).toBe(true);
      expectUntouched(v.secrets);
    } finally {
      v.cleanup();
    }
  });

  it("refuses a .huginn symlink even when it points back inside the project", () => {
    // Containment alone would accept this one: the link resolves to the project
    // root itself. The lstat check is what refuses it, so no `.huginn/live` is
    // ever created through a link.
    if (process.platform === "win32") return;
    symlinkSync(dir, join(dir, ".huginn"));

    expect(() => saveLiveSession(dir, makeSession())).toThrow(/symlink/);

    expect(existsSync(join(dir, "live"))).toBe(false);
    expect(existsSync(liveSessionsPath(dir))).toBe(false);
  });
});

describe("live session store — hardened reads (SEC-4B-002)", () => {
  it("ignores a symlinked store instead of following it", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "huginn-live-read-"));
    const { messages, off } = warnings();
    try {
      const outside = join(root, "sessions.json");
      writeFileSync(outside, JSON.stringify({ version: 1, sessions: [{ id: "outside", messages: [] }] }));
      mkdirSync(liveDir(dir), { recursive: true });
      symlinkSync(outside, liveSessionsPath(dir));

      expect(loadLiveSessions(dir)).toEqual([]);
      expect(messages.some((m) => m.includes("refusing to follow a symlink"))).toBe(true);
    } finally {
      off();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a FIFO where the store should be, without blocking on it", () => {
    if (process.platform === "win32") return;
    mkdirSync(liveDir(dir), { recursive: true });
    try {
      execFileSync("mkfifo", [liveSessionsPath(dir)]);
    } catch {
      return; // no mkfifo in this environment: nothing to assert
    }
    const { messages, off } = warnings();
    try {
      expect(loadLiveSessions(dir)).toEqual([]);
      expect(messages.some((m) => m.includes("not a regular file"))).toBe(true);
    } finally {
      off();
    }
  });

  it("ignores a directory where the store should be", () => {
    mkdirSync(liveSessionsPath(dir), { recursive: true });
    const { messages, off } = warnings();
    try {
      expect(loadLiveSessions(dir)).toEqual([]);
      expect(messages.some((m) => m.includes("not a regular file"))).toBe(true);
    } finally {
      off();
    }
  });

  it("refuses an oversized store instead of parsing it (no 8 MB read)", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    const path = liveSessionsPath(dir);
    writeFileSync(path, "{}");
    // Sparse file: bigger than the cap on disk without writing 8 MB of bytes.
    truncateSync(path, MAX_LIVE_STORE_BYTES + 1);
    const { messages, off } = warnings();
    try {
      expect(loadLiveSessions(dir)).toEqual([]);
      expect(statSync(path).size).toBe(MAX_LIVE_STORE_BYTES + 1);
      expect(messages.some((m) => m.includes("exceeds the") && m.includes("-byte cap"))).toBe(true);
    } finally {
      off();
    }
  });

  it("still reads a store that stays under the cap", () => {
    saveLiveSession(dir, makeSession({ id: "just-fine" }));
    expect(loadLiveSessions(dir).map((s) => s.id)).toEqual(["just-fine"]);
    expect(statSync(liveSessionsPath(dir)).size).toBeLessThan(MAX_LIVE_STORE_BYTES);
  });
});

describe("live session store — write-side byte cap (SEC-4B-004b)", () => {
  /**
   * Half the cap plus a margin: two of these together are over the cap, one is
   * not. `idea` is the cheap way to build a big *session* — it is not capped in
   * characters the way a message is.
   */
  const HALF_STORE = MAX_LIVE_STORE_BYTES / 2 + 1_000;

  it("shrinks an oversized store by dropping the oldest sessions, and keeps reading it", () => {
    const { messages: logs, off } = warnings();
    try {
      saveLiveSession(dir, makeSession({ id: "oldest", idea: "x".repeat(HALF_STORE) }));
      saveLiveSession(dir, makeSession({ id: "newer", idea: "x".repeat(HALF_STORE) }));

      // the store was over the cap as assembled: the oldest session went, loudly
      expect(statSync(liveSessionsPath(dir)).size).toBeLessThanOrEqual(MAX_LIVE_STORE_BYTES);
      expect(logs.some((m) => m.includes("dropping 1 oldest session") && m.includes("-byte cap"))).toBe(true);
      expect(logs.some((m) => m.includes("exceeds the"))).toBe(false);

      // the point of the fix: the surviving session is still readable, instead of
      // the whole file being refused (which is what used to wipe the store)
      expect(loadLiveSessions(dir).map((s) => s.id)).toEqual(["newer"]);

      // and the next save lands *next to* it rather than dropping it
      saveLiveSession(dir, makeSession({ id: "fresh", messages: [{ role: "user", text: "hi" }] }));
      expect(listLiveSessions(dir).map((s) => s.id)).toEqual(["fresh", "newer"]);
      expect(getLiveSession(dir, "newer")!.idea).toHaveLength(HALF_STORE);
      expect(getLiveSession(dir, "fresh")!.messages).toEqual([{ role: "user", text: "hi" }]);
      expect(statSync(liveSessionsPath(dir)).size).toBeLessThanOrEqual(MAX_LIVE_STORE_BYTES);
    } finally {
      off();
    }
  });

  it("trims the oldest messages when one session alone is over the cap in bytes", () => {
    // A message is capped in *characters*: 20 000 three-byte characters are
    // ~60 KB, so MAX_LIVE_MESSAGES of them are ~12 MB — over the byte cap while
    // every per-message and per-session cap is respected.
    const body = "→".repeat(MAX_LIVE_MESSAGE_CHARS - 4);
    const messages = Array.from({ length: MAX_LIVE_MESSAGES }, (_, i) => ({
      role: "user" as const,
      text: `${body}${String(i).padStart(4, "0")}`,
    }));
    const { messages: logs, off } = warnings();
    try {
      const stored = saveLiveSession(dir, makeSession({ id: "huge", messages }));

      expect(statSync(liveSessionsPath(dir)).size).toBeLessThanOrEqual(MAX_LIVE_STORE_BYTES);
      expect(stored.messages.length).toBeGreaterThan(0);
      expect(stored.messages.length).toBeLessThan(MAX_LIVE_MESSAGES);
      // the newest turns are the ones kept, and the trim is announced
      expect(stored.messages[stored.messages.length - 1].text.endsWith("0199")).toBe(true);
      expect(logs.some((m) => m.includes("oldest message(s)") && m.includes("-byte store cap"))).toBe(true);

      // the returned record is exactly what landed on disk, and it is readable
      const reread = getLiveSession(dir, "huge")!;
      expect(reread.messages).toEqual(stored.messages);
    } finally {
      off();
    }
  });

  it("refuses to write a store its own reader would reject (never a silent deletion)", () => {
    // Only a record whose *metadata* alone is over the cap can reach this: every
    // message is already bounded, and dropping them all is not enough. Writing it
    // would hand the reader a file it refuses, i.e. lose every other session on
    // the following save — so nothing is written and the caller is told.
    const { off } = warnings();
    try {
      expect(() =>
        saveLiveSession(dir, makeSession({ id: "giant", idea: "x".repeat(MAX_LIVE_STORE_BYTES + 1) })),
      ).toThrow(/refusing to write a store that could not be read back/);
      expect(existsSync(liveSessionsPath(dir))).toBe(false);
    } finally {
      off();
    }
  });

  it("leaves a store that fits untouched", () => {
    saveLiveSession(dir, makeSession({ id: "small", messages: [{ role: "user", text: "hi" }] }));
    const before = readFileSync(liveSessionsPath(dir), "utf8");
    saveLiveSession(dir, makeSession({ id: "also-small" }));
    const after = JSON.parse(readFileSync(liveSessionsPath(dir), "utf8"));
    expect(before).toContain('"small"');
    expect(after.sessions.map((s: { id: string }) => s.id)).toEqual(["small", "also-small"]);
  });
});

describe("live session store — data-boundary hygiene (SEC-4B-003/004)", () => {
  it("sanitizes title, idea and message text on write", () => {
    saveLiveSession(
      dir,
      makeSession({
        title: "evil\u001b[31m\u202Etitle",
        idea: "idea\u0007with bell",
        messages: [{ role: "user", text: "run \u001b[2Jclear" }],
      }),
    );

    // the raw file must not carry the escapes either, only the sanitized text
    const raw = readFileSync(liveSessionsPath(dir), "utf8");
    expect(raw).not.toContain("\u001b");
    expect(raw).not.toContain("\u202E");
    expect(raw).not.toContain("\u0007");

    const [stored] = loadLiveSessions(dir);
    expect(stored.title).toBe(sanitizeTerminalText("evil\u001b[31m\u202Etitle"));
    expect(stored.idea).toBe(sanitizeTerminalText("idea\u0007with bell"));
    expect(stored.messages[0].text).toBe(sanitizeTerminalText("run \u001b[2Jclear"));
    expect(stored.title).toBe("eviltitle");
  });

  it("sanitizes a hand-edited or attacker-authored store on read", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "hostile",
            title: "a\u001b[31mb",
            idea: "x\u202Ey",
            messages: [{ role: "user", text: "t\u001b[2Jz" }],
          },
        ],
      }),
    );

    const [stored] = loadLiveSessions(dir);
    expect(stored.title).toBe("ab");
    expect(stored.idea).toBe("xy");
    expect(stored.messages[0].text).toBe("tz");
  });

  it("sanitizes the identity fields read from a hand-edited store (SEC-4B-003b)", () => {
    // The id travels into logs and future listings (and an opencode id is sent back
    // to the server on a reattach), and the runtime name and path are rendered next
    // to it: none of them may carry control sequences. M-3 tightens the id itself to
    // a plain `[A-Za-z0-9._:-]` token, so one that sanitizes to anything else is not
    // "cleaned up" — the whole record is discarded (it identifies nothing), and no
    // raw escape reaches the log either way.
    const hostileId = "hijack\u001b]0;pwned\u0007";
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [
          // the hostile id is discarded, so its other fields are never handed out
          {
            id: hostileId,
            createdAt: "2025\u001b[31m-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z\u0007",
            runtimeId: "opencode\u001b[31m",
            projectPath: "/tmp/\u202Ehidden",
            opencodeSessionId: "ses\u001b]0;pwned\u0007",
            messages: [{ role: "user", text: "hi" }],
          },
          // an id left empty by sanitization identifies nothing: the record goes too
          { id: "\u001b[2J", messages: [] },
          // a plain opaque id is kept, and its other identity fields are sanitized
          {
            id: "kept-session_1",
            createdAt: "2025\u001b[31m-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z\u0007",
            runtimeId: "opencode\u001b[31m",
            projectPath: "/tmp/\u202Ehidden",
            opencodeSessionId: "ses\u001b]0;pwned\u0007",
            messages: [{ role: "user", text: "hi" }],
          },
        ],
      }),
    );

    const { messages: logs, off } = warnings();
    try {
      const sessions = loadLiveSessions(dir);
      // only the record whose id is a plain token survives
      expect(sessions.map((s) => s.id)).toEqual(["kept-session_1"]);
      const [stored] = sessions;
      expect(stored.runtimeId).toBe("opencode");
      expect(stored.projectPath).toBe("/tmp/hidden");
      expect(stored.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(stored.updatedAt).toBe("2025-01-01T00:00:00.000Z");
      // a server-side id is kept only when it sanitizes to a plain token — this one
      // sanitizes to `ses]0;pwned`, so it is dropped rather than sent to the server
      expect(stored.opencodeSessionId).toBeUndefined();
      for (const field of [
        stored.id,
        stored.runtimeId,
        stored.projectPath,
        stored.createdAt,
        stored.updatedAt,
        stored.opencodeSessionId ?? "",
      ]) {
        expect(field).not.toContain("\u001b");
        expect(field).not.toContain("\u0007");
        expect(field).not.toContain("\u202E");
      }
      // the dropped records are reported, not swallowed
      expect(logs.some((m) => m.includes("2 malformed live session record"))).toBe(true);
    } finally {
      off();
    }
  });

  it("drops a server-side id that sanitization empties (SEC-4C-001)", () => {
    // An id made only of control characters names nothing: it is omitted rather
    // than kept as "", so the 4C reattach never probes an empty handle.
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [{ id: "s", opencodeSessionId: "\u001b[2J\u0007", messages: [] }],
      }),
    );

    const [stored] = loadLiveSessions(dir);
    expect(stored.opencodeSessionId).toBeUndefined();
  });

  it("sanitizes the warnings it emits (a path can carry escapes)", () => {
    const evil = mkdtempSync(join(tmpdir(), "huginn\u001b[31m-live-"));
    const { messages, off } = warnings();
    try {
      mkdirSync(join(evil, ".huginn", "live"), { recursive: true });
      writeFileSync(liveSessionsPath(evil), "{not json");

      expect(loadLiveSessions(evil)).toEqual([]);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.includes("could not read live sessions"))).toBe(true);
      for (const message of messages) expect(message).not.toContain("\u001b");
    } finally {
      off();
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it("caps a single message at MAX_LIVE_MESSAGE_CHARS with a marker", () => {
    saveLiveSession(
      dir,
      makeSession({
        id: "long",
        messages: [{ role: "assistant", text: "x".repeat(MAX_LIVE_MESSAGE_CHARS + 5_000) }],
      }),
    );

    const stored = getLiveSession(dir, "long")!;
    expect(stored.messages[0].text).toHaveLength(MAX_LIVE_MESSAGE_CHARS);
    expect(stored.messages[0].text.endsWith("…[truncated]")).toBe(true);

    // a message exactly at the cap is stored untouched
    const exact = "y".repeat(MAX_LIVE_MESSAGE_CHARS);
    saveLiveSession(dir, makeSession({ id: "exact", messages: [{ role: "user", text: exact }] }));
    expect(getLiveSession(dir, "exact")!.messages[0].text).toBe(exact);
  });

  it("caps an oversized message that arrives from the file as well", () => {
    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({
        version: 1,
        sessions: [{ id: "s", messages: [{ role: "user", text: "z".repeat(MAX_LIVE_MESSAGE_CHARS + 10) }] }],
      }),
    );

    const [stored] = loadLiveSessions(dir);
    expect(stored.messages[0].text.length).toBe(MAX_LIVE_MESSAGE_CHARS);
    expect(stored.messages[0].text.endsWith("…[truncated]")).toBe(true);
  });
});

describe("live session store — git hygiene and stage (REV-4B-003/002)", () => {
  it("writes a self-contained .huginn/.gitignore so the state never dirties the repo", () => {
    saveLiveSession(dir, makeSession());
    expect(readFileSync(join(dir, ".huginn", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("never overwrites an existing .huginn/.gitignore", () => {
    mkdirSync(join(dir, ".huginn"), { recursive: true });
    writeFileSync(join(dir, ".huginn", ".gitignore"), "!.keep\n");

    saveLiveSession(dir, makeSession());

    expect(readFileSync(join(dir, ".huginn", ".gitignore"), "utf8")).toBe("!.keep\n");
  });

  it("requires the file to be creatable, not the existing content replaceable", () => {
    // A symlink at .huginn/.gitignore must be neither followed nor clobbered.
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "huginn-live-gitignore-"));
    try {
      const outside = join(root, "keep.txt");
      writeFileSync(outside, "keep me\n");
      mkdirSync(join(dir, ".huginn"), { recursive: true });
      symlinkSync(outside, join(dir, ".huginn", ".gitignore"));

      saveLiveSession(dir, makeSession());

      expect(readFileSync(outside, "utf8")).toBe("keep me\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips the stage and drops an unknown one (REV-4B-002)", () => {
    saveLiveSession(dir, makeSession({ id: "at-approve", stage: "approve" }));
    expect(getLiveSession(dir, "at-approve")!.stage).toBe("approve");

    mkdirSync(liveDir(dir), { recursive: true });
    writeFileSync(
      liveSessionsPath(dir),
      JSON.stringify({ version: 1, sessions: [{ id: "weird", stage: "teleport" }] }),
    );
    expect(getLiveSession(dir, "weird")!.stage).toBeUndefined();
  });

  it("warns when it drops the oldest sessions (REV-4B-004)", () => {
    const { messages, off } = warnings();
    try {
      for (let i = 0; i < MAX_LIVE_SESSIONS + 1; i++) {
        saveLiveSession(dir, makeSession({ id: `s${i}` }));
      }

      expect(loadLiveSessions(dir)).toHaveLength(MAX_LIVE_SESSIONS);
      expect(messages.some((m) => m.includes("dropping 1 oldest session"))).toBe(true);
    } finally {
      off();
    }
  });

  it("warns when it drops old messages (REV-4B-004)", () => {
    const messages = Array.from({ length: MAX_LIVE_MESSAGES + 3 }, (_, i) => ({
      role: "user" as const,
      text: `t${i}`,
    }));
    const { messages: logs, off } = warnings();
    try {
      saveLiveSession(dir, makeSession({ messages }));

      expect(logs.some((m) => m.includes("dropping 3 old message(s)"))).toBe(true);
    } finally {
      off();
    }
  });
});
