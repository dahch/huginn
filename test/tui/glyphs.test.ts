import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATUS_GLYPHS, phaseGlyph, verdictGlyph } from "../../src/tui/glyphs.js";
import { verdictIcon } from "../../src/format.js";
import { freshState, renderProgressMarkdown } from "../../src/state/store.js";

/** Every code point that renders as an emoji (double-width, multi-toned). */
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * REQ-52 / ADR-51 — one single-width glyph table for the phase/status surfaces.
 */
describe("semantic glyph table (REQ-52)", () => {
  it("is single-width and emoji-free", () => {
    const glyphs = [
      ...Object.values(STATUS_GLYPHS),
      phaseGlyph("SPEC_AUDIT"),
      phaseGlyph("EXECUTE"),
      phaseGlyph("VALIDATE_STEP"),
      phaseGlyph("TEST_MODULE"),
      phaseGlyph("SECURE_CHECK"),
      phaseGlyph("REVIEW"),
      phaseGlyph("DOC_SYNC"),
      phaseGlyph("COMMIT_ALL"),
      phaseGlyph("FIX_REVIEW"),
      phaseGlyph("UNKNOWN_PHASE"),
    ];
    for (const glyph of glyphs) {
      expect(glyph).not.toMatch(EMOJI);
      // One code point, so the column never shifts by a width.
      expect([...glyph]).toHaveLength(1);
    }
  });

  it("is the single source the TUI verdict icon reads from", () => {
    expect(verdictIcon("pass")).toBe(STATUS_GLYPHS.pass);
    expect(verdictIcon("warning")).toBe(STATUS_GLYPHS.warning);
    expect(verdictIcon("blocked")).toBe(STATUS_GLYPHS.blocked);
    expect(verdictIcon("skipped")).toBe(STATUS_GLYPHS.skipped);
  });

  it("renders PROGRESS.md phase rows without a single emoji", () => {
    const dir = mkdtempSync(join(tmpdir(), "huginn-glyphs-"));
    try {
      const state = freshState({
        planHash: "x",
        planPath: join(dir, "plan.md"),
        specPath: join(dir, "spec.md"),
        adrPath: join(dir, "adr.md"),
        thinker: "p/x",
        executor: "e/y",
        mode: "auto",
      });
      state.history.push({
        iteration: 1,
        phase: "EXECUTE",
        attempt: 1,
        verdict: "pass",
        model: "e/y",
        sessionId: "s",
        messageId: "m",
        summary: "scaffolded the project",
        startedAt: "x",
        finishedAt: "x",
      });

      const content = readFileSync(renderProgressMarkdown(dir, state), "utf8");

      expect(content).not.toMatch(EMOJI);
      expect(content).toContain(STATUS_GLYPHS.pass);
      expect(content).toContain(phaseGlyph("EXECUTE"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the gate marker literals untouched (AC-52.3)", () => {
    const repo = process.cwd();
    const phases = readFileSync(join(repo, "src/engine/phases.ts"), "utf8");
    const instructions = readFileSync(join(repo, "src/engine/steps/instructions.ts"), "utf8");

    // The three-way contract: instructions ↔ enforcement ↔ parsers.
    expect(phases).toContain("### Overall gate: 🟢 PASS");
    expect(phases).toContain("### Overall gate: 🟡 PASS WITH WARNINGS");
    expect(phases).toContain("### Overall gate: 🔴 BLOCKED");
    expect(instructions).toContain("### Overall fidelity:");
  });
});
