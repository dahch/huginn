import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSkills,
  findSkill,
  parseSkillContent,
  BUILTIN_SKILLS,
} from "../../src/engine/skills/index.js";

describe("Skills System - Engine Subsystem", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "huginn-skills-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Built-in skills", () => {
    it("provides audit, refactor, and explain built-in skills by default", () => {
      const skills = loadSkills(tempDir);
      expect(skills.length).toBeGreaterThanOrEqual(3);

      const audit = findSkill(skills, "audit");
      expect(audit).toBeDefined();
      expect(audit?.id).toBe("audit");
      expect(audit?.builtin).toBe(true);

      const refactor = findSkill(skills, "refactor");
      expect(refactor).toBeDefined();
      expect(refactor?.builtin).toBe(true);

      const explain = findSkill(skills, "explain");
      expect(explain).toBeDefined();
      expect(explain?.builtin).toBe(true);
    });

    it("respects includeBuiltins: false option", () => {
      const skills = loadSkills(tempDir, { includeBuiltins: false });
      expect(skills).toEqual([]);
    });
  });

  describe("Project-level skills loading", () => {
    it("scans .huginn/skills/ and .opencode/skills/ for *.md files", () => {
      const huginnSkillsDir = join(tempDir, ".huginn", "skills");
      const opencodeSkillsDir = join(tempDir, ".opencode", "skills");
      mkdirSync(huginnSkillsDir, { recursive: true });
      mkdirSync(opencodeSkillsDir, { recursive: true });

      writeFileSync(
        join(huginnSkillsDir, "perf.md"),
        `---
name: Performance Optimizer
description: Optimize query and runtime performance
triggers:
  - perf
  - speed
---
Analyze critical path and optimize performance.`,
      );

      writeFileSync(
        join(opencodeSkillsDir, "testgen.md"),
        `---
name: Test Generator
description: Generate unit and integration tests
triggers: [test, tests, coverage]
---
Generate comprehensive tests for this module.`,
      );

      const skills = loadSkills(tempDir, { includeBuiltins: false });
      expect(skills.length).toBe(2);

      const perf = findSkill(skills, "perf");
      expect(perf).toBeDefined();
      expect(perf?.name).toBe("Performance Optimizer");
      expect(perf?.triggers).toContain("perf");
      expect(perf?.triggers).toContain("speed");
      expect(perf?.body).toContain("Analyze critical path");

      const testgen = findSkill(skills, "testgen");
      expect(testgen).toBeDefined();
      expect(testgen?.name).toBe("Test Generator");
      expect(testgen?.triggers).toContain("test");
    });

    it("allows project skills to override built-in skills with the same id", () => {
      const huginnSkillsDir = join(tempDir, ".huginn", "skills");
      mkdirSync(huginnSkillsDir, { recursive: true });

      writeFileSync(
        join(huginnSkillsDir, "audit.md"),
        `---
name: Custom Project Audit
description: Project-specific security audit rules
triggers: [audit]
---
Custom audit rules for this repo.`,
      );

      const skills = loadSkills(tempDir, { includeBuiltins: true });
      const audit = findSkill(skills, "audit");
      expect(audit).toBeDefined();
      expect(audit?.name).toBe("Custom Project Audit");
      expect(audit?.builtin).toBe(false);
      expect(audit?.body).toBe("Custom audit rules for this repo.");
    });

    it("bounds file read size to 1MB and skips files exceeding the limit", () => {
      const huginnSkillsDir = join(tempDir, ".huginn", "skills");
      mkdirSync(huginnSkillsDir, { recursive: true });

      // Create a file slightly larger than 1MB
      const largeContent = "a".repeat(1024 * 1024 + 10);
      writeFileSync(join(huginnSkillsDir, "oversized.md"), largeContent);

      const skills = loadSkills(tempDir, { includeBuiltins: false });
      expect(skills.find((s) => s.id === "oversized")).toBeUndefined();
    });

    it("skips directories named *.md safely", () => {
      const huginnSkillsDir = join(tempDir, ".huginn", "skills");
      mkdirSync(join(huginnSkillsDir, "nested.md"), { recursive: true });

      const skills = loadSkills(tempDir, { includeBuiltins: false });
      expect(skills.find((s) => s.id === "nested")).toBeUndefined();
    });
  });

  describe("YAML frontmatter parsing & ANSI stripping", () => {
    it("parses YAML list, inline array, and comma-separated triggers", () => {
      const rawYamlList = `---
name: YAML List Skill
description: Uses YAML list triggers
triggers:
  - alpha
  - beta
---
Body prompt`;
      const skill1 = parseSkillContent("list.md", "/path/list.md", rawYamlList);
      expect(skill1.triggers).toEqual(["alpha", "beta"]);

      const rawInline = `---
title: Inline Array Skill
desc: Uses inline triggers
triggers: [gamma, delta]
---
Body prompt 2`;
      const skill2 = parseSkillContent("inline.md", "/path/inline.md", rawInline);
      expect(skill2.name).toBe("Inline Array Skill");
      expect(skill2.description).toBe("Uses inline triggers");
      expect(skill2.triggers).toEqual(["gamma", "delta"]);

      const rawComma = `---
name: Comma Skill
description: Uses comma triggers
triggers: epsilon, zeta
---
Body prompt 3`;
      const skill3 = parseSkillContent("comma.md", "/path/comma.md", rawComma);
      expect(skill3.triggers).toEqual(["epsilon", "zeta"]);
    });

    it("strips ANSI escape sequences from frontmatter and body", () => {
      const rawAnsi = `---
name: \u001b[31mInjected\u001b[0m Name
description: \u001b[1mBold\u001b[0m description
triggers:
  - \u001b[32mclean\u001b[0m
---
\u001b[33mEscaped\u001b[0m body content`;

      const skill = parseSkillContent("ansi.md", "/path/ansi.md", rawAnsi);
      expect(skill.name).toBe("Injected Name");
      expect(skill.description).toBe("Bold description");
      expect(skill.triggers).toContain("clean");
      expect(skill.body).toBe("Escaped body content");
    });

    it("handles missing frontmatter using file basename and paragraphs", () => {
      const rawPlain = `# My Plain Skill

This is the first non-empty paragraph that describes the skill.

This is the remainder of the markdown file which forms the prompt body.
It can span multiple lines.`;

      const skill = parseSkillContent("plain-skill.md", "/path/plain-skill.md", rawPlain);
      expect(skill.id).toBe("plain-skill");
      expect(skill.name).toBe("plain-skill");
      expect(skill.description).toBe(
        "This is the first non-empty paragraph that describes the skill.",
      );
      expect(skill.body).toContain("This is the remainder of the markdown file");
    });
  });

  describe("findSkill query resolution", () => {
    const testSkills = [
      {
        id: "security-audit",
        name: "Security Audit",
        description: "Checks code for vulnerabilities",
        triggers: ["audit", "sec", "owasp"],
        body: "Prompt",
        filePath: "/p/sec.md",
      },
      {
        id: "ts-refactor",
        name: "TypeScript Refactoring",
        description: "Refactor TypeScript code",
        triggers: ["refactor", "types"],
        body: "Prompt 2",
        filePath: "/p/ts.md",
      },
    ];

    it("finds by exact id (case-insensitive)", () => {
      expect(findSkill(testSkills, "security-audit")?.id).toBe("security-audit");
      expect(findSkill(testSkills, "SECURITY-AUDIT")?.id).toBe("security-audit");
    });

    it("finds by exact name (case-insensitive)", () => {
      expect(findSkill(testSkills, "Security Audit")?.id).toBe("security-audit");
      expect(findSkill(testSkills, "typescript refactoring")?.id).toBe("ts-refactor");
    });

    it("finds by trigger (case-insensitive)", () => {
      expect(findSkill(testSkills, "owasp")?.id).toBe("security-audit");
      expect(findSkill(testSkills, "TYPES")?.id).toBe("ts-refactor");
    });

    it("finds by substring fallback", () => {
      expect(findSkill(testSkills, "refact")?.id).toBe("ts-refactor");
    });

    it("returns undefined when query does not match", () => {
      expect(findSkill(testSkills, "nonexistent-skill")).toBeUndefined();
      expect(findSkill(testSkills, "")).toBeUndefined();
    });
  });

  describe("Loader hardening (SEC)", () => {
    it("ignores a symlinked skills directory that escapes the project root", () => {
      const outside = mkdtempSync(join(tmpdir(), "huginn-skills-outside-"));
      try {
        writeFileSync(
          join(outside, "leak.md"),
          `---\nname: Leaked\ndescription: outside project\n---\nsecret payload`,
        );
        mkdirSync(join(tempDir, ".opencode"), { recursive: true });
        symlinkSync(outside, join(tempDir, ".opencode", "skills"), "dir");

        const skills = loadSkills(tempDir, { includeBuiltins: false });
        expect(skills.find((s) => s.id === "leak")).toBeUndefined();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("extracts filePath and fallback triggers without raw terminal escapes", () => {
      const skill = parseSkillContent(
        "\u001b[31mfault\u001b[0m.md",
        "/p/\u001b[31mfault\u001b[0m.md",
        "A plain paragraph body.",
      );
      expect(skill.filePath).not.toContain("\u001b");
      expect(skill.triggers.every((t) => !t.includes("\u001b"))).toBe(true);
      expect(skill.id).not.toContain("\u001b");
    });

    it("parses frontmatter that ends at the closing fence with no trailing newline", () => {
      const raw = "---\nname: No Trailing Newline\ndescription: edge case\ntriggers: [edge]\n---";
      const skill = parseSkillContent("edge.md", "/p/edge.md", raw);
      expect(skill.name).toBe("No Trailing Newline");
      expect(skill.description).toBe("edge case");
      expect(skill.triggers).toEqual(["edge"]);
      expect(skill.body).toBe("");
    });

    it("strips inline YAML comments from scalars and trigger lists", () => {
      const raw = [
        "---",
        "name: Clean Name # trailing comment",
        "description: Desc # another",
        "triggers: [one, two] # list comment",
        "---",
        "Body",
      ].join("\n");
      const skill = parseSkillContent("c.md", "/p/c.md", raw);
      expect(skill.name).toBe("Clean Name");
      expect(skill.description).toBe("Desc");
      expect(skill.triggers).toEqual(["one", "two"]);
    });

    it("does not deep-share builtin trigger arrays between loads", () => {
      const first = loadSkills(tempDir);
      const second = loadSkills(tempDir);
      const a = first.find((s) => s.id === "audit")!;
      const b = second.find((s) => s.id === "audit")!;
      expect(a.triggers).not.toBe(b.triggers);
      expect(a.triggers).toEqual(b.triggers);
    });
  });
});
