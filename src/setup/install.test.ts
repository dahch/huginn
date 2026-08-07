import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  REQUIRED_TEMPLATES,
  findTemplatesRoot,
  getOpencodeConfigDir,
  listTemplates,
  getMissing,
  installTemplates,
  listInstalled,
  listTemplateFiles,
  promptYesNo,
} from "./install";

const prevTemplates = process.env.HUGINN_TEMPLATES_DIR;
const prevConfig = process.env.HUGINN_OPENCODE_CONFIG_DIR;

let templatesRoot: string;
let configDir: string;

beforeAll(() => {
  templatesRoot = findTemplatesRoot();
  process.env.HUGINN_TEMPLATES_DIR = templatesRoot;
  configDir = mkdtempSync(join(tmpdir(), "huginn-install-test-"));
  process.env.HUGINN_OPENCODE_CONFIG_DIR = configDir;
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
  if (prevTemplates === undefined) delete process.env.HUGINN_TEMPLATES_DIR;
  else process.env.HUGINN_TEMPLATES_DIR = prevTemplates;
  if (prevConfig === undefined) delete process.env.HUGINN_OPENCODE_CONFIG_DIR;
  else process.env.HUGINN_OPENCODE_CONFIG_DIR = prevConfig;
});

describe("findTemplatesRoot", () => {
  it("locates the bundled templates/ directory", () => {
    expect(existsSync(join(templatesRoot, "agents"))).toBe(true);
    expect(existsSync(join(templatesRoot, "commands"))).toBe(true);
  });

  it("bundles all 11 required pieces (5 agents + 6 commands)", () => {
    expect(listTemplateFiles("agent")).toHaveLength(5);
    expect(listTemplateFiles("command")).toHaveLength(6);
    expect(REQUIRED_TEMPLATES).toHaveLength(11);
  });

  it("has a template file for every required piece", () => {
    for (const t of REQUIRED_TEMPLATES) {
      const dir = join(templatesRoot, t.kind === "agent" ? "agents" : "commands");
      expect(existsSync(join(dir, `${t.name}.md`)), t.name).toBe(true);
    }
  });
});

describe("getOpencodeConfigDir", () => {
  it("respects HUGINN_OPENCODE_CONFIG_DIR", () => {
    expect(getOpencodeConfigDir()).toBe(configDir);
  });
});

describe("detection", () => {
  it("reports every template as missing on a fresh config dir", () => {
    const missing = getMissing();
    expect(missing).toHaveLength(11);
    expect(listInstalled()).toHaveLength(0);
  });

  it("no longer reports a template as missing after a file appears", () => {
    const agents = join(configDir, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "qa.md"), "customized");
    const missing = getMissing().map((t) => t.name);
    expect(missing).toContain("spec-auditor");
    expect(missing).not.toContain("qa");
    expect(listInstalled().map((t) => t.name)).toContain("qa");
  });
});

describe("installTemplates", () => {
  it("installs missing templates and does not touch existing ones", () => {
    const result = installTemplates({});
    expect(result.installed).toHaveLength(10);
    expect(result.skipped).toEqual(["qa"]);
    expect(result.overwritten).toEqual([]);
    expect(existsSync(join(configDir, "agents", "spec-auditor.md"))).toBe(true);
    expect(existsSync(join(configDir, "commands", "validate-step.md"))).toBe(true);
    expect(readFileSync(join(configDir, "agents", "qa.md"), "utf8")).toBe("customized");
  });

  it("is idempotent without force", () => {
    const result = installTemplates({});
    expect(result.installed).toHaveLength(0);
    expect(result.skipped).toHaveLength(11);
  });

  it("overwrites existing files when force is set", () => {
    const result = installTemplates({ force: true });
    expect(result.overwritten).toContain("qa");
    expect(result.overwritten).toHaveLength(11);
    expect(readFileSync(join(configDir, "agents", "qa.md"), "utf8").length).toBeGreaterThan(100);
  });

  it("restricts to a single kind with only", () => {
    const result = installTemplates({ only: "command" });
    expect(result.templates.every((t) => t.kind === "command")).toBe(true);
    expect(result.installed.every((n) => REQUIRED_TEMPLATES.some((t) => t.name === n && t.kind === "command"))).toBe(true);
  });
});

describe("promptYesNo", () => {
  it("returns the fallback when non-interactive (CI)", async () => {
    const prevCi = process.env.CI;
    process.env.CI = "true";
    try {
      await expect(promptYesNo("Install?", true)).resolves.toBe(true);
      await expect(promptYesNo("Install?")).resolves.toBe(false);
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
    }
  });
});
