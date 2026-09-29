/**
 * SEC-102/SEC-105 — the shared atomic file writer.
 *
 * Promoted out of `state/liveSession.ts` (SEC-901 pattern) because every store
 * huginn keeps has the same two requirements, and each one was open to the same
 * attack: a cloned repository can ship a *link* where huginn is about to write
 * (`.harness/state.json`, `.harness/reports/*.md`, `.huginn/receipts/iter-N.json`,
 * the update cache), and a plain `writeFileSync` both follows that link and
 * truncates the target.
 *
 * - **Atomic**: the body is written to an *exclusive* temp file in the same
 *   directory (`'wx'` + a random suffix) and then `renameSync`d over the target,
 *   so a crash mid-write can never leave a half-written file behind.
 * - **Never follows a link**: `'wx'` refuses a pre-existing entry at the temp
 *   name (so a link planted there is never written through), and `rename`
 *   replaces the *destination name*, never the target of a link.
 *
 * Containment of the destination itself (is the path allowed at all?) stays the
 * caller's job: paths are screened with `assertDocPath`/`checkDocPath` first, and
 * the caller passes the resolved path this writer should land on.
 */
import { chmodSync, closeSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Writes `body` to `path` atomically with an exclusive temp file: created in the
 * same directory with a random suffix and the `wx` flag, so a symlink planted at
 * that name is never followed; `renameSync` then replaces the target name rather
 * than following a link at the destination. The temp is `chmod`ed to `mode` on a
 * best-effort basis (some filesystems/platforms reject explicit modes).
 *
 * Throws when no temp file could be created or the write failed; the caller
 * decides whether that is fatal. A failed write leaves no temp behind.
 */
export function writeFileAtomic(path: string, body: string, mode: number): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number;
    try {
      fd = openSync(tmp, "wx", mode);
    } catch (err) {
      if (errorCode(err) === "EEXIST") {
        lastErr = err;
        continue;
      }
      throw err;
    }
    try {
      writeSync(fd, body, null, "utf8");
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
    closeSync(fd);
    try {
      chmodSync(tmp, mode);
    } catch {
      // best-effort: some filesystems/platforms reject explicit modes
    }
    renameSync(tmp, path);
    return;
  }
  throw new Error(`could not create a unique temp file for ${path}: ${String(lastErr)}`);
}
