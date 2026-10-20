import type { AgentTarget } from "../../agents/integrator.js";

/**
 * Provisioning targets with **no dedicated runtime driver** (M4b).
 *
 * Huginn separates two things that used to share one union:
 *
 * - an {@link AgentTarget} is where `huginn setup`/doctor register Muninn (13
 *   targets, unchanged);
 * - a `RuntimeId` is what the cycle actually executes (5 runtimes: `pi`,
 *   `opencode`, `codex`, `claude` and `generic`).
 *
 * The targets below keep their `AGENT_REGISTRY` row (MCP paths, rules file,
 * binary detection) but are driven by one configured
 * {@link GenericSubprocessRuntimeAdapter}. Adding a CLI-only target is therefore
 * a row here, not a new adapter class.
 */
export type GenericTarget = Exclude<AgentTarget, "pi" | "opencode" | "codex" | "claude">;

/** The declarative wiring of one generic target: binary, argv, model and permissions. */
export interface GenericTargetSpec {
  readonly target: GenericTarget;
  readonly name: string;
  /** Primary binary. */
  readonly command: string;
  /** Secondary names the CLI may install under (checked by availability only). */
  readonly fallbackCommands?: readonly string[];
  /** Base argv, before the model and permission flags. */
  readonly args: readonly string[];
  /** Native model flag (AC-27.5). */
  readonly modelArgs: (model: string) => string[];
  /** The CLI's own auto-approval switch (Phase 2C). */
  readonly permissionArgs: readonly string[];
  /** `false` marks the switch as assumed rather than verified (REV-2C-002). */
  readonly permissionArgsVerified?: boolean;
  /**
   * How the prompt reaches the CLI. Defaults to stdin; `false` selects the
   * target's own prompt file/value flag (see `GenericSubprocessOptions`).
   */
  readonly promptViaStdin?: boolean;
  readonly promptFileFlag?: string;
  readonly promptValueFlag?: string;
  /** Byte budget for the argv prompt channel (SEC-302). */
  readonly maxPromptArgLength?: number;
}

/** Cursor's auto-approval switch (`-f`, Phase 2C). */
export const CURSOR_PERMISSION_ARGS = ["-f"];

/** Antigravity CLI's auto-approval switch. */
export const AGY_PERMISSION_ARGS = ["--dangerously-skip-permissions"];

/** Command Code's auto-approval switch (`--yolo`). */
export const COMMANDCODE_PERMISSION_ARGS = ["--yolo"];

/** Devin's verified auto-approval mode (Phase 3A). */
export const DEVIN_PERMISSION_ARGS = ["--permission-mode", "dangerous"];

/**
 * Kimi's auto-approval wiring is **empty on purpose** (Phase 3C): prompt mode
 * (`kimi --prompt=<text>`) rejects every permission switch and is Never Ask by
 * construction, so adding one would make every prompt fail.
 */
export const KIMI_PERMISSION_ARGS: string[] = [];

/**
 * Prompt-mode prompts travel as the value of the prompt flag, so they are
 * bounded by the kernel's `MAX_ARG_STRLEN` (~128 KB on Linux). Measured in
 * UTF-8 bytes by the session (SEC-302).
 */
export const KIMI_MAX_PROMPT_ARG_LENGTH = 120_000;

/** MiniMax Code's `exec --permission full` switch. */
export const MCODE_PERMISSION_ARGS = ["--permission", "full"];

/** MiMo Code's `run --yolo` switch (the global `--trust` is rejected by `run`). */
export const MIMO_PERMISSION_ARGS = ["--yolo"];

/** Oh My Pi's auto-approval switch. */
export const OMP_PERMISSION_ARGS = ["--auto-approve"];

/** Qwen Code's `-y/--yolo` switch. */
export const QWEN_PERMISSION_ARGS = ["-y"];

/**
 * One row per CLI-only target. The argv is the one each adapter used to carry
 * (verified against <cli> --help / a live probe); M4b moved the rows here so the
 * eight adapter classes could be deleted without changing what is spawned.
 */
export const GENERIC_TARGET_SPECS: Record<GenericTarget, GenericTargetSpec> = {
  cursor: {
    target: "cursor",
    name: "Cursor",
    command: "cursor",
    args: [],
    // REV-003/S1: verified against no local install; conventional `--model`.
    modelArgs: (model) => ["--model", model],
    permissionArgs: CURSOR_PERMISSION_ARGS,
    permissionArgsVerified: true,
  },
  agy: {
    target: "agy",
    name: "Antigravity CLI (agy)",
    command: "agy",
    args: [],
    modelArgs: (model) => ["--model", model],
    permissionArgs: AGY_PERMISSION_ARGS,
  },
  commandcode: {
    target: "commandcode",
    name: "Command Code",
    command: "commandcode",
    fallbackCommands: ["command-code"],
    // Verified non-interactive form: `-p/--print`, prompt on stdin.
    args: ["-p"],
    modelArgs: (model) => ["-m", model],
    permissionArgs: COMMANDCODE_PERMISSION_ARGS,
  },
  devin: {
    target: "devin",
    name: "Devin",
    command: "devin",
    // Verified print-mode argv; the prompt is supplied via `--prompt-file`.
    args: ["-p", "--respect-workspace-trust", "false"],
    promptViaStdin: false,
    promptFileFlag: "--prompt-file",
    modelArgs: (model) => ["--model", model],
    permissionArgs: DEVIN_PERMISSION_ARGS,
  },
  kimi: {
    target: "kimi",
    name: "Kimi Code CLI",
    command: "kimi",
    // Prompt mode requires the prompt as the flag's value; `--prompt=` is the
    // unambiguous inline shape for a value beginning with `-` (SEC-304).
    args: [],
    promptViaStdin: false,
    promptValueFlag: "--prompt=",
    maxPromptArgLength: KIMI_MAX_PROMPT_ARG_LENGTH,
    modelArgs: (model) => ["-m", model],
    permissionArgs: KIMI_PERMISSION_ARGS,
  },
  mcode: {
    target: "mcode",
    name: "MiniMax Code",
    command: "mcode",
    // `mcode exec` needs `--input -` to read the prompt from stdin.
    args: ["exec", "--input", "-"],
    promptViaStdin: true,
    modelArgs: (model) => ["--model", model],
    permissionArgs: MCODE_PERMISSION_ARGS,
  },
  mimo: {
    target: "mimo",
    name: "MiMo Code",
    command: "mimo",
    // `mimo run` reads the prompt from stdin when no message is given.
    args: ["run"],
    promptViaStdin: true,
    modelArgs: (model) => ["--model", model],
    permissionArgs: MIMO_PERMISSION_ARGS,
  },
  omp: {
    target: "omp",
    name: "Oh My Pi",
    command: "omp",
    args: ["prompt"],
    modelArgs: (model) => ["--model", model],
    permissionArgs: OMP_PERMISSION_ARGS,
  },
  qwen: {
    target: "qwen",
    name: "Qwen Code",
    command: "qwen",
    fallbackCommands: ["qwen-code"],
    args: ["prompt"],
    modelArgs: (model) => ["-m", model],
    permissionArgs: QWEN_PERMISSION_ARGS,
  },
};

/** The CLI-only targets, in registry order. */
export const GENERIC_TARGETS = Object.keys(GENERIC_TARGET_SPECS) as GenericTarget[];

/** Narrow an arbitrary string to a {@link GenericTarget}. */
export function isGenericTarget(value: string): value is GenericTarget {
  return Object.prototype.hasOwnProperty.call(GENERIC_TARGET_SPECS, value);
}
