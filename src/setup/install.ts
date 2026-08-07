import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export type TemplateKind = "agent" | "command";

export interface Template {
  name: string;
  kind: TemplateKind;
}

/**
 * The opencode agents and slash commands huginn needs at runtime. All of them
 * are required: the 5 agents are invoked directly (spec-auditor) or by the
 * bundled slash commands via the Task tool; the 6 commands are the harness
 * gates themselves. The `build` agent is built into opencode, so it is not
 * bundled here.
 */
export const REQUIRED_TEMPLATES: Template[] = [
  { name: "spec-auditor", kind: "agent" },
  { name: "qa", kind: "agent" },
  { name: "security", kind: "agent" },
  { name: "doc-writer", kind: "agent" },
  { name: "reviewing", kind: "agent" },
  { name: "validate-step", kind: "command" },
  { name: "test-module", kind: "command" },
  { name: "secure-check", kind: "command" },
  { name: "review", kind: "command" },
  { name: "doc-sync", kind: "command" },
  { name: "commit-all", kind: "command" },
];

/**
 * Resolve the repo-level templates/ directory. Walks up from the compiled
 * module location so it works from src/ (dev), dist/ (bundled bin) and
 * scripts/ (postinstall). Overridable via HUGINN_TEMPLATES_DIR.
 */
export function findTemplatesRoot(): string {
  const override = process.env.HUGINN_TEMPLATES_DIR;
  if (override) return resolve(override);

  let dir = import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "templates");
    if (existsSync(join(candidate, "agents")) && existsSync(join(candidate, "commands"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the huginn templates/ directory. Set HUGINN_TEMPLATES_DIR.");
}

export function getOpencodeConfigDir(): string {
  const override = process.env.HUGINN_OPENCODE_CONFIG_DIR;
  if (override) return resolve(override);
  return join(homedir(), ".config", "opencode");
}

export function sourcePath(t: Template): string {
  return join(findTemplatesRoot(), t.kind === "agent" ? "agents" : "commands", `${t.name}.md`);
}

export function destPath(configDir: string, t: Template): string {
  return join(configDir, t.kind === "agent" ? "agents" : "commands", `${t.name}.md`);
}

export interface TemplateStatus extends Template {
  source: string;
  dest: string;
  installed: boolean;
}

export function listTemplates(configDir = getOpencodeConfigDir()): TemplateStatus[] {
  return REQUIRED_TEMPLATES.map((t) => {
    const source = sourcePath(t);
    const dest = destPath(configDir, t);
    return { ...t, source, dest, installed: existsSync(dest) };
  });
}

/** Templates whose destination file does not exist yet. */
export function getMissing(configDir = getOpencodeConfigDir()): TemplateStatus[] {
  return listTemplates(configDir).filter((t) => !t.installed);
}

export interface InstallResult {
  templates: TemplateStatus[];
  installed: string[];
  skipped: string[];
  overwritten: string[];
}

/**
 * Copy templates into the opencode config dir. Never overwrites an existing
 * file unless `force` is true (config may have been personalized).
 */
export function installTemplates(
  opts: { force?: boolean; configDir?: string; only?: TemplateKind } = {},
): InstallResult {
  const configDir = opts.configDir ?? getOpencodeConfigDir();
  const templates = listTemplates(configDir).filter((t) => !opts.only || t.kind === opts.only);
  const result: InstallResult = { templates, installed: [], skipped: [], overwritten: [] };

  for (const t of templates) {
    const dir = dirname(t.dest);
    mkdirSync(dir, { recursive: true });

    const existed = existsSync(t.dest);
    if (existed && !opts.force) {
      result.skipped.push(t.name);
      continue;
    }

    copyFileSync(t.source, t.dest);
    chmodSync(t.dest, 0o644);
    result.installed.push(t.name);
    if (existed) result.overwritten.push(t.name);
  }

  return result;
}

/** All templates currently present in the config dir (personalized or not). */
export function listInstalled(configDir = getOpencodeConfigDir()): TemplateStatus[] {
  return listTemplates(configDir).filter((t) => t.installed);
}

/**
 * Human-readable summary of the templates and their destination paths,
 * used by both `huginn install` and the postinstall prompt.
 */
export function describeTemplates(templates: TemplateStatus[]): string[] {
  return templates.map((t) => {
    const where = t.kind === "agent" ? "agents" : "commands";
    const marker = t.installed ? "already present" : "will be installed";
    return `  ${where}/${t.name}.md  (${marker})`;
  });
}

/**
 * Ask a yes/no question on the terminal. Returns `false` immediately when the
 * process is non-interactive (piped stdin) or running in CI — in that context
 * nothing should block or wait on a human.
 */
export async function promptYesNo(question: string, fallback = false): Promise<boolean> {
  if (process.env.CI || !process.stdin.isTTY || !process.stdout.isTTY) {
    return fallback;
  }
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolveAnswer(a === "y" || a === "yes");
    });
  });
}

/** Files present under templates/ (used by tests to sanity-check the bundle). */
export function listTemplateFiles(kind: TemplateKind, templatesRoot = findTemplatesRoot()): string[] {
  const dir = join(templatesRoot, kind === "agent" ? "agents" : "commands");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && statSync(join(dir, f)).isFile())
    .sort();
}
