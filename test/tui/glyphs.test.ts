import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import stringWidth from "string-width";
import {
  DECISION_GLYPHS,
  MODAL_TITLE_GLYPHS,
  STATUS_GLYPHS,
  decisionGlyph,
  phaseGlyph,
  verdictGlyph,
} from "../../src/tui/glyphs.js";
import { verdictIcon } from "../../src/format.js";
import { RAVEN_MARK, RAVEN_MOODS } from "../../src/brand.js";
import { freshState, renderProgressMarkdown } from "../../src/state/store.js";

/** Every code point that renders as an emoji (double-width, multi-toned). */
const EMOJI = /\p{Extended_Pictographic}/u;

/** U+26A0, built from its code point so this file never contains the literal. */
const WARNING_SIGN = String.fromCodePoint(0x26a0);
/** U+26A0 U+FE0F, the emoji-presentation warning sign the engine contract uses. */
const WARNING_SIGN_EMOJI = `${WARNING_SIGN}\uFE0F`;

/** Repo root resolved from this file, not the test runner's cwd. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every `.ts`/`.tsx` file under `dir`, with its source, for bounded source scans. */
function readSourceTree(dir: string): Array<{ path: string; source: string }> {
  const files: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readSourceTree(full));
      continue;
    }
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
    files.push({ path: full, source: readFileSync(full, "utf8") });
  }
  return files;
}

/** The slice of `source` from `start` to the next `end` marker after it. */
function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing section marker: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to === -1 ? undefined : to);
}

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

  it("defines the decision alphabet as single-width, ASCII, emoji-free marks (REQ-68)", () => {
    const decisions = [...Object.values(DECISION_GLYPHS), decisionGlyph("question"), decisionGlyph("post-cycle-live")];
    for (const glyph of decisions) {
      expect(glyph).not.toMatch(EMOJI);
      expect([...glyph]).toHaveLength(1);
      // AC-68.1: every decision mark is ASCII as well as one column wide, so the
      // table cannot quietly drift to a non-ASCII single-width code point.
      expect(glyph.codePointAt(0)).toBeLessThan(0x80);
      expect(stringWidth(glyph)).toBe(1);
    }
    // Every DecisionKind resolves to one of the four table entries.
    const kinds = [
      "gate-blocked",
      "permission",
      "question",
      "spec-deviation",
      "approve-draft",
      "scope-extraction",
      "draft-format",
      "post-cycle-live",
    ] as const;
    const members = new Set<string>(Object.values(DECISION_GLYPHS));
    for (const kind of kinds) {
      expect(members.has(decisionGlyph(kind))).toBe(true);
    }
  });

  it("keeps every modal title glyph on the measured, emoji-free grid (REQ-76)", () => {
    for (const [surface, glyph] of Object.entries(MODAL_TITLE_GLYPHS)) {
      expect(glyph, surface).not.toMatch(EMOJI);
      expect([...glyph], surface).toHaveLength(1);
      expect(stringWidth(glyph), surface).toBe(1);
    }
    // The three names are the API the modal titles compose from, not ad-hoc
    // characters in the JSX.
    expect(MODAL_TITLE_GLYPHS).toEqual({ agent: ">", help: "?", inspector: "·" });
    // Only the inspector spends the middle dot; the other two are ASCII.
    expect(MODAL_TITLE_GLYPHS.agent.codePointAt(0)).toBeLessThan(0x80);
    expect(MODAL_TITLE_GLYPHS.help.codePointAt(0)).toBeLessThan(0x80);
  });

  it("composes the three modal titles from the table, never an embedded glyph (REQ-76)", () => {
    const repo = REPO_ROOT;
    const surfaces = [
      ["src/tui/AgentPickerModal.tsx", "agent", "SELECT AGENT RUNTIME"],
      ["src/tui/HelpModal.tsx", "help", "HUGINN LIVE CHEAT SHEET"],
      ["src/tui/McpInspectorModal.tsx", "inspector", "MCP SERVER INSPECTOR"],
    ] as const;

    for (const [file, key, title] of surfaces) {
      const source = readFileSync(join(repo, file), "utf8");
      // The title is a template over the table, so changing the glyph is a
      // one-line edit in `glyphs.ts` and can never drift per surface.
      expect(source, file).toContain(`title={\`\${MODAL_TITLE_GLYPHS.${key}} ${title}\`}`);
      // No modal source carries a pictograph of its own.
      expect(source, file).not.toMatch(EMOJI);
    }
  });

  it("fails closed on a decision kind the alphabet does not know", () => {
    // The exhaustive switch throws instead of painting an unmeasured glyph.
    expect(() => decisionGlyph("bogus" as Parameters<typeof decisionGlyph>[0])).toThrow(
      /Unhandled decision kind: bogus/,
    );
  });

  it("keeps every raven mood on a single-column, emoji-free grid (REQ-73)", () => {
    // The raven's mood is part of the display alphabet: a mood glyph that was
    // double-width would shift the whole header by a column.
    const idleWidth = RAVEN_MARK[0]!.length;
    for (const [mood, rows] of Object.entries(RAVEN_MOODS)) {
      expect(rows, mood).toHaveLength(RAVEN_MARK.length);
      for (const [index, row] of rows.entries()) {
        expect(row.length, `${mood} row ${index}`).toBe(RAVEN_MARK[index]!.length);
        expect(row).toMatch(/^[\x20-\x7e]*$/);
        for (const glyph of row) {
          expect(glyph, `${mood}: ${JSON.stringify(glyph)}`).not.toMatch(EMOJI);
          expect(stringWidth(glyph), `${mood}: ${JSON.stringify(glyph)}`).toBe(1);
        }
      }
    }
    expect(idleWidth).toBeGreaterThan(0);
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
    const repo = REPO_ROOT;
    const phases = readFileSync(join(repo, "src/engine/phases.ts"), "utf8");
    const instructions = readFileSync(join(repo, "src/engine/steps/instructions.ts"), "utf8");

    // The three-way contract: instructions ↔ enforcement ↔ parsers.
    expect(phases).toContain("### Overall gate: 🟢 PASS");
    expect(phases).toContain("### Overall gate: 🟡 PASS WITH WARNINGS");
    expect(phases).toContain("### Overall gate: 🔴 BLOCKED");
    expect(instructions).toContain("### Overall fidelity:");
  });

  it("keeps the double-width warning sign out of every TUI source and test (AC-68.3)", () => {
    const repo = REPO_ROOT;
    const offenders = [
      ...readSourceTree(join(repo, "src/tui")),
      ...readSourceTree(join(repo, "test/tui")),
    ]
      .filter((file) => file.source.includes(WARNING_SIGN))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("leaves the engine's warning contract untouched (AC-68.5)", () => {
    const repo = REPO_ROOT;
    const phases = readFileSync(join(repo, "src/engine/phases.ts"), "utf8");
    const gate = readFileSync(join(repo, "src/engine/gate.ts"), "utf8");
    const context = readFileSync(join(repo, "src/engine/steps/context.ts"), "utf8");
    const instructions = readFileSync(join(repo, "src/engine/steps/instructions.ts"), "utf8");

    // The warning handoff line is a three-way contract: the role instruction,
    // huginn's enforcement text and the parsers all keep the double-width mark.
    expect(instructions).toContain(`${WARNING_SIGN_EMOJI} REVIEW REQUESTED`);
    expect(phases).toContain(`${WARNING_SIGN_EMOJI} REVIEW REQUESTED`);
    expect(phases).toContain("HANDOFF_LINE_RE");
    expect(gate).toContain(WARNING_SIGN_EMOJI);
    expect(context).toContain(WARNING_SIGN_EMOJI);
  });

  it("documents the decision alphabet without reintroducing the warning sign (REQ-68 / ADR-63)", () => {
    const repo = REPO_ROOT;
    const read = (file: string): string => readFileSync(join(repo, file), "utf8");

    // The spec is the auditor's yardstick for this iteration.
    const spec = read("SPEC.md");
    expect(spec).toContain("### REQ-68");
    expect(spec).toContain("DECISION_GLYPHS");
    expect(read("ADR.md")).toContain("## ADR-63");

    // Only the interface descriptions are in scope: the engine sections may
    // legitimately keep their contract markers.
    const readme = read("README.md");
    const design = read("DESIGN.md");
    const adr = read("ADR.md");
    const interfaceSections = [
      // README's glyph-language bullet, up to the next list item.
      section(readme, "**One Glyph Language", "\n- **"),
      // DESIGN's REQ-68 section, up to the next heading.
      section(design, "### 32.6", "\n### "),
      // ADR-63, up to the next record.
      section(adr, "## ADR-63", "\n## ADR-"),
    ];

    for (const text of interfaceSections) {
      expect(text).toContain("DECISION_GLYPHS");
      expect(text).not.toContain(WARNING_SIGN);
    }
  });
});
