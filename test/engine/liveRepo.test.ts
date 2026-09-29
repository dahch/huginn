/**
 * `liveRepo`'s warn sites are a data boundary (SEC-4B-003): a docs path is user
 * data and git's stderr is repository-controlled output, so neither may put raw
 * terminal escapes on the engine log. Consistent with `liveSession`, which
 * sanitizes the paths and errors it warns about.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOptional } from "../../src/engine/liveRepo";
import { events } from "../../src/engine/engineEvents";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-live-repo-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function warnings(): { messages: string[]; off: () => void } {
  const messages: string[] = [];
  const off = events.on("log", (entry) => {
    if (entry.level === "warn") messages.push(entry.message);
  });
  return { messages, off };
}

describe("liveRepo warnings (SEC-4B-003)", () => {
  it("reads a missing file as empty, without a warning", () => {
    const { messages, off } = warnings();
    try {
      expect(readOptional(join(dir, "spec.md"))).toBe("");
      expect(messages).toEqual([]);
    } finally {
      off();
    }
  });

  it("sanitizes the path in an unreadable-file warning", () => {
    if (process.platform === "win32") return; // ESC is not a legal filename character there
    // A directory where a file is expected: the read throws, and the warning
    // quotes the (escape-carrying) path back.
    const evil = join(dir, "spec\u001b[31m\u0007.md");
    mkdirSync(evil);

    const { messages, off } = warnings();
    try {
      expect(readOptional(evil)).toBe("");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("could not read");
      expect(messages[0]).toContain("spec.md");
      expect(messages[0]).not.toContain("\u001b");
      expect(messages[0]).not.toContain("\u0007");
    } finally {
      off();
    }
  });
});
