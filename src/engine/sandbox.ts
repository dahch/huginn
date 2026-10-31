import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Memory containment for the subprocesses huginn spawns (agents and the
 * iteration's `Verification:` commands).
 *
 * A runaway build can exhaust the host before any gate notices: a debug Rust
 * workspace compiles to gigabytes, the kernel falls back to swap, and the
 * desktop freezes instead of the phase failing. Huginn cannot make the build
 * smaller, but it can bound it — every agent prompt and every verification
 * command is launched in a **transient systemd user scope** with `MemoryMax`,
 * so a runaway process tree is killed inside its own cgroup and the run sees a
 * normal crashed/failed command instead of taking the machine down.
 *
 * Containment is opt-out, not opt-in: on Linux, with a user systemd manager and
 * `systemd-run` on `PATH`, the cap is applied automatically. The limit defaults
 * to 70 % of RAM clamped to [2 GiB, 12 GiB] and can be tuned with the
 * environment:
 *
 * - `HUGINN_MEMORY_MAX` — `off`/`none`/`0` disables the scope entirely; a size
 *   (`6G`, `512M`, bytes) overrides the automatic limit.
 * - `HUGINN_MEMORY_SWAP_MAX` — swap allowed inside the scope (default `4G`,
 *   `off` for none).
 * - `HUGINN_TASKS_MAX` — `TasksMax` for the scope (default `1024`).
 *
 * Everywhere else (macOS, Windows, a container without a user manager, root
 * without `XDG_RUNTIME_DIR`, or no `systemd-run`) the helpers return the
 * original command untouched: the cap degrades to a no-op instead of failing
 * the run.
 */

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** Share of RAM the automatic limit targets; the rest is left to the desktop. */
const DEFAULT_RAM_FRACTION = 0.7;
const MIN_MEMORY_MAX_BYTES = 2 * GIB;
const MAX_MEMORY_MAX_BYTES = 12 * GIB;

/** Swap a scoped process may still touch before the cgroup OOM killer fires. */
const DEFAULT_SWAP_MAX = "4G";
const DEFAULT_TASKS_MAX = 1024;

/** Values that mean "do not cap" for the size-valued variables. */
const DISABLED_VALUES = new Set(["off", "none", "no", "false", "0", "disabled"]);

export interface ScopeOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override the platform check (tests). */
  platform?: NodeJS.Platform;
  /** Override total RAM in bytes (tests); defaults to `os.totalmem()`. */
  totalBytes?: number;
  /** Force availability instead of probing the user manager (tests). */
  available?: boolean;
  /** Override filesystem probing (tests). */
  exists?: (path: string) => boolean;
  /** Override the uid probe (tests). */
  getuid?: () => number;
}

/** The command to spawn, either the original one or a `systemd-run` wrapper. */
export interface ScopedCommand {
  command: string;
  args: string[];
  /** True when `command`/`args` are the scope wrapper, not the payload. */
  scoped: boolean;
}

/**
 * Parse a size such as `6G`, `512M`, `1GiB` or a bare byte count.
 * Returns `undefined` for anything else, so a typo falls back to the automatic
 * limit instead of silently disabling containment.
 */
export function parseSizeBytes(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgtp]?)i?b?$/i.exec(text.trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const factors: Record<string, number> = {
    "": 1,
    K: 1024,
    M: MIB,
    G: GIB,
    T: GIB * 1024,
    P: GIB * 1024 * 1024,
  };
  const factor = factors[(match[2] ?? "").toUpperCase()] ?? 1;
  return Math.round(value * factor);
}

/** Render a byte count the way systemd accepts it (`11G`, `900M`). */
export function formatSizeBytes(bytes: number): string {
  if (bytes >= GIB) return `${Math.max(1, Math.round(bytes / GIB))}G`;
  return `${Math.max(1, Math.round(bytes / MIB))}M`;
}

/**
 * Resolve the effective `MemoryMax` value, or `undefined` when containment is
 * disabled. An unset or unparsable `HUGINN_MEMORY_MAX` yields the automatic
 * limit (70 % of RAM, clamped); only an explicit off-value disables the cap.
 */
export function resolveMemoryMax(options: ScopeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const raw = (env.HUGINN_MEMORY_MAX ?? "").trim();
  if (raw !== "" && DISABLED_VALUES.has(raw.toLowerCase())) return undefined;
  if (raw !== "") {
    const explicit = parseSizeBytes(raw);
    if (explicit !== undefined) return formatSizeBytes(explicit);
  }
  const total = options.totalBytes ?? totalmem();
  const target = Math.min(
    Math.max(total * DEFAULT_RAM_FRACTION, MIN_MEMORY_MAX_BYTES),
    MAX_MEMORY_MAX_BYTES,
  );
  return formatSizeBytes(target);
}

/** Resolve `MemorySwapMax`, or `undefined` when swap must not be granted. */
export function resolveSwapMax(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = (env.HUGINN_MEMORY_SWAP_MAX ?? "").trim();
  if (raw === "") return DEFAULT_SWAP_MAX;
  if (DISABLED_VALUES.has(raw.toLowerCase())) return undefined;
  const explicit = parseSizeBytes(raw);
  return explicit === undefined ? DEFAULT_SWAP_MAX : formatSizeBytes(explicit);
}

/** Resolve `TasksMax` for the scope. */
export function resolveTasksMax(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.HUGINN_TASKS_MAX ?? "").trim();
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TASKS_MAX;
}

/** Absolute path of `systemd-run`, or `undefined` when it is not installed. */
export function findSystemdRun(options: ScopeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "systemd-run");
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Whether a transient **user** scope can be created right now: Linux, a
 * non-root uid and a reachable user manager socket. Root is excluded because
 * `systemd-run --user` needs `XDG_RUNTIME_DIR`/a user bus that a root shell
 * rarely has; the fallback (no cap) is better than a failed spawn.
 */
export function userScopeAvailable(options: ScopeOptions = {}): boolean {
  if (options.available !== undefined) return options.available;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return false;
  const getuid = options.getuid ?? (() => process.getuid?.() ?? 0);
  const uid = getuid();
  if (uid === 0) return false;
  const env = options.env ?? process.env;
  const runtimeDir = env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  const exists = options.exists ?? existsSync;
  return exists(join(runtimeDir, "systemd", "private"));
}

/**
 * Escape a payload argument for systemd's `ExecStart` expansion.
 *
 * `systemd-run` builds a transient unit from the argv it is given, and systemd
 * expands `$VAR`/`${VAR}` there, using `$$` as the escape for a literal `$`.
 * Without this, a verification command such as `kill -SEGV $$` would reach the
 * shell as `kill -SEGV $` and mean something else entirely. Doubling every `$`
 * makes systemd's single expansion pass hand the payload its original text.
 */
export function escapeSystemdArgument(value: string): string {
  // Function replacement: "$" and "$$" are replacement *patterns* in
  // String.replaceAll, so the string form would collapse "$$" back to "$".
  return value.replaceAll("$", () => "$$");
}

/** Wrap a command so it runs inside a memory-capped scope, when possible. */
export function planScopedCommand(
  command: string,
  args: string[],
  options: ScopeOptions = {},
): ScopedCommand {
  const memoryMax = resolveMemoryMax(options);
  if (memoryMax === undefined || !userScopeAvailable(options)) {
    return { command, args, scoped: false };
  }
  const systemdRun = findSystemdRun(options);
  if (systemdRun === undefined) return { command, args, scoped: false };

  const env = options.env ?? process.env;
  const argv = ["--user", "--scope", "--quiet", "--collect", "-p", `MemoryMax=${memoryMax}`];
  const swapMax = resolveSwapMax(env);
  if (swapMax !== undefined) argv.push("-p", `MemorySwapMax=${swapMax}`);
  argv.push(
    "-p",
    `TasksMax=${resolveTasksMax(env)}`,
    "--",
    escapeSystemdArgument(command),
    ...args.map(escapeSystemdArgument),
  );
  return { command: systemdRun, args: argv, scoped: true };
}

/** POSIX single-quote `text`, so the outer shell passes it through untouched. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrapper that keeps a signal death visible to the caller.
 *
 * Older systemd releases (255, as shipped on ubuntu-24.04 CI runners) return a
 * plain `1` from `systemd-run --scope` when the payload dies from a signal,
 * while newer ones report `128+n`. Running the payload in a nested `/bin/sh -c`
 * makes it a *child* of this shell: `exit` without an argument then exits with
 * the child's `128+n` status, which every systemd version propagates as a plain
 * exit code and {@link signalFromExitCode} maps back to the signal.
 *
 * The wrapper deliberately carries no shell variables: systemd expands `$…`
 * in `ExecStart` and older releases do not honour the `$$` escape the same way,
 * which would erase `$?`/`$1`. Only the payload keeps its own `$`, escaped by
 * {@link escapeSystemdArgument}.
 */
function signalStatusWrapper(command: string): string {
  return `/bin/sh -c ${shellQuote(command)}\nexit`;
}

/**
 * Plan a **shell** command (`Verification:` lines run through `/bin/sh -c`).
 *
 * When scoped, the scope runs a shell that executes the payload in a nested
 * shell, so the caller must spawn with `shell: false`. When not scoped, the
 * original command is returned with no arguments and the caller keeps
 * `shell: true` — the behaviour is unchanged.
 */
export function planScopedShellCommand(command: string, options: ScopeOptions = {}): ScopedCommand {
  const scoped = planScopedCommand("/bin/sh", ["-c", signalStatusWrapper(command)], options);
  return scoped.scoped ? scoped : { command, args: [], scoped: false };
}
