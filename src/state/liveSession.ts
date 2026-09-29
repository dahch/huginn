/**
 * Phase 4B — persisted **live** sessions.
 *
 * `LiveEngine.messages` lives in memory, so closing Huginn mid-refinement lost
 * the whole conversation. The live session is therefore written to
 * `<project>/.huginn/live/sessions.json` — deliberately *outside* `.harness`,
 * which `LiveEngine.execute()` wipes through `resetHarnessState()` on handoff.
 * Keeping live state under `.huginn/` also means it never dirties the working
 * tree (`<project>/.huginn/.gitignore` is written `*`), so the git-derived
 * prompt context and the `commitDocs` diff stay clean.
 *
 * Guarantees:
 * - **Atomic** writes: an exclusive temp file in the same directory is written
 *   with mode `0o600` and then `renameSync`d into place, so a crash mid-write
 *   can never leave a half-written `sessions.json`.
 * - **Contained** (SEC-4B-001): every path component is checked with
 *   `lstatSync` and a symlink is always refused; `realpathSync(liveDir)` must
 *   stay inside `realpathSync(projectPath)`, and the directory is re-opened
 *   `O_DIRECTORY|O_NOFOLLOW` before anything is written. A link planted at
 *   `.huginn/` or `.huginn/live` can therefore never make huginn write — or
 *   `chmod` — outside the project.
 * - **Hardened modes**: the `live/` directory is created `0o700` — but only the
 *   levels this process actually created are `chmod`ed, never a pre-existing (or
 *   linked) directory — and the file is `0o600`: a transcript can carry
 *   sensitive content (paths, pasted secrets).
 * - **Bounded**: at most {@link MAX_LIVE_MESSAGES} messages per session and
 *   {@link MAX_LIVE_SESSIONS} sessions per project (oldest dropped first, with a
 *   warning), {@link MAX_LIVE_MESSAGE_CHARS} characters per message (truncated
 *   with a marker) and {@link MAX_LIVE_STORE_BYTES} on the whole file, so the
 *   store cannot grow without limit as sessions pile up. The byte cap is enforced
 *   on the **write** path too (SEC-4B-004b), not only on read: the per-message and
 *   per-session caps alone allow a store several times over the cap, and a file
 *   the reader refuses would make the next save drop every session it can no
 *   longer see.
 * - **Sanitized** (SEC-4B-003, SEC-4C-001): title, idea, every message text
 *   **and** every identity field (`id`, `runtimeId`, `projectPath`, `createdAt`,
 *   `updatedAt`, `opencodeSessionId`) run through `sanitizeTerminalText` both on
 *   the way in and on the way out, so the store is never the weak link that lets
 *   a control sequence reach a terminal or a log (the runtime session id is also
 *   sent back to the opencode server by the 4C reattach probe); warnings are
 *   sanitized too.
 * - **Fail open on read**: a missing, unreadable, oversized or malformed file
 *   never throws — it yields `[]` / `undefined` and a warning on the engine log
 *   channel, so a corrupted file is visible instead of silently swallowed.
 * - **Residual, deliberately not addressed here**: two processes writing the same
 *   store are serialized only by the per-write atomic `renameSync` (last writer
 *   wins; there is no cross-process lock — SEC-4B-005), and containment is checked
 *   on the directory *name* rather than held open as an `O_DIRECTORY` fd across
 *   the write, so a link swapped in during the write is refused by the checks that
 *   follow it, not impossible to begin with (fd-based containment).
 */
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, sep } from "node:path";
import { events, type LiveStage } from "../engine/engineEvents";
import { sanitizeTerminalText } from "../util/text";
import { writeFileAtomic } from "../util/atomicWrite";

/** One persisted turn of a live conversation. */
export interface LiveSessionMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * One persisted live session: the refinement conversation plus the metadata
 * needed to describe and (Phase 4C) resume it.
 */
export interface LiveSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Active agent runtime when the session was last persisted (e.g. `opencode`). */
  runtimeId: string;
  projectPath: string;
  /** Optional human label (e.g. the first user line) for `--list-sessions`. */
  title?: string;
  /** The idea the session was opened with, when there was one. */
  idea?: string;
  /**
   * Where the conversation got to (REV-4B-002), so a resumed session announces
   * the right step instead of always claiming to be refining again.
   */
  stage?: LiveStage;
  /**
   * The runtime's own session id (opencode), kept so a resumed run can reattach
   * to the same server-side conversation (Phase 4C). Only meaningful for a
   * runtime whose session survives between prompts — it is dropped when the
   * runtime does not (REV-4B-001).
   */
  opencodeSessionId?: string;
  messages: LiveSessionMessage[];
}

/** On-disk envelope of `<project>/.huginn/live/sessions.json`. */
export interface LiveSessionsFile {
  version: number;
  sessions: LiveSession[];
}

export const LIVE_SESSIONS_VERSION = 1;

/** Newest messages kept per session (older turns are dropped on write). */
export const MAX_LIVE_MESSAGES = 200;

/**
 * Sessions kept per project, newest first — the oldest are discarded so a
 * long-lived project's transcript file stays bounded.
 */
export const MAX_LIVE_SESSIONS = 20;

/**
 * Characters kept per message (SEC-4B-004): a single pasted blob must not be
 * able to fill the store, and the total file cap ({@link MAX_LIVE_STORE_BYTES})
 * is the backstop. Truncation is announced with {@link MESSAGE_TRUNCATED_MARKER}.
 */
export const MAX_LIVE_MESSAGE_CHARS = 20_000;

/**
 * Bytes accepted for the whole store (SEC-4B-002). A larger file is reported and
 * ignored rather than parsed, so a hostile/huge `sessions.json` cannot exhaust
 * memory during a read.
 */
export const MAX_LIVE_STORE_BYTES = 8 * 1024 * 1024;

/** Appended to a message cut at {@link MAX_LIVE_MESSAGE_CHARS} — never silent. */
const MESSAGE_TRUNCATED_MARKER = "…[truncated]";

/** `.huginn/.gitignore` body: ignore the whole state directory, wherever it is. */
const HUGINN_GITIGNORE = "*\n";

const ROLES = new Set<LiveSessionMessage["role"]>(["user", "assistant", "system"]);
const STAGES = new Set<LiveStage>(["refine", "draft", "approve", "execute"]);

/**
 * M-3 — the charset a persisted **identity** may use.
 *
 * `sanitizeTerminalText` keeps the *store* from printing control sequences, but an
 * id is not only printed: it is a key (`getLiveSession`), a value the 4C reattach
 * probe sends back to the opencode server, and the handle `--session <id>` accepts.
 * A hand-edited (or attacker-authored) store could therefore carry an id full of
 * separators, spaces or `..`, so every recorded id must be a plain opaque token: at
 * most 128 characters of `[A-Za-z0-9._:-]`, with **at least one alphanumeric** so
 * that `.`, `..`, `-` or `:` alone — names that mean "a path component" or
 * "nothing" to a later consumer — never pass.
 *
 * A real id (a `randomUUID()` from {@link newLiveSessionId}, an opencode `ses_…`)
 * always satisfies this; anything that does not is discarded (never repaired).
 */
export const LIVE_ID_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._:-]{1,128}$/;

/** `O_NOFOLLOW`/`O_DIRECTORY`/`O_NONBLOCK` are absent on some platforms (Windows). */
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
const DIRECTORY_ONLY = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
const NON_BLOCKING = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;

/** `<project>/.huginn/live` — where live session state lives (never `.harness`). */
export function liveDir(projectPath: string): string {
  return join(projectPath, ".huginn", "live");
}

/** `<project>/.huginn/live/sessions.json` — the persisted session store. */
export function liveSessionsPath(projectPath: string): string {
  return join(liveDir(projectPath), "sessions.json");
}

/** A fresh, opaque live session id. */
export function newLiveSessionId(): string {
  return randomUUID();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Warns on the engine log channel — sanitized, because a path can carry escapes. */
function warn(message: string): void {
  events.emit("log", { level: "warn", message: sanitizeTerminalText(message) });
}

/** Caps one message at {@link MAX_LIVE_MESSAGE_CHARS}, marking the cut. */
function capMessageText(text: string): string {
  if (text.length <= MAX_LIVE_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_LIVE_MESSAGE_CHARS - MESSAGE_TRUNCATED_MARKER.length) + MESSAGE_TRUNCATED_MARKER;
}

/** SEC-4B-003/004: one message as it may be stored — sanitized and bounded. */
function sanitizeMessage(message: LiveSessionMessage): LiveSessionMessage {
  return { role: message.role, text: capMessageText(sanitizeTerminalText(message.text)) };
}

/** One stored message, sanitized and bounded — `undefined` when its shape is unusable. */
function normalizeMessage(raw: unknown): LiveSessionMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { role, text } = raw as { role?: unknown; text?: unknown };
  if (typeof role !== "string" || !ROLES.has(role as LiveSessionMessage["role"])) return undefined;
  if (typeof text !== "string") return undefined;
  return sanitizeMessage({ role: role as LiveSessionMessage["role"], text });
}

/**
 * Best-effort parse of one stored session record. Returns `undefined` only for a
 * record that cannot be used at all (no usable id); missing optional fields are
 * defaulted so a partially damaged file still yields the sessions that are intact.
 * Every field that survives is sanitized before it is handed out — including the
 * timestamps and the runtime session id (SEC-4C-001), which the 4C reattach path
 * sends back to the opencode server and names in a log line.
 *
 * M-3: identity fields must additionally match {@link LIVE_ID_PATTERN}. An `id`
 * that does not is not "cleaned up" — the record is dropped, exactly like the
 * empty-id case (an id that is not a plain opaque token identifies nothing huginn
 * should look up or address). A malformed `opencodeSessionId` drops **that field**
 * rather than the whole conversation: the record is still the user's transcript,
 * and without the field the 4C reattach simply opens a new agent session (the
 * fail-open path it already has), instead of probing a server with a value a
 * hand-edited store chose.
 */
function normalizeSession(raw: unknown): LiveSession | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  // SEC-4B-003b: the identity fields are a data boundary like the text ones — a
  // hand-edited (or attacker-authored) record must not smuggle OSC/CSI sequences
  // through the id, the runtime name or the project path into a log line or a
  // listing. An id left empty by sanitization identifies nothing: the record is
  // dropped as malformed rather than kept under an invisible name.
  const id = typeof s.id === "string" ? sanitizeTerminalText(s.id) : "";
  if (!LIVE_ID_PATTERN.test(id)) return undefined;
  const now = new Date().toISOString();
  const rawMessages = Array.isArray(s.messages) ? s.messages : [];
  const messages = rawMessages
    .map(normalizeMessage)
    .filter((m): m is LiveSessionMessage => m !== undefined)
    .slice(-MAX_LIVE_MESSAGES);

  const session: LiveSession = {
    id,
    createdAt: typeof s.createdAt === "string" ? sanitizeTerminalText(s.createdAt) : now,
    updatedAt: typeof s.updatedAt === "string" ? sanitizeTerminalText(s.updatedAt) : now,
    runtimeId: typeof s.runtimeId === "string" ? sanitizeTerminalText(s.runtimeId) : "unknown",
    projectPath: typeof s.projectPath === "string" ? sanitizeTerminalText(s.projectPath) : "",
    messages,
  };
  // SEC-4B-003: the store is a data boundary like any other — hand-edited or
  // attacker-authored content must not reach a terminal unfiltered.
  if (typeof s.title === "string") session.title = sanitizeTerminalText(s.title);
  if (typeof s.idea === "string") session.idea = sanitizeTerminalText(s.idea);
  if (typeof s.stage === "string" && STAGES.has(s.stage as LiveStage)) session.stage = s.stage as LiveStage;
  // SEC-4C-001: this one is a boundary too — it is sent back to the opencode
  // server by the 4C reattach probe and echoed into a log line, so it is
  // sanitized here like every other identity field. An id left empty by
  // sanitization names nothing: it is dropped rather than kept as "" (M-3: the
  // same applies to one that is not a plain opaque token at all).
  if (typeof s.opencodeSessionId === "string") {
    const opencodeSessionId = sanitizeTerminalText(s.opencodeSessionId);
    if (LIVE_ID_PATTERN.test(opencodeSessionId)) {
      session.opencodeSessionId = opencodeSessionId;
    } else {
      warn(
        `ignoring the malformed opencode session id stored for live session ${id}; ` +
          `a resumed run will start a new agent session`,
      );
    }
  }
  return session;
}

/**
 * Newest-first ranking. Ties on `updatedAt` (two writes inside the same
 * millisecond) are broken by file position, where later means more recent, so
 * "latest" is deterministic instead of clock-dependent.
 */
function byRecency(sessions: LiveSession[]): LiveSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const delta = b.session.updatedAt.localeCompare(a.session.updatedAt);
      return delta !== 0 ? delta : b.index - a.index;
    })
    .map(({ session }) => session);
}

/**
 * Reads every stored session, in file order (oldest write first). Never throws:
 * a missing file returns `[]` silently (a project that never ran live), while a
 * symlinked, non-regular, oversized or corrupt one returns `[]` **and** logs a
 * warning.
 *
 * SEC-4B-002: the path is `lstat`ed (a symlink is refused, a FIFO/device is
 * refused) and then read through an `O_NOFOLLOW|O_NONBLOCK` descriptor whose
 * `fstat` re-checks the size, so the read neither follows a link swapped in
 * after the check, nor blocks on a FIFO, nor allocates an unbounded buffer.
 */
export function loadLiveSessions(projectPath: string): LiveSession[] {
  const path = liveSessionsPath(projectPath);

  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (err) {
    // A project that never ran live has no store: nothing to report.
    if (errorCode(err) === "ENOENT") return [];
    warn(`could not stat live sessions at ${path}: ${errorMessage(err)}; ignoring them`);
    return [];
  }
  if (stat.isSymbolicLink()) {
    warn(`ignoring live sessions at ${path}: refusing to follow a symlink`);
    return [];
  }
  if (!stat.isFile()) {
    warn(`ignoring live sessions at ${path}: not a regular file`);
    return [];
  }
  if (stat.size > MAX_LIVE_STORE_BYTES) {
    warn(
      `ignoring live sessions at ${path}: ${stat.size} bytes exceeds the ${MAX_LIVE_STORE_BYTES}-byte cap`,
    );
    return [];
  }

  let raw: string;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCKING);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return [];
    warn(`could not read live sessions at ${path}: ${errorMessage(err)}; ignoring them`);
    return [];
  }
  try {
    const open = fstatSync(fd);
    if (!open.isFile()) {
      warn(`ignoring live sessions at ${path}: not a regular file`);
      return [];
    }
    if (open.size > MAX_LIVE_STORE_BYTES) {
      warn(
        `ignoring live sessions at ${path}: ${open.size} bytes exceeds the ${MAX_LIVE_STORE_BYTES}-byte cap`,
      );
      return [];
    }
    // Read at most the size we just validated, so a file that grows under us
    // cannot turn into an unbounded allocation.
    const size = Math.min(open.size, MAX_LIVE_STORE_BYTES);
    const buf = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buf, offset, size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    raw = buf.subarray(0, offset).toString("utf8");
  } catch (err) {
    warn(`could not read live sessions at ${path}: ${errorMessage(err)}; ignoring them`);
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      // fd already closed; nothing to recover
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`could not read live sessions at ${path}: ${errorMessage(err)}; ignoring them`);
    return [];
  }

  const rawSessions = (parsed as { sessions?: unknown } | null | undefined)?.sessions;
  if (!Array.isArray(rawSessions)) {
    warn(`malformed live sessions at ${path}: no "sessions" array; ignoring them`);
    return [];
  }

  const sessions = rawSessions
    .map(normalizeSession)
    .filter((s): s is LiveSession => s !== undefined);
  const dropped = rawSessions.length - sessions.length;
  if (dropped > 0) {
    warn(`ignored ${dropped} malformed live session record(s) in ${path}`);
  }
  return sessions;
}

/** Sessions ranked newest-first — the order `--list-sessions` prints them in. */
export function listLiveSessions(projectPath: string): LiveSession[] {
  return byRecency(loadLiveSessions(projectPath));
}

/** The most recently updated stored session, or `undefined` when there is none. */
export function latestLiveSession(projectPath: string): LiveSession | undefined {
  return listLiveSessions(projectPath)[0];
}

/** One stored session by id, or `undefined` when it is unknown/corrupt. */
export function getLiveSession(projectPath: string, id: string): LiveSession | undefined {
  return loadLiveSessions(projectPath).find((s) => s.id === id);
}

/** `mkdir` exactly one level: `true` when this call created it, `false` on EEXIST. */
function mkdirOneLevel(path: string): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  }
}

/**
 * Asserts `path` is a real directory: never a symlink (a planted link is what
 * SEC-4B-001 is about), never a file/FIFO/device.
 */
function assertRealDirectory(path: string, label: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (err) {
    throw new Error(`cannot use ${label} at ${path}: ${errorMessage(err)}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} at ${path} is a symlink; refusing to write live sessions through it`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} at ${path} is not a directory`);
  }
}

/**
 * Asserts the live directory is really inside the project (SEC-4B-001): both
 * sides are `realpath`ed, so a link anywhere in the chain — or a project path
 * that is itself a link — is resolved before the prefix comparison. The exact
 * expected suffix is checked on top of the prefix test, so a sibling like
 * `.huginn/live-evil` can never pass.
 */
function assertContained(projectPath: string, dir: string): void {
  let realProject: string;
  let realDir: string;
  try {
    realProject = realpathSync(projectPath);
    realDir = realpathSync(dir);
  } catch (err) {
    throw new Error(`cannot resolve the live directory ${dir}: ${errorMessage(err)}`);
  }
  const root = realProject.endsWith(sep) ? realProject : `${realProject}${sep}`;
  if (realDir !== join(realProject, ".huginn", "live") || !realDir.startsWith(root)) {
    throw new Error(
      `the live directory ${dir} resolves to ${realDir}, outside the project root ${realProject}`,
    );
  }
}

/**
 * Re-opens the directory with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` and closes it:
 * if the name was swapped for a symlink between the `lstat` and here, this fails
 * instead of following the link (the TOCTOU window SEC-4B-001 cares about).
 */
function assertOpenableDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
  } catch (err) {
    throw new Error(`cannot open the live directory ${dir} safely: ${errorMessage(err)}`);
  }
  try {
    if (!fstatSync(fd).isDirectory()) {
      throw new Error(`the live directory ${dir} is not a directory`);
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // fd already closed; nothing to recover
    }
  }
}

/** Tightens a mode we just created; some filesystems/platforms reject explicit modes. */
function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort: the mkdir mode already applied, minus umask
  }
}

/**
 * REV-4B-003: `<project>/.huginn/.gitignore` holding `*`, written with `O_EXCL`
 * so an existing file (or a symlink to one) is never overwritten or followed.
 * Self-contained on purpose — it works even when the project's own `.gitignore`
 * says nothing about `.huginn`, so huginn's state never shows up in
 * `git status`/`repoContext`. Best-effort: a read-only `.huginn` must not break
 * the live turn, it just means the directory may be reported as untracked.
 */
function ensureHuginnGitignore(huginnDir: string): void {
  const path = join(huginnDir, ".gitignore");
  try {
    writeFileSync(path, HUGINN_GITIGNORE, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (errorCode(err) === "EEXIST") return; // keep whatever is already there
    warn(`could not write ${path}: ${errorMessage(err)}; .huginn may show up in git status`);
  }
}

/**
 * SEC-4B-001: prepares `<project>/.huginn/live` for a write and returns it, or
 * throws so the caller degrades (the live engine turns that into a warning).
 *
 * Each level is created individually — never `recursive: true`, which follows a
 * symlinked parent — and only the levels created *by this call* get their mode
 * tightened, so a pre-existing (possibly linked) directory is never `chmod`ed by
 * huginn.
 */
function ensureLiveDir(projectPath: string): string {
  const huginnDir = join(projectPath, ".huginn");
  const dir = liveDir(projectPath);

  const createdHuginn = mkdirOneLevel(huginnDir);
  assertRealDirectory(huginnDir, `.huginn in ${projectPath}`);
  const createdLive = mkdirOneLevel(dir);
  assertRealDirectory(dir, "the live directory");
  assertContained(projectPath, dir);
  assertOpenableDirectory(dir);

  if (createdHuginn) chmodBestEffort(huginnDir, 0o700);
  if (createdLive) chmodBestEffort(dir, 0o700);
  ensureHuginnGitignore(huginnDir);
  return dir;
}

/** The envelope exactly as it is written to disk (and therefore measured). */
function serializeStore(sessions: LiveSession[]): string {
  return `${JSON.stringify({ version: LIVE_SESSIONS_VERSION, sessions } satisfies LiveSessionsFile, null, 2)}\n`;
}

/** How much {@link fitStoreToCap} had to drop to make a store writable. */
interface StoreFit {
  sessions: LiveSession[];
  /** Whole sessions dropped (oldest first) to get under the byte cap. */
  droppedSessions: number;
  /** Oldest messages trimmed from the record being saved, for the same reason. */
  droppedMessages: number;
}

/**
 * SEC-4B-004b: shrinks `sessions` until the serialized envelope fits
 * {@link MAX_LIVE_STORE_BYTES} — the very limit {@link loadLiveSessions} enforces
 * on read.
 *
 * Enforcing the cap only on read is a data-loss bug, not a hardening gap: the
 * per-message and per-session caps alone allow a store of roughly 80 MB, so a
 * saturated store *is* refused by the reader, and the next save — which reads the
 * store first to keep the other sessions — would silently write back just the
 * session in flight and lose every other conversation. Nothing is ever written
 * that the reader would refuse.
 *
 * The record being saved is the last element: it is never dropped, only (in the
 * extreme case where one session alone is over the cap in *bytes* — a message can
 * be capped in characters and still be 4 bytes each) trimmed of its oldest
 * messages, so the conversation in flight always survives. Dropping is announced
 * by the caller, from the counts returned here.
 */
function fitStoreToCap(sessions: LiveSession[]): StoreFit {
  const size = (candidate: LiveSession[]): number => Buffer.byteLength(serializeStore(candidate), "utf8");

  let kept = sessions;
  let droppedSessions = 0;
  // The candidate shrinks on every iteration, so this stops at the first fit —
  // one serialization per dropped session, plus the final one.
  while (kept.length > 1 && size(kept) > MAX_LIVE_STORE_BYTES) {
    kept = kept.slice(1);
    droppedSessions++;
  }
  if (size(kept) <= MAX_LIVE_STORE_BYTES) return { sessions: kept, droppedSessions, droppedMessages: 0 };

  // Down to a single session and still over the cap: its own messages are the
  // only thing left to drop. Fewer messages always serialize smaller, so the
  // largest tail that fits is bisected, not walked one message at a time.
  const saved = kept[0];
  const withoutMessages: LiveSession[] = [{ ...saved, messages: [] }];
  if (size(withoutMessages) > MAX_LIVE_STORE_BYTES) {
    // Not the messages, then: a single record whose own metadata is over the cap
    // cannot be written without the reader rejecting it, so write nothing and say
    // so (a write failure propagates — the caller warns).
    throw new Error(
      `live session ${saved.id} does not fit the ${MAX_LIVE_STORE_BYTES}-byte store cap even without its ` +
        `${saved.messages.length} message(s); refusing to write a store that could not be read back`,
    );
  }
  const withTail = (count: number): LiveSession[] => [{ ...saved, messages: saved.messages.slice(-count) }];
  let fits = 0;
  let over = saved.messages.length;
  while (over - fits > 1) {
    const middle = fits + Math.floor((over - fits) / 2);
    if (size(withTail(middle)) > MAX_LIVE_STORE_BYTES) over = middle;
    else fits = middle;
  }
  return {
    sessions: withTail(fits),
    droppedSessions,
    droppedMessages: saved.messages.length - fits,
  };
}

/**
 * Persists `session`, upserting it by id: the newest messages (each sanitized and
 * capped at {@link MAX_LIVE_MESSAGE_CHARS}, and the transcript at
 * {@link MAX_LIVE_MESSAGES}) and a refreshed `updatedAt` are written, and only
 * the {@link MAX_LIVE_SESSIONS} most recent sessions are kept — the oldest are
 * discarded, with a warning (REV-4B-004) so a dropped conversation is never
 * silent. Returns the stored record (with the refreshed timestamp and the capped
 * transcript) so callers can observe what was actually written; the caller's
 * object is not mutated.
 *
 * SEC-4B-004b: the serialized body is measured before it is written and shrunk
 * until it fits {@link MAX_LIVE_STORE_BYTES} (see {@link fitStoreToCap}), warning
 * about what it drops, so a save can never produce a file that
 * {@link loadLiveSessions} would refuse to read — which would have lost every
 * other session on the following save.
 *
 * Unlike reads, a write failure propagates — the caller decides whether a failed
 * persistence is fatal (the live engine degrades to a warning). A symlinked or
 * escaping store is one of those failures: the store warns and throws **without
 * writing** (SEC-4B-001).
 */
export function saveLiveSession(projectPath: string, session: LiveSession): LiveSession {
  const cappedMessages = session.messages.slice(-MAX_LIVE_MESSAGES);
  const droppedMessages = session.messages.length - cappedMessages.length;
  if (droppedMessages > 0) {
    warn(
      `live session ${session.id}: dropping ${droppedMessages} old message(s) (cap ${MAX_LIVE_MESSAGES})`,
    );
  }

  const stored: LiveSession = {
    ...session,
    updatedAt: new Date().toISOString(),
    // Re-cap after the timestamp so a caller's oversized array cannot slip
    // through; copies keep the in-memory session from aliasing the file.
    messages: cappedMessages.map(sanitizeMessage),
  };
  if (session.title !== undefined) stored.title = sanitizeTerminalText(session.title);
  if (session.idea !== undefined) stored.idea = sanitizeTerminalText(session.idea);

  const others = byRecency(loadLiveSessions(projectPath).filter((s) => s.id !== session.id));
  // Keep the newest MAX-1 *other* sessions (oldest first, i.e. write order, so
  // file position keeps breaking recency ties) and append the record being
  // written last: the session just saved can never be the one evicted, whatever
  // the stored timestamps say.
  const droppedSessions = Math.max(0, others.length - (MAX_LIVE_SESSIONS - 1));
  if (droppedSessions > 0) {
    warn(
      `live session store in ${projectPath}: dropping ${droppedSessions} oldest session(s) (cap ${MAX_LIVE_SESSIONS})`,
    );
  }
  const kept = [...others.slice(0, MAX_LIVE_SESSIONS - 1).reverse(), stored];

  try {
    ensureLiveDir(projectPath);
  } catch (err) {
    warn(`refusing to persist live sessions for ${projectPath}: ${errorMessage(err)}`);
    throw err;
  }

  // SEC-4B-004b: the byte cap is measured on the body that is about to be
  // `renameSync`d into place, not just enforced by the reader — a store over the
  // cap must be shrunk *here*, while the other sessions are still in hand,
  // instead of being written and then silently discarded on the next read.
  const fit = fitStoreToCap(kept);
  if (fit.droppedSessions > 0) {
    warn(
      `live session store in ${projectPath}: dropping ${fit.droppedSessions} oldest session(s) to stay under the ${MAX_LIVE_STORE_BYTES}-byte cap`,
    );
  }
  if (fit.droppedMessages > 0) {
    warn(
      `live session ${stored.id}: dropping ${fit.droppedMessages} oldest message(s) to stay under the ${MAX_LIVE_STORE_BYTES}-byte store cap`,
    );
  }
  writeFileAtomic(liveSessionsPath(projectPath), serializeStore(fit.sessions), 0o600);
  // The record as it actually landed on disk (the fitting above may have trimmed
  // it), so callers can observe what was written.
  return fit.sessions[fit.sessions.length - 1];
}
