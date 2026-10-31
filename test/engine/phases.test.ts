import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  validateStep,
  commitAll,
  indexIterationSourceFiles,
  getIterationFiles,
  computeValidateVerdict,
  enforceValidateVerdict,
  type PhaseContext,
} from "../../src/engine/phases.js";
import { parseValidateStepVerdict } from "../../src/engine/gate.js";
import {
  AUDIT_STATUS_BLOCKED,
  AUDIT_STATUS_PASS,
  AUDIT_STATUS_WARN,
} from "../../src/engine/steps/context.js";
import { git } from "../../src/engine/diff.js";
import { MemoryService } from "@dahch/muninn";

/** A passing report for the single `VALIDATE_STEP` increment audit. */
const PASS_REPORT = [
  "## Increment Audit Report",
  "",
  "### Overall fidelity: 🟢 ALIGNED",
  "",
  AUDIT_STATUS_PASS,
].join("\n");

/** The gate line/handoff pair huginn imposes on any report (kept for the command stub). */
const GATE_PASS_REPORT = "### Overall gate: 🟢\n✅ AUTO-APPROVED — all checks pass";

interface MockContextSetup {
  ctx: PhaseContext;
  commandCalls: Array<{ path: { id: string }; body: Record<string, unknown> }>;
  promptCalls: Array<{ path: { id: string }; body: Record<string, unknown> }>;
}

interface MockReplies {
  /** The single increment audit's reply. */
  report?: string;
}

/** The text of a captured `session.prompt` call. */
function promptText(call: { body: Record<string, unknown> }): string {
  const parts = call.body.parts as Array<{ text?: string }> | undefined;
  return parts?.[0]?.text ?? "";
}

function createMockContext(
  projectPath: string,
  overrides: Partial<PhaseContext> = {},
  replies: MockReplies = {}
): MockContextSetup {
  const commandCalls: Array<{ path: { id: string }; body: Record<string, unknown> }> = [];
  const promptCalls: Array<{ path: { id: string }; body: Record<string, unknown> }> = [];

  const client = {
    session: {
      create: async () => ({ id: "ses_test" }),
      get: async () => ({}),
      abort: async () => {},
      // Retained so tests can assert the pipeline never falls back to slash
      // commands (REQ-7).
      command: async (params: { path: { id: string }; body: Record<string, unknown> }) => {
        commandCalls.push(params);
        return {
          info: { id: "cmd_msg_id" },
          parts: [{ type: "text", text: GATE_PASS_REPORT }],
        };
      },
      prompt: async (params: { path: { id: string }; body: Record<string, unknown> }) => {
        promptCalls.push(params);
        const text = promptText(params);
        let reply = "prompt response";
        if (text.includes("## Task: audit this iteration's increment")) {
          reply = replies.report ?? PASS_REPORT;
        }
        return {
          info: { id: "prompt_msg_id" },
          parts: [{ type: "text", text: reply }],
        };
      },
    },
  } as unknown as OpencodeClient;

  const defaultCtx: PhaseContext = {
    client,
    sessionId: "ses_123",
    models: {
      thinker: { providerID: "opencode-go", modelID: "deepseek-v4-pro" },
      executor: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    },
    projectPath,
    iteration: {
      index: 1,
      title: "Test iteration",
      prompt: "Implement feature",
      startLine: 1,
    },
    specPath: path.join(projectPath, "spec.md"),
    adrPath: path.join(projectPath, "adr.md"),
    planPath: path.join(projectPath, "plan.md"),
    modules: [],
    phaseTimeoutMs: 1000,
    dbPath: path.join(projectPath, ".huginn", "muninn.db"),
  };

  return {
    ctx: { ...defaultCtx, ...overrides },
    commandCalls,
    promptCalls,
  };
}

describe("Engine Phases - Phase 2 Integrations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-phases-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("validateStep", () => {
    it("returns a structured failure report when contracts fail with a type error", async () => {
      // Creates a TypeScript file with an intentional type assignment error (TS2322)
      const badCode = `
export function compute(): number {
  const result: number = "not-a-number";
  return result;
}
`;
      const filePath = path.join(tempDir, "invalid.ts");
      fs.writeFileSync(filePath, badCode);

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: ["invalid.ts"],
      });

      const result = await validateStep(ctx);

      // Asserts that it returns the structured report with contract-compiler-failure
      expect(result.messageId).toBe("contract-compiler-failure");
      expect(result.raw.info).toEqual({ id: "contract-compiler-failure" });

      // Asserts that the structured report contains the required gate markers
      expect(result.text).toContain("### Overall gate: 🔴");
      expect(result.text).toContain("🛑 BLOCKED");
      expect(result.text).toContain("TS2322");
      expect(result.text).toContain("Type 'string' is not assignable to type 'number'");

      // Asserts that parseValidateStepVerdict returns "blocked"
      const verdict = parseValidateStepVerdict(result.text);
      expect(verdict).toBe("blocked");

      // Verifies the short-circuit: neither a slash command nor a prompt ran
      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(0);
    });

    it("issues ONE increment audit prompt carrying both mandatory contracts (REQ-7/REQ-61)", async () => {
      const validCode = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
      fs.writeFileSync(path.join(tempDir, "valid.ts"), validCode);

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: ["valid.ts"],
      });

      const result = await validateStep(ctx);

      // No slash command is used — every step is an injected prompt.
      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);

      const [audit] = promptCalls.map(promptText);
      expect(audit).toContain("## Task: audit this iteration's increment");
      expect(audit).toContain("### Overall fidelity:");
      expect(audit).toContain("### Audit status:");
      expect(audit).toContain(ctx.specPath);
      // qa and security are their own phases, not sub-prompts.
      expect(audit).not.toContain("AUDIT-ONLY MODE");

      // The returned text carries exactly one gate line + one handoff marker
      // imposed by huginn, and the structured verdict is what the engine gates on.
      expect(result.messageId).toBe("prompt_msg_id");
      expect(result.authoritativeVerdict).toBe("pass");
      expect(result.text.match(/^### Overall gate:/gim) ?? []).toHaveLength(1);
      expect(result.text.match(/^(?:✅|⚠️|🛑)/gim) ?? []).toHaveLength(1);
      expect(parseValidateStepVerdict(result.text)).toBe("pass");
    });

    it("sends the step prompt when TypeScript contracts pass cleanly", async () => {
      const validCode = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
      fs.writeFileSync(path.join(tempDir, "valid.ts"), validCode);

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: ["valid.ts"],
      });

      const result = await validateStep(ctx);

      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      // The spec-auditor sub-prompt embeds the module's spec path context.
      expect(promptCalls.map(promptText).join("\n")).toContain(ctx.specPath);

      expect(result.messageId).toBe("prompt_msg_id");
      expect(parseValidateStepVerdict(result.text)).toBe("pass");
    });

    it("discovers and verifies TypeScript files inside directory modules", async () => {
      const srcDir = path.join(tempDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      const brokenCode = `
export const greeting: string = 12345;
`;
      fs.writeFileSync(path.join(srcDir, "greet.ts"), brokenCode);

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: ["src"],
      });

      const result = await validateStep(ctx);

      expect(result.messageId).toBe("contract-compiler-failure");
      expect(result.text).toContain("### Overall gate: 🔴");
      expect(result.text).toContain("🛑 BLOCKED");
      expect(parseValidateStepVerdict(result.text)).toBe("blocked");
      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(0);
    });

    it("sends the step prompt when modules list is empty and no files are present", async () => {
      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: [],
      });

      const result = await validateStep(ctx);

      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      expect(result.messageId).toBe("prompt_msg_id");
    });

    it("ignores deleted files in pendingChanges and avoids false-positive contract failure (REV-001)", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      const filePath = path.join(tempDir, "deleted.ts");
      fs.writeFileSync(filePath, "export const a: number = 1;\n");
      git(tempDir, ["add", "deleted.ts"]);
      git(tempDir, ["commit", "-m", "add deleted.ts"]);

      // Remove the file from disk so git records it as deleted
      fs.unlinkSync(filePath);

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: [],
      });

      const files = getIterationFiles(tempDir, []);
      expect(files).not.toContain(filePath);

      const result = await validateStep(ctx);

      // Should not fail contracts because deleted file is omitted
      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      expect(result.messageId).toBe("prompt_msg_id");
    });

    it("contains path traversal attempts in modules and ignores paths outside project root (REV-002)", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-outside-"));
      try {
        const outsideBadCode = "export const x: number = 'invalid';";
        const outsideFile = path.join(outsideDir, "outside.ts");
        fs.writeFileSync(outsideFile, outsideBadCode);

        const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
          modules: ["../outside.ts", outsideFile, "../../etc/shadow"],
        });

        const files = getIterationFiles(tempDir, ctx.modules);
        expect(files).toHaveLength(0);

        const result = await validateStep(ctx);
        // Outside invalid file must not block validation
        expect(commandCalls).toHaveLength(0);
        expect(promptCalls).toHaveLength(1);
        expect(result.messageId).toBe("prompt_msg_id");
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("excludes vendor, build, and hidden directories during directory scan (REV-003)", async () => {
      const srcDir = path.join(tempDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      // Valid source file in src
      fs.writeFileSync(path.join(srcDir, "valid.ts"), "export const ok: number = 42;");

      // Invalid files placed in vendor, build, or hidden directories
      const nodeModulesDir = path.join(srcDir, "node_modules", "broken-pkg");
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      fs.writeFileSync(path.join(nodeModulesDir, "index.ts"), "export const bad: number = 'string';");

      const distDir = path.join(srcDir, "dist");
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, "bundle.ts"), "export const bad: number = 'string';");

      const buildDir = path.join(srcDir, "build");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "out.ts"), "export const bad: number = 'string';");

      const hiddenDir = path.join(srcDir, ".cache");
      fs.mkdirSync(hiddenDir, { recursive: true });
      fs.writeFileSync(path.join(hiddenDir, "cache.ts"), "export const bad: number = 'string';");

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: ["src"],
      });

      const files = getIterationFiles(tempDir, ["src"]);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(path.join(srcDir, "valid.ts"));

      const result = await validateStep(ctx);
      // Valid file passes and excluded directories are not scanned for errors
      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      expect(result.messageId).toBe("prompt_msg_id");
      expect(parseValidateStepVerdict(result.text)).toBe("pass");
    });

    it("blocks deterministically when security reports 🔴 even though the synthesis says 🟢 (REV-003 / M-4)", async () => {
      fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

      const { ctx } = createMockContext(
        tempDir,
        { modules: ["valid.ts"] },
        {
          report: `## Increment Audit Report\n\n### Overall fidelity: 🟢 ALIGNED\n\n${AUDIT_STATUS_BLOCKED}`,
        }
      );

      const result = await validateStep(ctx);

      expect(result.text).toContain("### Overall gate: 🔴 BLOCKED");
      expect(result.text).toContain("🛑 BLOCKED — do not proceed until issues are resolved");
      expect(result.text).not.toContain("### Overall gate: 🟢");
      expect(parseValidateStepVerdict(result.text)).toBe("blocked");
    });

    it("resolves to warning when the synthesis is 🟡 with all-green sub-reports (REV-003 / M-4)", async () => {
      fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

      const { ctx } = createMockContext(
        tempDir,
        { modules: ["valid.ts"] },
        {
          report: `## Increment Audit Report\n\n### Overall fidelity: 🟢 ALIGNED\n\n${AUDIT_STATUS_WARN}`,
        }
      );

      const result = await validateStep(ctx);

      expect(result.text).toContain("### Overall gate: 🟡 PASS WITH WARNINGS");
      expect(result.text).toContain("⚠️ REVIEW REQUESTED");
      expect(parseValidateStepVerdict(result.text)).toBe("warning");
    });

    it("fails closed to blocked when a mandatory marker is missing (REV-003 / M-4)", async () => {
      fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

      const { ctx } = createMockContext(tempDir, { modules: ["valid.ts"] }, {
        report: "## Increment Audit Report\n\n### Overall fidelity: 🟢 ALIGNED",
      });

      const result = await validateStep(ctx);

      expect(result.text).toContain("### Overall gate: 🔴 BLOCKED");
      expect(parseValidateStepVerdict(result.text)).toBe("blocked");
    });

    it("emits exactly one gate line and one handoff marker (the engine imposes the verdict)", async () => {
      fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

      const { ctx } = createMockContext(tempDir, { modules: ["valid.ts"] });

      const result = await validateStep(ctx);

      expect(result.text.match(/^### Overall gate:/gim) ?? []).toHaveLength(1);
      expect(result.text.match(/^(?:✅|⚠️|🛑)/gim) ?? []).toHaveLength(1);
    });

    it("does not block when the report echoes a gate/fidelity skeleton (REV-101)", async () => {
      fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

      // The role instructions carry `🟢 … / 🟡 … / 🔴 …` skeletons. A report that
      // echoes one must not force a spurious BLOCKED: only the report's own last
      // canonical lines decide.
      const { ctx } = createMockContext(
        tempDir,
        { modules: ["valid.ts"] },
        {
          report: [
            "## Increment Audit Report",
            "### Overall gate: 🟢 PASS / 🟡 PASS WITH WARNINGS / 🔴 BLOCKED",
            "### Overall fidelity: 🟢 ALIGNED / 🟡 MINOR DRIFT / 🔴 MAJOR DEVIATION",
            "",
            "### Overall fidelity: 🟢 ALIGNED",
            AUDIT_STATUS_PASS,
          ].join("\n"),
        }
      );

      const result = await validateStep(ctx);

      expect(result.authoritativeVerdict).toBe("pass");
      expect(result.text).toContain("### Overall gate: 🟢 PASS");
    });

    it("reads the canonical fidelity line, not the skeleton (REV-102)", async () => {
      fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

      const report = [
        "## Increment Audit Report",
        "### Overall fidelity: 🟢 ALIGNED / 🟡 MINOR DRIFT / 🔴 MAJOR DEVIATION",
        "",
        "Findings: none. No 🔴 deviations.",
        "",
        "### Overall fidelity: 🟢 ALIGNED",
        AUDIT_STATUS_PASS,
      ].join("\n");

      const { ctx } = createMockContext(
        tempDir,
        { modules: ["valid.ts"] },
        { report }
      );

      const result = await validateStep(ctx);

      expect(result.authoritativeVerdict).toBe("pass");
    });

    it("returns the verdict as a structured field alongside the report text (REV-101)", async () => {
      fs.writeFileSync(path.join(tempDir, "valid.ts"), "export const ok: number = 1;\n");

      const pass = await validateStep(createMockContext(tempDir, { modules: ["valid.ts"] }).ctx);
      expect(pass.authoritativeVerdict).toBe("pass");

      const warned = await validateStep(
        createMockContext(tempDir, { modules: ["valid.ts"] }, {
          report: `### Overall fidelity: 🟢 ALIGNED\n\n${AUDIT_STATUS_WARN}`,
        }).ctx
      );
      expect(warned.authoritativeVerdict).toBe("warning");
      // The report stays coherent with the field, for the human reader.
      expect(parseValidateStepVerdict(warned.text)).toBe("warning");

      const blocked = await validateStep(
        createMockContext(tempDir, { modules: ["valid.ts"] }, {
          report: `### Overall fidelity: 🟢 ALIGNED\n\n${AUDIT_STATUS_BLOCKED}`,
        }).ctx
      );
      expect(blocked.authoritativeVerdict).toBe("blocked");
    });

    it("carries the structured verdict on the compiler short-circuit too (REV-101)", async () => {
      fs.writeFileSync(path.join(tempDir, "invalid.ts"), 'export const a: number = "x";\n');

      const result = await validateStep(createMockContext(tempDir, { modules: ["invalid.ts"] }).ctx);

      expect(result.messageId).toBe("contract-compiler-failure");
      expect(result.authoritativeVerdict).toBe("blocked");
    });
  });

  describe("deterministic VALIDATE_STEP verdict (REV-003 / M-4)", () => {
    const green = `### Overall fidelity: 🟢 ALIGNED\n\n${AUDIT_STATUS_PASS}`;

    it("requires both mandatory conclusion lines and merges them fail-closed", () => {
      expect(computeValidateVerdict(green)).toBe("pass");
      expect(
        computeValidateVerdict(`### Overall fidelity: 🟡 MINOR DRIFT\n\n${AUDIT_STATUS_PASS}`)
      ).toBe("warning");
      expect(
        computeValidateVerdict(`### Overall fidelity: 🟢 ALIGNED\n\n${AUDIT_STATUS_WARN}`)
      ).toBe("warning");
      expect(
        computeValidateVerdict(`### Overall fidelity: 🔴 MAJOR DEVIATION\n\n${AUDIT_STATUS_PASS}`)
      ).toBe("blocked");
      expect(
        computeValidateVerdict(`### Overall fidelity: 🟢 ALIGNED\n\n${AUDIT_STATUS_BLOCKED}`)
      ).toBe("blocked");
      // Missing either marker (or an empty report) → blocked.
      expect(computeValidateVerdict("")).toBe("blocked");
      expect(computeValidateVerdict("### Overall fidelity: 🟢 ALIGNED")).toBe("blocked");
      expect(computeValidateVerdict(AUDIT_STATUS_PASS)).toBe("blocked");
      expect(computeValidateVerdict("no markers here")).toBe("blocked");
    });

    it("rewrites a contradicting gate/handoff line with the imposed verdict", () => {
      const report = "## Increment Audit Report\n\n### Overall gate: 🟢 PASS\n✅ AUTO-APPROVED — old";
      const out = enforceValidateVerdict(report, "blocked");

      expect(out.match(/^### Overall gate:/gim) ?? []).toHaveLength(1);
      expect(out).toContain("### Overall gate: 🔴 BLOCKED");
      expect(out).not.toContain("### Overall gate: 🟢");
      expect(parseValidateStepVerdict(out)).toBe("blocked");
    });

    it("reads the canonical conclusion lines, never body emoji (REV-101/REV-102)", () => {
      // The role's illustrative skeleton (all three emoji) is not a verdict.
      expect(
        computeValidateVerdict(
          `### Overall fidelity: 🟢 ALIGNED / 🟡 MINOR DRIFT / 🔴 MAJOR DEVIATION\n${AUDIT_STATUS_PASS}`
        )
      ).toBe("pass");
      // The report's own last canonical line decides.
      expect(
        computeValidateVerdict(
          [
            "### Overall fidelity: 🟢 ALIGNED / 🟡 MINOR DRIFT / 🔴 MAJOR DEVIATION",
            "### Overall fidelity: 🟡 MINOR DRIFT",
            AUDIT_STATUS_PASS,
          ].join("\n")
        )
      ).toBe("warning");
      // A 🔴 bullet or a 🛑 line in the body does not override the canonical pair.
      expect(
        computeValidateVerdict(
          `Notes: one 🔴 finding was dismissed.\n🛑 BLOCKED — hmm\n\n### Overall fidelity: 🟢 ALIGNED\n${AUDIT_STATUS_PASS}`
        )
      ).toBe("pass");
      // No canonical fidelity line: the whole-body parser is the fallback.
      expect(
        computeValidateVerdict(`The implementation is SEMANTICALLY ALIGNED.\n${AUDIT_STATUS_PASS}`)
      ).toBe("pass");
      expect(computeValidateVerdict("unparseable prose")).toBe("blocked");
    });
  });

  describe("commitAll", () => {
    /**
     * The engine now indexes after a successful promotion, not inside
     * `commitAll`; this mirrors that pair so the indexing assertions still
     * exercise the moved behaviour.
     */
    async function commitAndIndex(ctx: PhaseContext) {
      const result = await commitAll(ctx);
      indexIterationSourceFiles({
        projectPath: ctx.projectPath,
        baseCommit: ctx.baseCommit,
        primaryProjectRoot: ctx.primaryProjectRoot ?? ctx.projectPath,
        dbPath: ctx.dbPath,
      });
      return result;
    }

    it("sends the commit prompt and attempts indexFilesIntoMuninn without throwing", async () => {
      // Initialize temporary git repository
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      // Create a modified source file that pendingChanges will pick up
      const sourceCode = `
export class UserService {
  getUser(id: string): { id: string; name: string } {
    return { id, name: "Alice" };
  }
}
`;
      fs.writeFileSync(path.join(tempDir, "user.ts"), sourceCode);

      const closeSpy = vi.spyOn(MemoryService.prototype, "close");

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        modules: ["user.ts"],
      });

      const result = await commitAndIndex(ctx);

      // The commit step is an injected prompt, never a slash command (REQ-7).
      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      const text = promptText(promptCalls[0]);
      expect(text).toContain("semantic commits");
      expect(text).toContain("Conventional Commits");
      expect(result.messageId).toBe("prompt_msg_id");

      // Verifies indexFilesIntoMuninn was attempted (MemoryService instantiated and closed)
      expect(closeSpy).toHaveBeenCalled();
    });

    it("indexes modified files using baseCommit when baseCommit is provided", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      // Commit initial file
      fs.writeFileSync(path.join(tempDir, "base.txt"), "initial");
      git(tempDir, ["add", "base.txt"]);
      git(tempDir, ["commit", "-m", "initial commit"]);
      const baseCommit = git(tempDir, ["rev-parse", "HEAD"]).stdout.trim();

      // Add a TypeScript file and commit it
      const helperCode = `
export function helper(): string {
  return "hello from helper";
}
`;
      fs.writeFileSync(path.join(tempDir, "helper.ts"), helperCode);
      git(tempDir, ["add", "helper.ts"]);
      git(tempDir, ["commit", "-m", "add helper"]);

      const closeSpy = vi.spyOn(MemoryService.prototype, "close");

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir, {
        baseCommit,
      });

      const result = await commitAndIndex(ctx);

      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      expect(result.messageId).toBe("prompt_msg_id");
      expect(closeSpy).toHaveBeenCalled();
    });

    it("recovers gracefully without throwing if Muninn indexing fails", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      fs.writeFileSync(path.join(tempDir, "resilient.ts"), "export const ok = 1;");

      // Simulate a failure during Muninn service operations
      vi.spyOn(MemoryService.prototype, "close").mockImplementationOnce(() => {
        throw new Error("Simulated Muninn database lock error");
      });

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir);

      // Must not throw despite indexing failure
      const result = await commitAndIndex(ctx);

      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      expect(result.messageId).toBe("prompt_msg_id");
    });

    it("skips Muninn indexing when no TypeScript/JavaScript source files were modified", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      // Only a markdown file modified
      fs.writeFileSync(path.join(tempDir, "README.md"), "# Documentation");

      const closeSpy = vi.spyOn(MemoryService.prototype, "close");

      const { ctx, commandCalls, promptCalls } = createMockContext(tempDir);

      const result = await commitAndIndex(ctx);

      expect(commandCalls).toHaveLength(0);
      expect(promptCalls).toHaveLength(1);
      expect(result.messageId).toBe("prompt_msg_id");
      // No source files to index, so MemoryService is not opened
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it("captures modified files before commit-all so committed files are indexed into Muninn (REV-008)", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      // A real iteration always has a base commit; indexing diffs against it, so
      // a file the commit step commits is still visible (REV-008).
      fs.writeFileSync(path.join(tempDir, "README.md"), "init");
      git(tempDir, ["add", "README.md"]);
      git(tempDir, ["commit", "-m", "initial commit"]);
      const baseCommit = git(tempDir, ["rev-parse", "HEAD"]).stdout.trim();

      const sourceCode = "export class ProductService { getProduct(): string { return 'laptop'; } }\n";
      fs.writeFileSync(path.join(tempDir, "product.ts"), sourceCode);

      const { ctx, promptCalls } = createMockContext(tempDir, { baseCommit });

      // Simulate a real commit step that stages and commits everything during the prompt
      const origPrompt = ctx.client.session.prompt;
      ctx.client.session.prompt = async (params: { path: { id: string }; body: Record<string, unknown> }) => {
        git(tempDir, ["add", "-A"]);
        git(tempDir, ["commit", "-m", "committed by commit-all"]);
        return origPrompt(params);
      };

      const result = await commitAndIndex(ctx);

      expect(result.messageId).toBe("prompt_msg_id");
      expect(promptCalls).toHaveLength(1);

      // Verify Muninn database has indexed ProductService
      const defaultDbPath = path.join(tempDir, ".huginn", "muninn.db");
      expect(fs.existsSync(defaultDbPath)).toBe(true);

      const memService = new MemoryService({ projectRoot: tempDir, dbPath: defaultDbPath });
      try {
        const entities = memService.db
          .prepare("SELECT * FROM entities WHERE identifier LIKE ?")
          .all("%ProductService%") as Array<{ identifier: string }>;
        expect(entities.length).toBeGreaterThan(0);
        expect(entities[0].identifier).toContain("ProductService");
      } finally {
        memService.close?.();
      }
    });

    it("uses target database path in projectPath without polluting host database (REV-004)", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      const sourceCode = "export class OrderService { getOrder(): number { return 1; } }\n";
      fs.writeFileSync(path.join(tempDir, "order.ts"), sourceCode);

      const customDbPath = path.join(tempDir, "custom-db", "isolated.db");
      const { ctx } = createMockContext(tempDir, {
        dbPath: customDbPath,
      });

      await commitAndIndex(ctx);

      // Verify the custom database was created at customDbPath
      expect(fs.existsSync(customDbPath)).toBe(true);

      const memService = new MemoryService({ projectRoot: tempDir, dbPath: customDbPath });
      try {
        const entities = memService.db
          .prepare("SELECT * FROM entities WHERE identifier LIKE ?")
          .all("%OrderService%") as Array<{ identifier: string }>;
        expect(entities.length).toBeGreaterThan(0);
        expect(entities[0].identifier).toContain("OrderService");
      } finally {
        memService.close?.();
      }
    });

    it("defaults dbPath to projectPath/.huginn/muninn.db when dbPath is not overridden (REV-004)", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      const sourceCode = "export class CustomerService { getCustomer(): number { return 1; } }\n";
      fs.writeFileSync(path.join(tempDir, "customer.ts"), sourceCode);

      const { ctx } = createMockContext(tempDir, {
        dbPath: undefined,
      });

      await commitAndIndex(ctx);

      const expectedDbPath = path.join(tempDir, ".huginn", "muninn.db");
      expect(fs.existsSync(expectedDbPath)).toBe(true);

      const memService = new MemoryService({ projectRoot: tempDir, dbPath: expectedDbPath });
      try {
        const entities = memService.db
          .prepare("SELECT * FROM entities WHERE identifier LIKE ?")
          .all("%CustomerService%") as Array<{ identifier: string }>;
        expect(entities.length).toBeGreaterThan(0);
        expect(entities[0].identifier).toContain("CustomerService");
      } finally {
        memService.close?.();
      }
    });

    it("skips deleted files from AST indexing when a source file was deleted before commit (REV-001, REV-008)", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      const oldFile = path.join(tempDir, "old-service.ts");
      fs.writeFileSync(oldFile, "export class OldService {}\n");
      git(tempDir, ["add", "old-service.ts"]);
      git(tempDir, ["commit", "-m", "add old service"]);

      // Delete file from disk
      fs.unlinkSync(oldFile);

      const { ctx } = createMockContext(tempDir);
      // Indexing should run cleanly and not fail on the missing deleted file
      const result = await commitAndIndex(ctx);
      expect(result.messageId).toBe("prompt_msg_id");
    });

    it("persists symbols to the PRIMARY db/project while scanning the sandbox worktree (Phase 3 memory durability)", async () => {
      // The primary project (durable) and a sandbox worktree (ephemeral) live
      // in separate roots. commitAll must read changed files from the worktree
      // but write symbols to the primary project's database and project record,
      // so nothing is lost when the worktree is destroyed after promotion.
      const primaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-primary-"));
      const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-worktree-"));
      try {
        // primaryDir is the durable git root so `resolveDatabasePath` resolves
        // the default DB under it (never the host `~/.huginn`).
        git(primaryDir, ["init", "-q"]);
        git(worktreeDir, ["init", "-q"]);
        git(worktreeDir, ["config", "user.name", "Test Runner"]);
        git(worktreeDir, ["config", "user.email", "test@example.com"]);
        fs.writeFileSync(
          path.join(worktreeDir, "sandboxed.ts"),
          "export class SandboxedService { run(): void {} }\n"
        );

        const { ctx, commandCalls, promptCalls } = createMockContext(worktreeDir, {
          primaryProjectRoot: primaryDir,
          dbPath: undefined,
        });

        const result = await commitAndIndex(ctx);

        expect(commandCalls).toHaveLength(0);
        expect(promptCalls).toHaveLength(1);
        expect(result.messageId).toBe("prompt_msg_id");

        // The mutation landed in the PRIMARY project, not the worktree.
        const primaryDbPath = path.join(primaryDir, ".huginn", "muninn.db");
        expect(fs.existsSync(primaryDbPath)).toBe(true);
        expect(fs.existsSync(path.join(worktreeDir, ".huginn", "muninn.db"))).toBe(false);

        const memService = new MemoryService({ projectRoot: primaryDir, dbPath: primaryDbPath });
        try {
          const entities = memService.db
            .prepare("SELECT identifier, project_id FROM entities WHERE identifier LIKE ?")
            .all("%SandboxedService%") as Array<{ identifier: string; project_id: string }>;
          expect(entities.length).toBeGreaterThan(0);
          // Linked to the PRIMARY project record, not the worktree root.
          expect(entities[0].project_id).toBe(memService.currentProject.id);
          expect(memService.currentProject.root_path).toBe(path.resolve(primaryDir));
        } finally {
          memService.close?.();
        }
      } finally {
        fs.rmSync(primaryDir, { recursive: true, force: true });
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    });
  });
});
