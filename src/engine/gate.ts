import type { OpencodeClient } from "@opencode-ai/sdk";
import type { ModelRef, Verdict } from "./types";
import { prompt } from "../server/client";

const MAX_JUDGE_REPORT_LENGTH = 24000;
const MAX_FALLBACK_SUMMARY_LENGTH = 500;

/**
 * Returns the verdict carried by the report's markers, or `null` when the
 * report contains no parseable verdict (empty / truncated / hallucinated).
 * Callers must fail closed on `null` (treat as blocked).
 */
export function parseValidateStepVerdict(text: string): Verdict | null {
  if (/🛑\s*BLOCKED|^\s*🛑/m.test(text)) return "blocked";
  if (/⚠️\s*REVIEW REQUESTED|^\s*⚠️/m.test(text)) return "warning";
  if (/✅\s*AUTO-APPROVED|^\s*✅/m.test(text)) return "pass";
  // secondary markers
  if (/overall gate:\s*🔴/i.test(text)) return "blocked";
  if (/overall gate:\s*🟡/i.test(text)) return "warning";
  if (/overall gate:\s*🟢/i.test(text)) return "pass";
  if (/🔴\s*(PASS|WARN)/.test(text)) return "warning";
  return null;
}

export function parseSpecAuditVerdict(text: string): Verdict | null {
  if (/overall fidelity:\s*🔴|🔴\s*MAJOR DEVIATION/i.test(text)) return "blocked";
  if (/overall fidelity:\s*🟡|🟡\s*MINOR DRIFT/i.test(text)) return "warning";
  if (/overall fidelity:\s*🟢|🟢\s*ALIGNED/i.test(text)) return "pass";
  if (/🔴\s*MAJOR DEVIATION|MAJOR DEVIATION/.test(text)) return "blocked";
  if (/🟡\s*MINOR DRIFT|MINOR DRIFT/.test(text)) return "warning";
  if (/🟢\s*ALIGNED|ALIGNED/.test(text)) return "pass";
  return null;
}

export interface JudgeOutput {
  status: Verdict;
  summary: string;
  actionItems: string[];
  /** true when `status` came from structured output; false = heuristic fallback */
  parsed: boolean;
}

export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function normalizeJudgeOutput(v: unknown): JudgeOutput | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const status = String(o.status ?? "").toLowerCase();
  const verdict: Verdict | undefined = status === "pass" || status === "warning" || status === "blocked" ? status : undefined;
  if (!verdict) return null;
  return {
    status: verdict,
    summary: String(o.summary ?? ""),
    actionItems: Array.isArray(o.actionItems) ? o.actionItems.map((a) => String(a)) : [],
    parsed: true,
  };
}

export async function judgePhase(
  client: OpencodeClient,
  sessionId: string,
  model: ModelRef,
  phaseLabel: string,
  report: string,
  maxActionItems = 8,
  timeoutMs?: number,
): Promise<JudgeOutput> {
  const truncated =
    report.length > MAX_JUDGE_REPORT_LENGTH
      ? report.slice(0, MAX_JUDGE_REPORT_LENGTH) + "\n...[truncated]"
      : report;
  const text = `You are a strict validation judge for a development pipeline.

Classify the following "${phaseLabel}" execution report.

Return ONLY a JSON object with EXACTLY this shape (no markdown fences, no extra text):
{"status": "pass" | "warning" | "blocked", "summary": "<one or two sentences>", "actionItems": ["<specific actionable fix, if any>"]}

Semantics:
- "pass": no action required, safe to proceed.
- "warning": non-blocking issues; may proceed but note them.
- "blocked": blocking issues that MUST be fixed before proceeding. List up to ${maxActionItems} concrete actions.

Report:
---
${truncated}
---`;

  const res = await prompt(client, sessionId, { text, model, timeoutMs });
  const parsed = normalizeJudgeOutput(extractJson(res.text));
  if (parsed) return parsed;
  // fallback heuristics on the judge's own text
  if (/🛑|blocked/i.test(res.text) && !/not blocked/i.test(res.text)) {
    return { status: "blocked", summary: res.text.slice(0, MAX_FALLBACK_SUMMARY_LENGTH), actionItems: [], parsed: false };
  }
  if (/warning|⚠️/i.test(res.text)) {
    return { status: "warning", summary: res.text.slice(0, MAX_FALLBACK_SUMMARY_LENGTH), actionItems: [], parsed: false };
  }
  // fail closed: an unreadable judge report must never pass a blocking gate
  return { status: "blocked", summary: res.text.slice(0, MAX_FALLBACK_SUMMARY_LENGTH), actionItems: [], parsed: false };
}
