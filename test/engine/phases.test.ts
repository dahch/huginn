import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  validateStep,
  commitAll,
  getIterationFiles,
  type PhaseContext,
} from "../../src/engine/phases.js";
import { parseValidateStepVerdict } from "../../src/engine/gate.js";
import { git } from "../../src/engine/diff.js";
import { MemoryService } from "../../src/muninn/service/memory-service.js";

interface MockContextSetup {
  ctx: PhaseContext;
  commandCalls: Array<{ path: { id: string }; body: Record<string, unknown> }>;
  promptCalls: Array<{ path: { id: string }; body: Record<string, unknown> }>;
}

function createMockContext(
  projectPath: string,
  overrides: Partial<PhaseContext> = {}
): MockContextSetup {
  const commandCalls: Array<{ path: { id: string }; body: Record<string, unknown> }> = [];
  const promptCalls: Array<{ path: { id: string }; body: Record<string, unknown> }> = [];

  const client = {
    session: {
      create: async () => ({ id: "ses_test" }),
      get: async () => ({}),
      abort: async () => {},
      command: async (params: { path: { id: string }; body: Record<string, unknown> }) => {
        commandCalls.push(params);
        return {
          info: { id: "cmd_msg_id" },
          parts: [
            {
              type: "text",
              text: "### Overall gate: 🟢\n✅ AUTO-APPROVED — all checks pass",
            },
          ],
        };
      },
      prompt: async (params: { path: { id: string }; body: Record<string, unknown> }) => {
        promptCalls.push(params);
        return {
          info: { id: "prompt_msg_id" },
          parts: [{ type: "text", text: "prompt response" }],
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

      const { ctx, commandCalls } = createMockContext(tempDir, {
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

      // Verifies that runCommand was short-circuited and not called
      expect(commandCalls).toHaveLength(0);
    });

    it("falls through to runCommand when TypeScript contracts pass cleanly", async () => {
      // Creates a clean, valid TypeScript file
      const validCode = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
      const filePath = path.join(tempDir, "valid.ts");
      fs.writeFileSync(filePath, validCode);

      const { ctx, commandCalls } = createMockContext(tempDir, {
        modules: ["valid.ts"],
      });

      const result = await validateStep(ctx);

      // Verifies it falls through to runCommand
      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("validate-step");
      expect(commandCalls[0].body.arguments).toContain("valid.ts");
      expect(commandCalls[0].body.arguments).toContain(ctx.specPath);

      expect(result.messageId).toBe("cmd_msg_id");
      expect(parseValidateStepVerdict(result.text)).toBe("pass");
    });

    it("discovers and verifies TypeScript files inside directory modules", async () => {
      const srcDir = path.join(tempDir, "src");
      fs.mkdirSync(srcDir, { recursive: true });

      const brokenCode = `
export const greeting: string = 12345;
`;
      fs.writeFileSync(path.join(srcDir, "greet.ts"), brokenCode);

      const { ctx, commandCalls } = createMockContext(tempDir, {
        modules: ["src"],
      });

      const result = await validateStep(ctx);

      expect(result.messageId).toBe("contract-compiler-failure");
      expect(result.text).toContain("### Overall gate: 🔴");
      expect(result.text).toContain("🛑 BLOCKED");
      expect(parseValidateStepVerdict(result.text)).toBe("blocked");
      expect(commandCalls).toHaveLength(0);
    });

    it("falls through to runCommand when modules list is empty and no files are present", async () => {
      const { ctx, commandCalls } = createMockContext(tempDir, {
        modules: [],
      });

      const result = await validateStep(ctx);

      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("validate-step");
      expect(result.messageId).toBe("cmd_msg_id");
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

      const { ctx, commandCalls } = createMockContext(tempDir, {
        modules: [],
      });

      const files = getIterationFiles(tempDir, []);
      expect(files).not.toContain(filePath);

      const result = await validateStep(ctx);

      // Should not fail contracts because deleted file is omitted
      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("validate-step");
      expect(result.messageId).toBe("cmd_msg_id");
    });

    it("contains path traversal attempts in modules and ignores paths outside project root (REV-002)", async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "huginn-outside-"));
      try {
        const outsideBadCode = "export const x: number = 'invalid';";
        const outsideFile = path.join(outsideDir, "outside.ts");
        fs.writeFileSync(outsideFile, outsideBadCode);

        const { ctx, commandCalls } = createMockContext(tempDir, {
          modules: ["../outside.ts", outsideFile, "../../etc/shadow"],
        });

        const files = getIterationFiles(tempDir, ctx.modules);
        expect(files).toHaveLength(0);

        const result = await validateStep(ctx);
        // Outside invalid file must not block validation
        expect(commandCalls).toHaveLength(1);
        expect(result.messageId).toBe("cmd_msg_id");
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

      const { ctx, commandCalls } = createMockContext(tempDir, {
        modules: ["src"],
      });

      const files = getIterationFiles(tempDir, ["src"]);
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(path.join(srcDir, "valid.ts"));

      const result = await validateStep(ctx);
      // Valid file passes and excluded directories are not scanned for errors
      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("validate-step");
      expect(result.messageId).toBe("cmd_msg_id");
      expect(parseValidateStepVerdict(result.text)).toBe("pass");
    });
  });

  describe("commitAll", () => {
    it("calls runCommand and attempts indexFilesIntoMuninn without throwing", async () => {
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

      const { ctx, commandCalls } = createMockContext(tempDir, {
        modules: ["user.ts"],
      });

      const result = await commitAll(ctx);

      // Verifies runCommand was called with commit-all
      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("commit-all");
      expect(result.messageId).toBe("cmd_msg_id");

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

      const { ctx, commandCalls } = createMockContext(tempDir, {
        baseCommit,
      });

      const result = await commitAll(ctx);

      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("commit-all");
      expect(result.messageId).toBe("cmd_msg_id");
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

      const { ctx, commandCalls } = createMockContext(tempDir);

      // Must not throw despite indexing failure
      const result = await commitAll(ctx);

      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("commit-all");
      expect(result.messageId).toBe("cmd_msg_id");
    });

    it("skips Muninn indexing when no TypeScript/JavaScript source files were modified", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      // Only a markdown file modified
      fs.writeFileSync(path.join(tempDir, "README.md"), "# Documentation");

      const closeSpy = vi.spyOn(MemoryService.prototype, "close");

      const { ctx, commandCalls } = createMockContext(tempDir);

      const result = await commitAll(ctx);

      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0].body.command).toBe("commit-all");
      expect(result.messageId).toBe("cmd_msg_id");
      // No source files to index, so MemoryService is not opened
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it("captures modified files before commit-all so committed files are indexed into Muninn (REV-008)", async () => {
      git(tempDir, ["init", "-q"]);
      git(tempDir, ["config", "user.name", "Test Runner"]);
      git(tempDir, ["config", "user.email", "test@example.com"]);

      const sourceCode = "export class ProductService { getProduct(): string { return 'laptop'; } }\n";
      fs.writeFileSync(path.join(tempDir, "product.ts"), sourceCode);

      const { ctx, commandCalls } = createMockContext(tempDir);

      // Simulate a real commit-all command that stages and commits everything during runCommand
      const origCommand = ctx.client.session.command;
      ctx.client.session.command = async (params: { path: { id: string }; body: Record<string, unknown> }) => {
        git(tempDir, ["add", "-A"]);
        git(tempDir, ["commit", "-m", "committed by commit-all"]);
        return origCommand(params);
      };

      const result = await commitAll(ctx);

      expect(result.messageId).toBe("cmd_msg_id");
      expect(commandCalls).toHaveLength(1);

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

      await commitAll(ctx);

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

      await commitAll(ctx);

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
      // commitAll should run cleanly and not fail on missing deleted file
      const result = await commitAll(ctx);
      expect(result.messageId).toBe("cmd_msg_id");
    });
  });
});
