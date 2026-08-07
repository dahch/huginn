import { readFileSync } from "node:fs";
import type { Iteration } from "./types";

const ITER_HEADING =
  /^#{1,4}\s*iteration\s+(\d+)\s*[-:—]\s*(.*)$/i;

const MODULES_LINE = /^modules?:\s*(.+)$/i;

export function parsePlan(content: string): Iteration[] {
  const lines = content.split("\n");
  const iterations: Iteration[] = [];
  let current: { startLine: number; index: number; title: string; promptLines: string[]; modules?: string[] } | null =
    null;

  const flush = () => {
    if (!current) return;
    const prompt = current.promptLines.join("\n").trim();
    iterations.push({
      index: current.index,
      title: current.title.trim(),
      prompt,
      modules: current.modules,
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
