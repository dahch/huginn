import { readFileSync } from "node:fs";
import type { Iteration } from "./types";

const ITER_HEADING =
  /^#{1,4}\s*iteration\s+(\d+)\s*[-:—]\s*(.*)$/i;

const MODULES_LINE = /^modules?:\s*(.+)$/i;

/** The three increment-contract sections, in either bold-label or heading form. */
const GOAL_RE =
  /^\s*(?:\*\*\s*goal\s*:?\s*\*\*|#{2,4}\s*goal\s*:?)\s*(.*)$/i;
const ACCEPTANCE_RE =
  /^\s*(?:\*\*\s*acceptance\s+criteria\s*:?\s*\*\*|#{2,4}\s*acceptance\s+criteria\s*:?)\s*(.*)$/i;
const VERIFICATION_RE =
  /^\s*(?:\*\*\s*verification\s*:?\s*\*\*|#{2,4}\s*verification\s*:?)\s*(.*)$/i;

const LIST_ITEM_RE = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/;
const FENCE_RE = /^\s*```/;

export interface IterationMetadata {
  goal?: string;
  acceptanceCriteria?: string[];
  verification?: string[];
}

function isMetadataMarker(line: string): boolean {
  return GOAL_RE.test(line) || ACCEPTANCE_RE.test(line) || VERIFICATION_RE.test(line);
}

/** Lines belonging to a section, stopping at the next metadata marker or heading. */
function sectionAfter(lines: string[], index: number): string[] {
  const out: string[] = [];
  let inFence = false;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    // A `# comment` inside a shell fence is data, not a markdown heading.
    if (!inFence && (isMetadataMarker(line) || /^#{1,4}\s+/.test(line) || /^\s*---\s*$/.test(line))) {
      break;
    }
    out.push(line);
  }
  return out;
}

/** Strip an inline code span and the surrounding whitespace. */
function stripCode(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function inlineItems(value: string): string[] {
  return value
    .split(";")
    .map((part) => stripCode(part.trim().replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, "")))
    .filter((part) => part.length > 0);
}

function acceptanceItems(section: string[], inline: string): string[] {
  const items = inlineItems(inline);
  for (const line of section) {
    const match = LIST_ITEM_RE.exec(line);
    if (match) {
      const item = stripCode(match[1] ?? "");
      if (item.length > 0) items.push(item);
    }
  }
  return [...new Set(items)];
}

function verificationCommands(section: string[], inline: string): string[] {
  const commands: string[] = [];
  const push = (value: string) => {
    const command = stripCode(value);
    if (command.length > 0 && !command.startsWith("#")) commands.push(command);
  };

  // `**Verification:** bun test` is a complete one-line declaration; the section
  // below it is the executor body, not more commands.
  if (inline.trim().length > 0) {
    push(inline);
    return commands;
  }

  let inFence = false;
  let fenceClosed = false;
  let sawItem = false;
  for (const line of section) {
    if (fenceClosed) break;
    if (FENCE_RE.test(line)) {
      if (inFence) {
        inFence = false;
        fenceClosed = true;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      push(line);
      continue;
    }
    if (line.trim() === "") {
      if (sawItem) break;
      continue;
    }
    const match = LIST_ITEM_RE.exec(line);
    if (match) {
      push(match[1] ?? "");
      sawItem = true;
      continue;
    }
    if (sawItem) break;
  }

  return [...new Set(commands)];
}

/**
 * Extract the increment-contract metadata (`Goal`, `Acceptance criteria`,
 * `Verification`) from an iteration body.
 *
 * The body itself is never rewritten: it stays the verbatim executor prompt, and
 * these fields are additional evidence the engine can gate on. A plan written
 * before the contract simply has no metadata (`{}`), so it keeps running.
 */
export function parseIterationMetadata(prompt: string): IterationMetadata {
  const lines = prompt.split("\n");
  const metadata: IterationMetadata = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const goal = GOAL_RE.exec(line);
    if (goal) {
      const inline = (goal[1] ?? "").trim();
      const value =
        inline.length > 0
          ? inline
          : (sectionAfter(lines, i).map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "");
      if (value.length > 0 && metadata.goal === undefined) metadata.goal = value;
      continue;
    }

    const acceptance = ACCEPTANCE_RE.exec(line);
    if (acceptance) {
      const inline = (acceptance[1] ?? "").trim();
      if (metadata.acceptanceCriteria === undefined) {
        metadata.acceptanceCriteria = acceptanceItems(sectionAfter(lines, i), inline);
      }
      continue;
    }

    const verification = VERIFICATION_RE.exec(line);
    if (verification) {
      const inline = (verification[1] ?? "").trim();
      if (metadata.verification === undefined) {
        metadata.verification = verificationCommands(sectionAfter(lines, i), inline);
      }
    }
  }

  return metadata;
}

export function parsePlan(content: string): Iteration[] {
  const lines = content.split("\n");
  const iterations: Iteration[] = [];
  let current: { startLine: number; index: number; title: string; promptLines: string[]; modules?: string[] } | null =
    null;

  const flush = () => {
    if (!current) return;
    const prompt = current.promptLines.join("\n").trim();
    const metadata = parseIterationMetadata(prompt);
    iterations.push({
      index: current.index,
      title: current.title.trim(),
      prompt,
      modules: current.modules,
      ...metadata,
      startLine: current.startLine,
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(ITER_HEADING);
    if (m) {
      flush();
      const index = Number(m[1]);
      const title = m[2] ?? "";
      current = { index, title, promptLines: [], startLine: i + 1 };
      // optional modules line immediately after the heading
      const next = lines[i + 1]?.trim() ?? "";
      const mod = next.match(MODULES_LINE);
      if (mod) {
        current.modules = mod[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        i += 1;
      }
      continue;
    }
    if (current) current.promptLines.push(line);
  }
  flush();

  iterations.sort((a, b) => a.index - b.index);
  return iterations;
}

export function loadPlan(path: string): { content: string; iterations: Iteration[] } {
  const content = readFileSync(path, "utf8");
  const iterations = parsePlan(content);
  if (iterations.length === 0) {
    throw new Error(
      `No iterations found in ${path}. Use headings like "## Iteration 1 — Title" with the prompt as the section body.`,
    );
  }
  return { content, iterations };
}
