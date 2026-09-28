import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { sanitizeTerminalText } from "../../util/text.js";
import type { Skill } from "./types.js";

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "audit",
    name: "Audit Code",
    description: "Run code audits and security/quality checks on recently changed files.",
    triggers: ["audit", "security", "check"],
    body: "Please run a thorough security and quality audit of recently modified files in this project. Identify potential vulnerabilities, edge cases, input validation gaps, or performance bottlenecks.",
    filePath: "builtin:audit",
    builtin: true,
  },
  {
    id: "refactor",
    name: "Refactor Code",
    description: "Analyze code structure, readability, and propose clean refactorings preserving contracts.",
    triggers: ["refactor", "clean", "simplify"],
    body: "Please analyze the code structure for readability, modularity, and maintainability. Propose clean refactorings while strictly preserving existing contracts and public APIs.",
    filePath: "builtin:refactor",
    builtin: true,
  },
  {
    id: "explain",
    name: "Explain Architecture",
    description: "Explain architecture, design decisions, and contracts of the project or specific module.",
    triggers: ["explain", "arch", "architecture", "overview"],
    body: "Please provide a clear architectural overview of this project, explaining key components, design decisions, contracts, and data flow.",
    filePath: "builtin:explain",
    builtin: true,
  },
];

const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

const SKILL_DIR_SEGMENTS: string[][] = [
  [".huginn", "skills"],
  [".opencode", "skills"],
];

/**
 * Supported frontmatter is a flat subset of YAML: `key: value` scalars plus
 * `- item`, `[a, b]`, and `a, b` trigger lists. Block scalars, nested keys,
 * multi-line values, and merge keys are not parsed and degrade to plain text.
 */
const FRONTMATTER_REGEX = /^\s*---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n([\s\S]*))?$/;

function cleanQuotes(str: string): string {
  const trimmed = str.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function stripInlineComment(str: string): string {
  const trimmed = str.trim();
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth = Math.max(0, depth - 1);
      } else if (ch === "#" && depth === 0 && i > 0 && /\s/.test(trimmed[i - 1]!)) {
        return trimmed.slice(0, i).trim();
      }
    }
  }
  return trimmed;
}

function parseTriggersList(raw: string): string[] {
  const trimmed = stripInlineComment(raw);
  if (!trimmed) return [];
  const inner =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(",")
    .map((s) => cleanQuotes(sanitizeTerminalText(s)))
    .filter((s) => s.length > 0);
}

export function parseSkillContent(
  filename: string,
  filePath: string,
  rawContent: string,
): Skill {
  const content =
    rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  const baseId = basename(filename, extname(filename));
  const safeFilePath = sanitizeTerminalText(filePath);
  const safeBaseId = sanitizeTerminalText(baseId);

  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    const paragraphs = content
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    let descIdx = 0;
    if (paragraphs.length > 1 && /^#+\s+/.test(paragraphs[0]!)) {
      descIdx = 1;
    }

    const description = paragraphs.length > descIdx
      ? sanitizeTerminalText(paragraphs[descIdx]!)
      : `Skill ${safeBaseId}`;

    const bodyParagraphs = paragraphs.filter((_, idx) => idx !== descIdx && (!/^#+\s+/.test(paragraphs[idx]!) || idx > descIdx));
    const body = bodyParagraphs.length > 0
      ? sanitizeTerminalText(bodyParagraphs.join("\n\n").trim())
      : (paragraphs.length === 1 ? sanitizeTerminalText(paragraphs[0]!) : "");

    return {
      id: safeBaseId,
      name: safeBaseId,
      description,
      triggers: [safeBaseId.toLowerCase()],
      body,
      filePath: safeFilePath,
      builtin: false,
    };
  }

  const rawYaml = match[1] ?? "";
  const rawBody = match[2] ?? "";

  const yamlLines = rawYaml.split(/\r?\n/);
  let name = "";
  let description = "";
  const triggers: string[] = [];
  let inTriggersList = false;

  for (let i = 0; i < yamlLines.length; i++) {
    const line = yamlLines[i] ?? "";
    const trimmedLine = line.trim();

    if (inTriggersList) {
      if (trimmedLine.startsWith("-")) {
        const item = cleanQuotes(stripInlineComment(trimmedLine.slice(1).trim()));
        if (item) triggers.push(sanitizeTerminalText(item));
        continue;
      } else if (!trimmedLine) {
        continue;
      } else {
        inTriggersList = false;
      }
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    // Defence-in-depth: skip prototype-pollution-risk keys
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const val = line.slice(colonIdx + 1).trim();

    if (key === "name" || key === "title") {
      name = cleanQuotes(stripInlineComment(val));
    } else if (key === "description" || key === "desc") {
      description = cleanQuotes(stripInlineComment(val));
    } else if (key === "triggers" || key === "trigger") {
      if (!val) {
        inTriggersList = true;
      } else {
        triggers.push(...parseTriggersList(val));
      }
    }
  }

  const finalId = safeBaseId;
  const finalName = sanitizeTerminalText(name || baseId);
  const finalDescription = sanitizeTerminalText(description || `Skill ${finalName}`);
  const finalBody = sanitizeTerminalText(rawBody.trim());
  const finalTriggers = (triggers.length > 0 ? triggers : [finalId.toLowerCase()]).map(
    (t) => sanitizeTerminalText(t).toLowerCase(),
  );

  return {
    id: finalId,
    name: finalName,
    description: finalDescription,
    triggers: finalTriggers,
    body: finalBody,
    filePath: safeFilePath,
    builtin: false,
  };
}

export interface LoadSkillsOptions {
  includeBuiltins?: boolean;
}

/**
 * Resolves a skills directory strictly inside the project: the directory must
 * exist, must not be a symlink, and its real path must stay under the real
 * project root. Prevents a hostile repo from pointing `.opencode/skills` at an
 * arbitrary directory outside the project and exfiltrating `.md` content.
 */
function resolveContainedSkillDir(projectRoot: string, segments: string[]): string | null {
  const candidate = join(projectRoot, ...segments);
  try {
    if (!existsSync(candidate)) return null;
    const lst = lstatSync(candidate);
    if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
    const realRoot = realpathSync(projectRoot);
    const realDir = realpathSync(candidate);
    if (realDir !== join(realRoot, ...segments)) return null;
    if (!realDir.startsWith(realRoot + sep)) return null;
    return realDir;
  } catch {
    return null;
  }
}

/**
 * Reads a skill file through an fd with O_NOFOLLOW (no symlink following, no
 * stat/read race) and caps the read at MAX_FILE_SIZE_BYTES.
 */
function readSkillFile(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) return null;
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buf, offset, stat.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return buf.subarray(0, offset).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // fd already closed; nothing to recover
      }
    }
  }
}

export function loadSkills(
  projectPath: string,
  options?: LoadSkillsOptions,
): Skill[] {
  const includeBuiltins = options?.includeBuiltins ?? true;
  const skills: Skill[] = [];
  const seenIds = new Set<string>();

  for (const segments of SKILL_DIR_SEGMENTS) {
    const dir = resolveContainedSkillDir(projectPath, segments);
    if (!dir) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const raw = readSkillFile(join(dir, entry));
      if (raw === null) continue;
      const skill = parseSkillContent(entry, join(dir, entry), raw);
      const lowerId = skill.id.toLowerCase();
      if (!seenIds.has(lowerId)) {
        seenIds.add(lowerId);
        skills.push(skill);
      }
    }
  }

  if (includeBuiltins) {
    for (const b of BUILTIN_SKILLS) {
      const lowerId = b.id.toLowerCase();
      if (!seenIds.has(lowerId)) {
        seenIds.add(lowerId);
        skills.push({ ...b, triggers: [...b.triggers] });
      }
    }
  }

  return skills;
}

export function findSkill(skills: Skill[], query: string): Skill | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;

  const byId = skills.find((s) => s.id.toLowerCase() === q);
  if (byId) return byId;

  const byName = skills.find((s) => s.name.toLowerCase() === q);
  if (byName) return byName;

  const byTrigger = skills.find((s) =>
    s.triggers.some((t) => t.toLowerCase() === q),
  );
  if (byTrigger) return byTrigger;

  return skills.find(
    (s) =>
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.triggers.some((t) => t.toLowerCase().includes(q)),
  );
}
