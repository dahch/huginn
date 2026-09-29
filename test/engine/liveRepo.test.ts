/**
 * `liveRepo`'s warn sites are a data boundary (SEC-4B-003): a docs path is user
 * data and git's stderr is repository-controlled output, so neither may put raw
 * terminal escapes on the engine log. Consistent with `liveSession`, which
 * sanitizes the paths and errors it warns about.
 *
 * H-1: the same module is where a *cloned* repository's `spec.md -> ~/.aws/…` was
 * followed, both on read (the target's content went into the architect prompt) and
 * on write (a drafted doc clobbered the target) — covered at the bottom.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOptional, writeDoc } from "../../src/engine/liveRepo";
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

/**
 * H-1 — a `spec.md` that is a symlink to something outside the project must be
 * neither read (into the architect prompt) nor written (clobbering the target).
 */
describe("liveRepo doc containment (H-1)", () => {
  const windows = process.platform === "win32";
  let project: string;
  let outside: string;
  let secret: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "huginn-live-repo-project-"));
    outside = mkdtempSync(join(tmpdir(), "huginn-live-repo-outside-"));
    secret = join(outside, "credentials");
    writeFileSync(secret, "AWS_SECRET_SENTINEL\n");
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("reads a symlinked spec.md as absent and warns instead of leaking the target", () => {
    if (windows) return;
    const spec = join(project, "spec.md");
    symlinkSync(secret, spec);

    const { messages, off } = warnings();
    try {
      expect(readOptional(spec, project)).toBe("");
      expect(messages.some((m) => m.includes("symlink"))).toBe(true);
      expect(messages.join("\n")).not.toContain("AWS_SECRET_SENTINEL");
    } finally {
      off();
    }
  });

  it("refuses to write a doc through a symlink, leaving the target untouched", () => {
    if (windows) return;
    const spec = join(project, "spec.md");
    symlinkSync(secret, spec);

    expect(() => writeDoc(spec, "# Spec: pwned\nREQ-1: x\n", project)).toThrow(/symlink/);
    expect(readFileSync(secret, "utf8")).toBe("AWS_SECRET_SENTINEL\n");
  });

  it("refuses to write a project-relative doc that resolves outside the project", () => {
    if (windows) return;
    mkdirSync(join(outside, "docs"));
    symlinkSync(join(outside, "docs"), join(project, "docs"));

    expect(() => writeDoc(join(project, "docs", "spec.md"), "# escaped\n", project)).toThrow(
      /outside the project root/,
    );
    expect(() => readOptional(join(project, "docs", "spec.md"), project)).not.toThrow();
    expect(readOptional(join(project, "docs", "spec.md"), project)).toBe("");
  });

  it("still reads and writes a regular doc inside the project", () => {
    const spec = join(project, "nested", "spec.md");

    writeDoc(spec, "# Spec: ok\n\nREQ-1: works\n", project);

    expect(readFileSync(spec, "utf8")).toBe("# Spec: ok\n\nREQ-1: works\n");
    expect(readOptional(spec, project)).toBe("# Spec: ok\n\nREQ-1: works\n");
  });

  it("keeps an explicitly configured out-of-project doc readable", () => {
    const shared = join(outside, "shared.md");
    writeFileSync(shared, "# shared\n");

    expect(readOptional(shared, project)).toBe("# shared\n");
  });
});
