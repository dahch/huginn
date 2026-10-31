import { sanitizeTerminalText } from "../../util/text.js";
import type { ProfileName } from "../profiles.js";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".org"]);
/** Repository roots whose child folder is the meaningful scope. */
const ROOT_SEGMENTS = new Set(["src", "lib", "app", "apps", "packages", "test", "tests", "bench"]);

function extensionOf(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

/** Lower-case, hyphenated, ASCII-ish identifier; never empty when a fallback is given. */
function slug(input: string, max: number, fallback: string): string {
  const out = sanitizeTerminalText(input)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return out.length > 0 ? out : fallback;
}

function subjectOf(input: string, max: number): string {
  const out = sanitizeTerminalText(input)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,\s]+$/g, "");
  return out.length > max ? out.slice(0, max).trimEnd().replace(/[.:;,\s]+$/g, "") : out;
}

function scopeOf(changedPaths: string[], iteration: number): string {
  const first = changedPaths[0];
  if (!first) return `iter-${iteration}`;
  const segments = first.split("/").filter(Boolean);
  const candidate =
    segments.length >= 3 && ROOT_SEGMENTS.has(segments[0]!)
      ? segments[1]!
      : segments.length >= 2
        ? (ROOT_SEGMENTS.has(segments[0]!) ? segments[1]! : segments[0]!)
        : undefined;
  return slug(candidate ?? "", 24, `iter-${iteration}`);
}

export interface CommitMessageInput {
  iteration: { index: number; title: string; goal?: string };
  totalIterations: number;
  profile: ProfileName;
  /** Project-relative paths this iteration changed. */
  changedPaths: string[];
}

/**
 * The deterministic `<type>(<scope>): <subject>` for one increment.
 *
 * The same iteration always produces the same message, and no plan text ever
 * reaches the permanent history: the body names only the iteration, the profile
 * and the total count. A model that wants semantic grouping can opt back in with
 * `commit: "agent"`.
 */
export function deterministicCommitMessage(input: CommitMessageInput): string {
  const { iteration, totalIterations, profile, changedPaths } = input;
  const title = iteration.title.trim();

  const type = /^\s*(fix|bug)/i.test(title)
    ? "fix"
    : changedPaths.length > 0 && changedPaths.every((p) => DOC_EXTENSIONS.has(extensionOf(p)))
      ? "docs"
      : changedPaths.length === 0
        ? "chore"
        : "feat";
  const scope = scopeOf(changedPaths, iteration.index);
  const subject = subjectOf(title, 60) || `iteration ${iteration.index}`;

  return `${type}(${scope}): ${subject}\n\nHarness iteration ${iteration.index}/${totalIterations} (${profile}).`;
}
