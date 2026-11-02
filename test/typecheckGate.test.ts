import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Contract guard for the strict typecheck of the *test* tree (iter-4).
 *
 * `bun run typecheck` must keep compiling exactly what it compiled before
 * (`src` only) — it is the pipeline gate. The wider `typecheck:test` is a
 * separate, developer-facing gate that must cover `src` + `test` under the same
 * strict options, and it must be wired into `test`/`prepublishOnly` so a type
 * error in a test can never reach a release.
 */

const root = process.cwd();
const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as Record<string, unknown>;

interface TsConfig {
  extends?: string;
  include?: string[];
  compilerOptions?: Record<string, unknown>;
}

const baseConfig = readJson("tsconfig.json") as TsConfig;
const testConfig = readJson("tsconfig.test.json") as TsConfig;
const pkg = readJson("package.json") as {
  scripts?: Record<string, string>;
};

describe("tsconfig.test.json", () => {
  it("extends the base tsconfig so it inherits strict and the compiler options", () => {
    expect(testConfig.extends).toBe("./tsconfig.json");
  });

  it("includes both the source tree and the test tree", () => {
    expect(testConfig.include).toEqual(["src", "test"]);
  });

  it("does not relax strict mode through a compilerOptions override", () => {
    expect(testConfig.compilerOptions?.strict).not.toBe(false);
    expect(testConfig.compilerOptions?.skipLibCheck).not.toBe(true);
  });
});

describe("typecheck scripts", () => {
  it("exposes typecheck:test running the strict test project without emit", () => {
    expect(pkg.scripts?.["typecheck:test"]).toBe("tsc -p tsconfig.test.json --noEmit");
  });

  it("keeps the pipeline gate compiling src only", () => {
    expect(pkg.scripts?.typecheck).toBe("tsc --noEmit");
    expect(baseConfig.include).toEqual(["src"]);
    expect(baseConfig.compilerOptions?.strict).toBe(true);
  });

  it("runs typecheck:test as part of the test script", () => {
    expect(pkg.scripts?.test).toContain("typecheck:test");
  });

  it("runs typecheck:test before publishing", () => {
    expect(pkg.scripts?.prepublishOnly).toContain("typecheck:test");
  });
});

describe("no blanket type suppression in the test tree", () => {
  const collectTestFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTestFiles(full);
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
    });
  };

  it("never disables the typechecker for a whole test file", () => {
    const offenders = collectTestFiles(path.join(root, "test")).filter((file) =>
      /^\s*\/\/\s*@ts-nocheck\b/m.test(fs.readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
