import { join } from "node:path";
import child_process from "node:child_process";

// ---------------------------------------------------------------------------
// Hardened git invocation (SEC-001)
// ---------------------------------------------------------------------------

/**
 * Global git options huginn passes on **every** invocation.
 *
 * A repository's own configuration is attacker-controlled the moment huginn
 * reads a repo it did not create: `core.pager`/`pager.<cmd>` can name an
 * arbitrary command, `core.fsmonitor` a hook program, `core.hooksPath` a
 * directory of scripts. `--no-pager`/`core.pager=cat` neutralises the first,
 * and the rest are the pre-existing hardening. Centralised here so no call site
 * can forget them.
 */
const GIT_GLOBAL_HARDENING = [
  "--no-pager",
  "-c",
  "core.pager=cat",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];

/**
 * `--no-ext-diff`/`--no-textconv` are *diff* options: they are only accepted
 * after the subcommand and only mean something for the subcommands that render
 * a diff. Without them `diff.external`, a `.gitattributes`
 * `diff.<driver>.command` and `textconv` drivers — all repository-controlled —
 * execute arbitrary programs on the host while huginn merely tries to read a
 * diff (SEC-001). `-c`-style config cannot disable them, so they cannot be
 * overridden from the repository either.
 */
const DIFF_PRODUCING_SUBCOMMANDS = new Set([
  "diff",
  "show",
  "log",
  "whatchanged",
  "format-patch",
]);
const GIT_DIFF_HARDENING = ["--no-ext-diff", "--no-textconv"];

/** Index of the git subcommand, skipping global options (`-c x=y`, `-C dir`, …). */
function subcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "-C") {
      i += 1; // both take a value
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/** The subcommand a git argv targets, or `undefined` when it is all options. */
export function gitSubcommand(args: string[]): string | undefined {
  const index = subcommandIndex(args);
  return index === -1 ? undefined : args[index];
}

/** git subcommands the *bounded* runner (step prompts, tree hashing) may run. */
export const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "ls-files",
  "rev-parse",
]);

/**
 * Flags that turn a git call into a write/exec escape hatch (SEC-006/REV-105):
 * `-c`/`--config-env` inject arbitrary configuration, `--output` writes a file,
 * `--exec-path`/`--upload-pack`/`-O` name a program to run, and
 * `--git-dir`/`--work-tree`/`--no-index` redirect which tree is read.
 *
 * `--ext-diff`/`--textconv` are here for a second reason (SEC-001b): they
 * *re-enable* the very diff helpers {@link GIT_DIFF_HARDENING} disables, and git
 * resolves those two flags last-one-wins — so an argument later in the argv
 * would otherwise silently undo the hardening huginn inserted after the
 * subcommand. Rejected bare or with an inline `=value`.
 */
export const FORBIDDEN_GIT_ARG =
  /^(?:-c|--output|--exec-path|--upload-pack|--config-env|--git-dir|--work-tree|--no-index|--ext-diff|--textconv)(?:=|$)|^-O/;

/** The first argument that looks like a write/exec escape hatch, if any. */
export function firstForbiddenGitArg(args: string[]): string | undefined {
  return args.find((arg) => FORBIDDEN_GIT_ARG.test(arg));
}

/**
 * Why {@link gitBounded} must refuse `args`, or `null` when they are allowed.
 * The allowlist and the forbidden-flag screen live here so every bounded call
 * site is covered, not just the interpolated `!`git …`` ones.
 */
export function gitArgsRejectionReason(args: string[]): string | null {
  const forbidden = firstForbiddenGitArg(args);
  if (forbidden) return `forbidden git argument "${forbidden}"`;
  const subcommand = gitSubcommand(args);
  if (!subcommand) return "missing git subcommand";
  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
    return `git subcommand "${subcommand}" is not allowed`;
  }
  return null;
}

/**
 * Where trailing diff options may be appended: before a `--` path separator
 * (everything after it is a path, not an option), otherwise at the end.
 */
function optionTailIndex(args: string[]): number {
  const separator = args.indexOf("--");
  return separator === -1 ? args.length : separator;
}

/**
 * `args` prefixed with huginn's hardening. The single seam every git call must
 * go through: diff-rendering subcommands additionally get
 * {@link GIT_DIFF_HARDENING} inserted right after the subcommand, where git
 * accepts them.
 *
 * The diff hardening is applied **twice** on purpose (SEC-001b): right after the
 * subcommand *and* at the end of the option argv. `--ext-diff`/`--textconv` are
 * last-one-wins in git's option parsing, so a caller-supplied argument after the
 * first copy would otherwise switch the repository's `diff.external`/textconv
 * programs back on. Both copies stay before a `--` path separator.
 */
export function safeGitArgs(args: string[]): string[] {
  const index = subcommandIndex(args);
  const subcommand = index === -1 ? undefined : args[index]!;
  if (subcommand === undefined || !DIFF_PRODUCING_SUBCOMMANDS.has(subcommand)) {
    return [...GIT_GLOBAL_HARDENING, ...args];
  }
  const tail = optionTailIndex(args);
  return [
    ...GIT_GLOBAL_HARDENING,
    ...args.slice(0, index + 1),
    ...GIT_DIFF_HARDENING,
    ...args.slice(index + 1, tail),
    ...GIT_DIFF_HARDENING,
    ...args.slice(tail),
  ];
}

/** Hard deadline for any *bounded* git invocation (synchronous, chained). */
export const GIT_TIMEOUT_MS = 4_000;

/** Absolute ceiling on the bytes a bounded git capture may buffer. */
export const GIT_MAX_BYTES_CEILING = 4 * 1024 * 1024;

export interface GitBoundedResult {
  stdout: string;
  stderr: string;
  code: number;
  /** stdout hit the byte cap; the captured prefix is still returned with code 0. */
  stdoutTruncated: boolean;
  /** stderr hit the byte cap — tracked separately from stdout truncation. */
  stderrTruncated: boolean;
}

export interface GitBoundedOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Bounded git capture (M-3/REV-104): a hard timeout plus a byte cap passed to
 * the spawn so a huge diff is cut off *while being read*, and the
 * {@link safeGitArgs} hardening is applied here rather than at each call site.
 * Never throws.
 */
export function gitBounded(
  projectPath: string,
  args: string[],
  opts: GitBoundedOptions = {},
): GitBoundedResult {
  const rejection = gitArgsRejectionReason(args);
  if (rejection) {
    return {
      stdout: "",
      stderr: rejection,
      code: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  const maxBytes = Math.max(
    1,
    Math.min(opts.maxBytes ?? GIT_MAX_BYTES_CEILING, GIT_MAX_BYTES_CEILING),
  );
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;

  try {
    const res = child_process.spawnSync("git", safeGitArgs(args), {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: maxBytes,
    });
    const stdout = res.stdout ?? "";
    const stderrRaw = res.stderr ?? "";
    const errorCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
    // Node reports the byte cap as ERR_CHILD_PROCESS_STDIO_MAXBUFFER; Bun's
    // spawnSync reports the same condition as ENOBUFS.
    const killedOnMaxBuffer =
      errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || errorCode === "ENOBUFS";
    // Only the stream that reached the cap was truncated (which one is not
    // attributable when the runtime reports a single error for both).
    const stdoutTruncated = killedOnMaxBuffer && stdout.length >= maxBytes;
    const stderrTruncated = killedOnMaxBuffer && !stdoutTruncated;
    // A process killed by a signal (timeout, OOM, external kill) has no exit
    // status. That is a failure, never an "empty but successful" result
    // (REV-106) — a max-buffer kill is the one exception: the prefix is real.
    const killedBySignal =
      res.status === null && res.signal !== null && !killedOnMaxBuffer;
    const code = killedOnMaxBuffer
      ? 0
      : killedBySignal
        ? 1
        : res.status ?? (res.error ? 1 : 0);

    const detail = stderrRaw.trim()
      ? stderrRaw.trim()
      : errorCode === "ETIMEDOUT"
        ? `git timed out after ${timeoutMs}ms`
        : res.error
          ? String(res.error.message)
          : "";
    return {
      // Some runtimes hand back the *whole* buffer when the cap is hit; keep the
      // capture bounded either way.
      stdout: killedOnMaxBuffer ? stdout.slice(0, maxBytes) : stdout,
      stderr: killedOnMaxBuffer ? detail.slice(0, maxBytes) : detail,
      code,
      stdoutTruncated,
      stderrTruncated,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: String(err),
      code: 1,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
}

export function git(projectPath: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const safeArgs = safeGitArgs(args);

  if (typeof Bun !== "undefined" && typeof Bun.spawnSync === "function") {
    try {
      const res = Bun.spawnSync(["git", ...safeArgs], {
        cwd: projectPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        stdout: (res.stdout ? res.stdout.toString() : "").trim(),
        stderr: (res.stderr ? res.stderr.toString() : "").trim(),
        code: res.exitCode,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: String(err),
        code: 1,
      };
    }
  }

  try {
    const res = child_process.spawnSync("git", safeArgs, {
      cwd: projectPath,
      encoding: "utf-8",
    });
    const errorMsg = res.error ? String(res.error) : "";
    return {
      stdout: (res.stdout || "").trim(),
      stderr: (res.stderr || "").trim() || errorMsg,
      code: res.status ?? (res.error ? 1 : 0),
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: String(err),
      code: 1,
    };
  }
}

export type GitRepoState = "work-tree" | "not-a-repo" | "error";

/**
 * Three-way classification of `projectPath` with `git rev-parse
 * --is-inside-work-tree` (REV-001/REV-002), plus git's own message.
 *
 * A bare repository and a directory inside `.git` answer `false` *with exit 0*,
 * so an exit code alone cannot tell "greenfield directory" from "git already
 * knows this place", and a failure that is not git's "not a git repository"
 * (dubious ownership, permissions, git missing) must never be mistaken for a
 * directory that is safe to `git init`.
 */
export function probeGitRepo(projectPath: string): { state: GitRepoState; detail: string } {
  const res = git(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  const detail = res.stderr || res.stdout || `exit code ${res.code}`;
  if (res.code === 0) {
    if (res.stdout === "true") return { state: "work-tree", detail };
    if (res.stdout === "false") return { state: "not-a-repo", detail };
    return { state: "error", detail };
  }
  // Being outside every work tree is the only failure that means "initialize me".
  return `${res.stdout} ${res.stderr}`.toLowerCase().includes("not a git repository")
    ? { state: "not-a-repo", detail }
    : { state: "error", detail };
}

/** The tri-state alone, for callers that only branch on it. */
export function gitRepoState(projectPath: string): GitRepoState {
  return probeGitRepo(projectPath).state;
}

/** True only inside a work tree: a bare repo or `.git` itself is not one. */
export function isGitRepo(projectPath: string): boolean {
  return gitRepoState(projectPath) === "work-tree";
}

export function headCommit(projectPath: string): string | null {
  const res = git(projectPath, ["rev-parse", "HEAD"]);
  return res.code === 0 ? res.stdout : null;
}

export function pendingChanges(projectPath: string): string[] {
  const files = new Set<string>();
  const status = git(projectPath, ["status", "--porcelain"]);
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const p = line.slice(3).trim();
    if (p && !p.startsWith('.harness')) files.add(p);
  }
  const diff = git(projectPath, ["diff", "--name-only", "HEAD"]);
  for (const p of diff.stdout.split("\n")) {
    if (p && !p.startsWith('.harness')) files.add(p);
  }
  return [...files];
}

export function changedFilesSince(projectPath: string, base: string): string[] {
  const files = new Set<string>();
  const diff = git(projectPath, ["diff", "--name-only", `${base}..HEAD`]);
  for (const p of diff.stdout.split("\n")) {
    if (p && !p.startsWith(".harness")) files.add(p);
  }
  return [...files];
}

const IGNORED_DIRS = new Set([".harness", ".git", "node_modules", "dist", "build", ".DS_Store"]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt"]);

// File extensions that carry implementation logic the spec auditor should
// validate. Config/scaffolding files (package.json, tsconfig.json, lockfiles)
// are intentionally excluded so a scaffolded-but-empty repo still counts as
// greenfield.
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".rb", ".php",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".cs", ".scala", ".clj", ".cljs",
  ".ex", ".exs", ".erl", ".hrl", ".hs", ".lua", ".r", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".prisma", ".graphql", ".gql", ".proto",
  ".dart", ".zig", ".nim", ".ml", ".mli", ".fs", ".fsx", ".sol",
]);

export function inferModules(projectPath: string, base?: string): string[] {
  const files = base ? changedFilesSince(projectPath, base) : pendingChanges(projectPath);
  const modules = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 0) continue;
    if (IGNORED_DIRS.has(parts[0])) continue;
    if (parts.length === 1) {
      continue; // root-level file, not a module
    }
    const seg = Math.min(2, parts.length - 1);
    modules.add(parts.slice(0, seg).join("/"));
  }
  return [...modules];
}

export function relativeToProject(projectPath: string, file: string): string {
  return join(projectPath, file);
}

export function hasImplementationCode(projectPath: string): boolean {
  const res = git(projectPath, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (res.code !== 0) return true; // fail-safe: don't skip the audit on a real repo
  for (const raw of res.stdout.split("\n")) {
    const f = raw.trim();
    if (!f) continue;
    if (IGNORED_DIRS.has(f.split("/")[0])) continue;
    const base = f.split("/").at(-1)!;
    if (base.startsWith(".")) continue; // hidden files (e.g. .gitignore, .prettierrc)
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
    if (DOC_EXTENSIONS.has(ext)) continue;
    if (SOURCE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}
