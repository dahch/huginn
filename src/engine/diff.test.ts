import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git, hasImplementationCode } from "./diff";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-diff-"));
  git(dir, ["init", "-q"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("hasImplementationCode", () => {
  it("returns false when only markdown docs exist", () => {
    for (const f of ["SPEC.md", "ADR.md", "PLAN.md", "README.md"]) {
      writeFileSync(join(dir, f), "# doc\n");
    }
    expect(hasImplementationCode(dir)).toBe(false);
  });

  it("returns false for a scaffolded repo with config but no source", () => {
    writeFileSync(join(dir, "SPEC.md"), "# spec\n");
    writeFileSync(join(dir, "package.json"), "{}\n");
    writeFileSync(join(dir, "tsconfig.json"), "{}\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    mkdirSync(join(dir, "src"));
    expect(hasImplementationCode(dir)).toBe(false);
  });

  it("returns false for only hidden files and ignored dirs", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    mkdirSync(join(dir, ".harness"));
    writeFileSync(join(dir, ".harness/state.json"), "{}");
    expect(hasImplementationCode(dir)).toBe(false);
  });

  it("returns true when a source file exists in a source dir", () => {
    writeFileSync(join(dir, "SPEC.md"), "# doc\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/index.ts"), "export const a = 1;\n");
    expect(hasImplementationCode(dir)).toBe(true);
  });

  it("returns true for a root-level source file", () => {
    writeFileSync(join(dir, "app.py"), "print('hi')\n");
    expect(hasImplementationCode(dir)).toBe(true);
  });

  it("does not treat non-source files (html/json/markdown variants) as implementation", () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/index.html"), "<p>hi</p>\n");
    writeFileSync(join(dir, "notes.mdx"), "# notes\n");
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data/config.json"), "{}");
    expect(hasImplementationCode(dir)).toBe(false);
  });
});
