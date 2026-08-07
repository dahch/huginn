import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, num } from "./cli";

const base = join(import.meta.dir, "..", "..", ".tmp-canonical-test");
const realDir = join(base, "real");
const linkDir = join(base, "link");

beforeAll(() => {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, "spec.md"), "# spec");
  symlinkSync(realDir, linkDir);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("canonicalize", () => {
  it("follows symlinks to the canonical path", () => {
    const got = canonicalize(join(linkDir, "spec.md"));
    expect(got).toBe(join(realDir, "spec.md"));
  });

  it("canonicalizes a directory symlink", () => {
    expect(canonicalize(linkDir)).toBe(realDir);
  });

  it("leaves a plain path unchanged", () => {
    expect(canonicalize(join(realDir, "spec.md"))).toBe(join(realDir, "spec.md"));
  });

  it("falls back to resolve() when the path does not exist", () => {
    const missing = join(base, "nope", "plan.md");
    expect(canonicalize(missing)).toBe(missing);
  });
});

describe("num", () => {
  it("parses numeric strings", () => {
    expect(num("3", 1)).toBe(3);
    expect(num("0", 1)).toBe(0);
  });

  it("uses the fallback for non-numeric input", () => {
    expect(num("abc", 3)).toBe(3);
    expect(num(undefined, 3)).toBe(3);
    expect(num(true, 3)).toBe(3);
  });

  it("clamps negative values so phases are never skipped", () => {
    expect(num("-1", 3)).toBe(0);
    expect(num("-5", 3)).toBe(0);
  });
});
