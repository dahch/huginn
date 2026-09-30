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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshState,
  saveState,
  loadState,
  renderProgressMarkdown,
  writeReport,
  computePlanHash,
} from "./store";
import type { HarnessState } from "./schema";

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

  it("reports a promotion failure as itself, naming the preserved branch (AC-49.3)", () => {
    const s = freshState({
      planHash: "x",
      planPath: join(dir, "plan.md"),
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      thinker: "p/x",
      executor: "e/y",
      mode: "auto",
    });
    s.finishedAt = new Date().toISOString();
    s.promotion = {
      status: "conflict",
      branch: "huginn/task-iter-1",
      backups: ["/tmp/x/.huginn/promotion-backup/stamp"],
    };
    const content = readFileSync(renderProgressMarkdown(dir, s), "utf8");
    expect(content).toContain("PROMOTION FAILED");
    expect(content).toContain("huginn/task-iter-1");
    expect(content).toContain("promotion-backup");
    // A strand is not an abort: `ABORTED` stays reserved for the user stopping.
    expect(content).not.toContain("ABORTED");
  });

  it("still reports a genuine abort as ABORTED", () => {
    const s = freshState({
      planHash: "x",
      planPath: join(dir, "plan.md"),
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      thinker: "p/x",
      executor: "e/y",
      mode: "auto",
    });
    s.finishedAt = new Date().toISOString();
    s.aborted = true;
    const content = readFileSync(renderProgressMarkdown(dir, s), "utf8");
    expect(content).toContain("ABORTED");
    expect(content).not.toContain("PROMOTION FAILED");
  });

  it("renders a failed promotion that parked nothing without a backup note", () => {
    const s = freshState({
      planHash: "x",
      planPath: join(dir, "plan.md"),
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      thinker: "p/x",
      executor: "e/y",
      mode: "auto",
    });
    s.promotion = { status: "failed", branch: "huginn/task-iter-2", detail: "refused" };
    const content = readFileSync(renderProgressMarkdown(dir, s), "utf8");
    expect(content).toContain("PROMOTION FAILED");
    expect(content).toContain("huginn/task-iter-2");
    expect(content).not.toContain("backed up under");
  });

  it("round-trips the promotion record through save/load (AC-49.3)", () => {
    const s = freshState({
      planHash: "x",
      planPath: join(dir, "plan.md"),
      specPath: join(dir, "spec.md"),
      adrPath: join(dir, "adr.md"),
      thinker: "p/x",
      executor: "e/y",
      mode: "auto",
    });
    s.promotion = {
      status: "failed",
      branch: "huginn/task-iter-2",
      detail: "could not park untracked file(s)",
    };
    saveState(dir, s);
    const loaded = loadState(dir);
    expect(loaded?.promotion).toEqual({
      status: "failed",
      branch: "huginn/task-iter-2",
      detail: "could not park untracked file(s)",
    });
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

  /**
   * SEC-102 — everything huginn writes under `.harness/` is a *repository-reachable*
   * name, so a cloned project can ship it as a symlink and have huginn overwrite the
   * link's target. The writes now screen the path and go through an exclusive temp
   * file, exactly like the live-session store.
   */
  describe("symlink containment (SEC-102)", () => {
    const windows = process.platform === "win32";
    let victim: { root: string; target: string; cleanup: () => void };

    beforeEach(() => {
      const root = mkdtempSync(join(tmpdir(), "harness-victim-"));
      const target = join(root, "precious.txt");
      writeFileSync(target, "the user's file\n");
      victim = { root, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    });

    afterEach(() => {
      victim.cleanup();
    });

    function makeState(): HarnessState {
      return freshState({
        planHash: "x",
        planPath: join(dir, "plan.md"),
        specPath: join(dir, "spec.md"),
        adrPath: join(dir, "adr.md"),
        thinker: "p/x",
        executor: "e/y",
        mode: "auto",
      });
    }

    it("refuses a symlinked state.json instead of truncating its target", () => {
      if (windows) return;
      mkdirSync(join(dir, ".harness"), { recursive: true });
      symlinkSync(victim.target, join(dir, ".harness", "state.json"));

      expect(() => saveState(dir, makeState())).toThrow(/symlink/);

      expect(readFileSync(victim.target, "utf8")).toBe("the user's file\n");
    });

    it("refuses a symlinked .harness directory that escapes the project", () => {
      if (windows) return;
      symlinkSync(victim.root, join(dir, ".harness"));

      expect(() => saveState(dir, makeState())).toThrow(/outside the project root|symlink/);

      expect(existsSync(join(victim.root, "state.json"))).toBe(false);
      expect(readFileSync(victim.target, "utf8")).toBe("the user's file\n");
    });

    it("refuses a symlinked report and a symlinked PROGRESS.md", () => {
      if (windows) return;
      mkdirSync(join(dir, ".harness", "reports"), { recursive: true });
      symlinkSync(victim.target, join(dir, ".harness", "reports", "01-EXECUTE-1.md"));
      expect(() => writeReport(dir, 1, "EXECUTE", 1, "report\n")).toThrow(/symlink/);

      symlinkSync(victim.target, join(dir, ".harness", "PROGRESS.md"));
      expect(() => renderProgressMarkdown(dir, makeState())).toThrow(/symlink/);

      expect(readFileSync(victim.target, "utf8")).toBe("the user's file\n");
    });

    it("writes atomically, leaving no temp file behind", () => {
      saveState(dir, makeState());
      renderProgressMarkdown(dir, makeState());
      writeReport(dir, 1, "EXECUTE", 1, "report\n");

      const stray = readdirSync(join(dir, ".harness"), { recursive: true }).filter((name) =>
        String(name).endsWith(".tmp"),
      );
      expect(stray).toEqual([]);
      expect(loadState(dir)!.planHash).toBe("x");
    });
  });
});
