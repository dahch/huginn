import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshState, saveState, loadState, renderProgressMarkdown, computePlanHash } from "./store";

describe("harness state store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves and loads state roundtrip", () => {
    const s = freshState({
      planHash: "abc",
      planPath: join(dir, "plan.md"),
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      thinker: "p/x",
      executor: "e/y",
      mode: "auto",
    });
    saveState(dir, s);
    const loaded = loadState(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.planHash).toBe("abc");
    expect(loaded!.models.executor).toBe("e/y");
  });

  it("returns null when no state exists", () => {
    expect(loadState(dir)).toBeNull();
  });

  it("throws on corrupt state", () => {
    mkdirSync(join(dir, ".harness"), { recursive: true });
    writeFileSync(join(dir, ".harness", "state.json"), "{not json");
    expect(() => loadState(dir)).toThrow();
  });

  it("computes a stable hash of files", () => {
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, "one");
    writeFileSync(b, "two");
    const h1 = computePlanHash([a, b]);
    const h2 = computePlanHash([a, b]);
    writeFileSync(b, "changed");
    const h3 = computePlanHash([a, b]);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("hashes by basename so a moved repo keeps the same resume hash", () => {
    const a1 = join(dir, "plan.md");
    const b1 = join(dir, "spec.md");
    writeFileSync(a1, "plan content");
    writeFileSync(b1, "spec content");
    const other = mkdtempSync(join(tmpdir(), "harness-move-"));
    const a2 = join(other, "plan.md");
    const b2 = join(other, "spec.md");
    writeFileSync(a2, "plan content");
    writeFileSync(b2, "spec content");
    expect(computePlanHash([a1, b1])).toBe(computePlanHash([a2, b2]));
    rmSync(other, { recursive: true, force: true });
  });

  it("renders progress markdown with phase entries", () => {
    const s = freshState({
      planHash: "x",
      planPath: join(dir, "plan.md"),
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      thinker: "p/x",
      executor: "e/y",
      mode: "supervised",
    });
    s.history.push({
      iteration: 1,
      phase: "SPEC_AUDIT",
      attempt: 1,
      verdict: "pass",
      model: "e/y",
      sessionId: "s1",
      messageId: "m1",
      summary: "aligned",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const out = renderProgressMarkdown(dir, s);
    expect(existsSync(out)).toBe(true);
    const content = readFileSync(out, "utf8");
    expect(content).toContain("Spec Audit");
    expect(content).toContain("aligned");
    expect(content).toContain("Mode**: supervised");
  });

  it("progress excludes FIX_* entries so it never exceeds the main phase count", () => {
    const s = freshState({
      planHash: "x",
      planPath: join(dir, "plan.md"),
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      thinker: "p/x",
      executor: "e/y",
      mode: "auto",
    });
    const base = { model: "e/y", sessionId: "s", messageId: "m", startedAt: "x", finishedAt: "x" };
    // one main phase passes + one FIX_* entry with a pass verdict
    s.history.push({ ...base, iteration: 1, phase: "SPEC_AUDIT", attempt: 1, verdict: "pass", summary: "ok" });
    s.history.push({ ...base, iteration: 1, phase: "FIX_SPEC", attempt: 1, verdict: "pass", summary: "fix" });
    const content = readFileSync(renderProgressMarkdown(dir, s), "utf8");
    expect(content).toContain("Phase progress: 1/8");
  });
});
