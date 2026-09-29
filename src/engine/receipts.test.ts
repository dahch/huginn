import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "./diff";
import { treeHash, writeIterationReceipt, type IterationReceipt } from "./receipts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "huginn-receipts-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function commit(message = "fixtures"): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message, "--no-gpg-sign"]);
}

function write(path: string, content = "x\n"): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("treeHash (REV-001/REV-103/REV-104)", () => {
  it("is stable for an untouched tree", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const first = treeHash(dir);
    expect(first).toBeDefined();
    expect(treeHash(dir)).toBe(first);
  });

  it("returns undefined outside a git work tree (fail closed)", () => {
    const outside = mkdtempSync(join(tmpdir(), "huginn-not-a-repo-"));
    try {
      expect(treeHash(outside)).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("changes when a tracked file is edited without committing", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);
    // touch the file so the content hash moves even if mtime/status look similar
    write("src/a.ts", "export const a = 2;\n");
    expect(treeHash(dir)).not.toBe(before);
  });

  it("changes when a new source file is added", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);
    write("src/b.ts", "export const b = 1;\n");
    expect(treeHash(dir)).not.toBe(before);
  });

  it("ignores huginn's own state and ordinary test artifacts", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);

    write(".harness/state.json", "{}\n");
    write(".harness/reports/01-EXECUTE-1.md", "report\n");
    write(".huginn/receipts/iter-1.json", "{}\n");
    write(".huginn/muninn.db", "binary\n");
    write("coverage/lcov.info", "TN:\n");
    write(".vitest/results.json", "{}\n");
    write("node_modules/dep/index.js", "module.exports = 1;\n");
    write("dist/bundle.js", "x\n");
    write("build/out.js", "x\n");

    expect(treeHash(dir)).toBe(before);
  });

  it("ignores the build/test artifacts ordinary tooling writes (REV-103/REV-104)", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);

    // None of these are gitignored in this fixture: they must still be invisible
    // to the signature, or a read-only audit that runs the suite false-positives.
    write("tsconfig.tsbuildinfo", "{}\n");
    write("junit.xml", "<testsuite/>\n");
    write(".eslintcache", "{}\n");
    write(".turbo/cache.json", "{}\n");
    write(".nyc_output/out.json", "{}\n");
    write(".pytest_cache/CACHEDIR.TAG", "x\n");
    write("__pycache__/mod.cpython-311.pyc", "x\n");
    write("target/debug/app", "x\n");

    expect(treeHash(dir)).toBe(before);
  });

  it("ignores a bytecode cache inside a package directory too", () => {
    // `pkg/__pycache__/…` is where Python actually writes: the name is matched at
    // any depth, both on the porcelain line and in the diff hunk that follows it.
    write("src/a.ts", "export const a = 1;\n");
    write("pkg/__pycache__/mod.cpython-311.pyc", "x\n");
    commit();
    const before = treeHash(dir);

    write("pkg/__pycache__/mod.cpython-311.pyc", "x\ny\n");

    expect(treeHash(dir)).toBe(before);
  });

  it("still counts a real file that merely resembles an artifact", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);

    // Not artifacts: different names/suffixes, so the guard must still see them.
    write("reports/junit-report.xml", "<testsuite/>\n");
    write("notes.tsbuildinfo.md", "x\n");
    write("fixtures/.pytest_cache/state.json", "x\n");

    expect(treeHash(dir)).not.toBe(before);
  });

  it("does not ignore a file that merely starts with an ignored name", () => {
    // The old filter matched any prefix, so `.harness-notes.md` (or a diff line
    // mentioning .harness) disappeared from the signature (REV-103).
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);

    write(".huginn-notes.md", "a repository file, not huginn state\n");
    expect(treeHash(dir)).not.toBe(before);
  });

  it("hashes only the root-anchored state directory, not a same-named nested one", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);

    write("fixtures/.harness/state.json", "{}\n");
    expect(treeHash(dir)).not.toBe(before);
  });

  it("keeps a repository diff inside an ignored path out of the signature", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);

    // A tracked, edited file inside an ignored directory: its diff hunk must be
    // filtered out of the hash (not just its status line).
    write("dist/tracked.js", "x\n");
    commit("track dist");
    const afterTrack = treeHash(dir);
    write("dist/tracked.js", "x\ny\n");
    expect(treeHash(dir)).toBe(afterTrack);
    expect(afterTrack).not.toBe(before);
  });

  it("collapses untracked directories so a large drop stays bounded", () => {
    write("src/a.ts", "export const a = 1;\n");
    commit();
    const before = treeHash(dir);
    for (let i = 0; i < 50; i += 1) write(`generated/file-${i}.txt`, "x\n");
    const after = treeHash(dir);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

/**
 * SEC-102 — the receipt path (`.huginn/receipts/iter-<n>.json`) is a name the
 * repository ships, so a clone can plant a symlink there and have huginn
 * overwrite the link's target on every iteration.
 */
describe("writeIterationReceipt — symlink containment (SEC-102)", () => {
  const windows = process.platform === "win32";
  let victim: { root: string; target: string; cleanup: () => void };

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "huginn-receipt-victim-"));
    const target = join(root, "precious.txt");
    writeFileSync(target, "the user's file\n");
    victim = { root, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  });

  afterEach(() => {
    victim.cleanup();
  });

  const receipt: IterationReceipt = {
    profile: "rdd",
    evidence: "snapshot",
    iteration: 1,
    title: "t",
    verdicts: [],
    createdAt: "2025-01-01T00:00:00.000Z",
  };

  it("refuses a symlinked receipt and leaves its target intact", () => {
    if (windows) return;
    mkdirSync(join(dir, ".huginn", "receipts"), { recursive: true });
    symlinkSync(victim.target, join(dir, ".huginn", "receipts", "iter-1.json"));

    expect(writeIterationReceipt(dir, receipt)).toBeUndefined();

    expect(readFileSync(victim.target, "utf8")).toBe("the user's file\n");
  });

  it("refuses a symlinked .huginn directory that escapes the project", () => {
    if (windows) return;
    symlinkSync(victim.root, join(dir, ".huginn"));

    expect(writeIterationReceipt(dir, receipt)).toBeUndefined();

    expect(readdirSync(victim.root)).toEqual(["precious.txt"]);
    expect(readFileSync(victim.target, "utf8")).toBe("the user's file\n");
  });

  it("still writes a real receipt atomically, with no temp left behind", () => {
    const path = writeIterationReceipt(dir, receipt);

    expect(path).toBe(join(dir, ".huginn", "receipts", "iter-1.json"));
    expect(existsSync(path!)).toBe(true);
    expect(JSON.parse(readFileSync(path!, "utf8")).profile).toBe("rdd");
    expect(readdirSync(join(dir, ".huginn", "receipts"))).toEqual(["iter-1.json"]);
  });
});
