#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import {
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_THINKER_MODEL,
  describeModelSources,
  loadConfigLayers,
  resolveModelsFromConfig,
  type RunConfig,
} from "./config";
import { MAIN_PHASES, type PhaseName } from "./engine/types";
import {
  DEFAULT_PROFILE,
  isProfileName,
  PROFILE_NAMES,
  PROFILE_PHASES,
  type ProfileName,
} from "./engine/profiles";
import { loadPlan } from "./plan/parser";
import {
  loadState,
  freshState,
  computePlanHash,
  clearStaleHarness,
} from "./state/store";
import { CycleEngine } from "./engine/cycle";
import { subscribeToEvents } from "./engine/permissions";
import { events } from "./engine/engineEvents";
import { printBanner, type BannerInfo } from "./banner";
import { runPlanMode } from "./engine/planMode";
import { LiveEngine } from "./engine/liveMode";
import { maybePrintUpdateReminder } from "./update";
import { resolveAgent, getAgentRuntime, OpencodeRuntimeAdapter } from "./engine/agent/index.js";
import type { AgentTarget } from "./agents/integrator.js";
import {
  describeTemplates,
  getMissing,
  getOpencodeConfigDir,
  installTemplates,
  listInstalled,
  listTemplates,
  promptYesNo,
  type TemplateKind,
} from "./setup/install";
import { handleMemoryCommand, handleMcpCommand } from "./commands/memory";
import { handleConfigCommand } from "./commands/config";
import { handleCheckCommand } from "./commands/check";
import { handleDoctorCommand, handleSetupCommand } from "./commands/setup";
import { handleInitCommand, printInitUsage } from "./commands/init.js";

/**
 * Concise two-tier help (REQ-26 / AC-26.2): the Core commands and the flags a
 * new developer actually needs, with a pointer to {@link usage} for the full
 * reference. `huginn --help` prints this; `huginn --help --all` prints
 * {@link usage}. The Core list is a *subset* of the full reference — the
 * drift-guard test in `test/commands/init.test.ts` asserts every token listed
 * here also exists in {@link usage}.
 */
export function usageCore(): string {
  return `huginn — the raven that thinks, builds, and remembers.
Orchestrator for the opencode spec→commit cycle.

Usage:
  huginn "<idea>"      live-first default: refine the idea, draft the docs, approve, build
  huginn <command>     run an explicit command (see "Core commands")

Core commands:
  live     interactive refinement + autonomous execution in one dashboard
  run      execute the build cycle against plan.md/spec.md/adr.md
  init     guided onboarding: agent, models, Muninn MCP and .huginn/config.json
  setup    register the Muninn MCP + rules with Cursor, Claude, OpenCode, Windsurf, …
  doctor   diagnose the local environment, providers and Muninn database

Examples:
  huginn "add a checkout flow with Stripe"    live-first build from an idea
  huginn init                                 configure this repository
  huginn run --project . --thinker anthropic/claude-opus-4-5
  huginn doctor                               check the local environment

Common flags:
  --project <path>     target repository                          (default: cwd)
  --thinker <model>    model that plans/fixes findings            (default: ${DEFAULT_THINKER_MODEL})
  --executor <model>   model used for everything else             (default: ${DEFAULT_EXECUTOR_MODEL})
  --agent <target>     agent runtime: opencode, claude, codex, omp, …
  --tui | --headless   interactive dashboard vs stdout logs       (default: tui if TTY)
  --force              overwrite existing documents/files
  --yes                accept defaults and never prompt (non-interactive / CI)

More:
  huginn --help --all  run this for advanced options: every command, flag and default
`;
}

/**
 * Full reference help: every subcommand, flag and default, plus the model
 * resolution order. Kept byte-stable as the documented `--all` output and the
 * long-form reference other tools and tests rely on.
 */
export function usage(): string {
  return `huginn — the raven that thinks, builds, and remembers.
Orchestrator for the opencode spec→commit cycle.

Usage:
  huginn "<idea>" [flags]     live-first default: refine the idea, draft the docs, approve, build
  huginn run [flags]          explicit build-cycle execution (CI/batch)
  huginn init [--yes] [--skip-setup] [flags]  guided onboarding wizard (agent, models, MCP, config)
  huginn plan --project <repo> --thinker <provider/model> "<idea>" [flags]
  huginn live [flags]         explicit live mode ["<idea>"]
  huginn install [--yes] [--force] [--only agents|commands]
  huginn memory init [--db <path>] [--project <path>]
  huginn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]
  huginn memory sync [--import] [--file <path>] [--project <path>]
  huginn memory index [files...] [--project <path>] [--db <path>]
  huginn check [files...] [--project <path>]
  huginn setup [--agent <t1,t2|all>] [--installed] [--status] [--dry-run] [--project <path>] [--force]
  huginn doctor [--project <path>] [--home <path>] [--opencode-config-dir <path>]
  huginn mcp run [--db <path>] [--project <path>]
  huginn config show [--project <path>] [--home <path>]
  huginn config set [--thinker <m>] [--executor <m>] [--global] [--project <path>] [--home <path>]

Default (live-first):
  Running huginn with no known subcommand — including a bare free-text idea such
  as \`huginn "crear módulo de pagos"\` — enters live mode. The project defaults
  to the current working directory and the models are resolved from configuration
  (see "Model resolution" below) instead of requiring flags.

Commands:
  run     execute the build cycle against plan.md/spec.md/adr.md
  init    guided onboarding wizard: detects the git repo, package manager and
          agent CLIs, prompts for the default agent and models, registers the
          Muninn MCP with \`setup\` and writes <project>/.huginn/config.json
  plan    use the thinker to draft spec.md, adr.md and plan.md from an idea
  live    interactive refinement + autonomous execution: chat-refine the idea
          (or extend an existing project), draft/update spec.md/adr.md/plan.md,
          approve, then run the build cycles in the same dashboard
  setup   register Muninn MCP + rules with Cursor, Claude, OpenCode and Windsurf
  doctor  diagnose the local environment, providers and Muninn database
  check   verify TypeScript execution contracts and pre-emit diagnostics
  install install the opencode subagents and slash commands huginn needs into
          ~/.config/opencode (agents/ and commands/)
  memory  query and manage persistent codebase memory (init, search, sync, index)
  mcp     start the Muninn MCP server for agent memory integration (run)
  config  inspect and persist thinker/executor configuration (show, set)

Model resolution (run/live):
  Models are resolved in strict precedence order, first non-empty value wins:
    1. CLI flag          --thinker <m> / --executor <m>
    2. project config    <project>/.huginn/config.json  ({ "thinker", "executor" })
    3. user config       ~/.huginn/config.json
    4. environment       HUGINN_THINKER_MODEL / HUGINN_EXECUTOR_MODEL
    5. defaults          thinker: anthropic/claude-opus-4-5
                         executor: opencode/gpt-5.1-codex

Required (run):
  --project <path>      git repo being built (must contain plan.md, spec.md, adr.md)  (default: cwd)
  --thinker <m>         "thinking" model used to FIX findings (auditor + reviewer + any blocker)
  --executor <m>        model used for everything else (execution, gates, docs, commits)

Required (plan):
  --project <path>      git repo where spec.md/adr.md/plan.md will be written
  --thinker <m>         model that drafts the three documents
  <idea>                prompt/idea describing what should be built
  --prompt-file <file>  alternative to <idea> for long prompts (reads the file)

Required (live):
  --project <path>      git repo being built/iterated (docs are drafted if missing)  (default: cwd)
  --thinker <m>         model that refines the idea and drafts the documents
  --executor <m>        model used for the build cycles after approval
  <idea>                optional initial idea; in the TUI you can also type it
                        in the chat and refine it together before /draft
  --prompt-file <file>  alternative to <idea> for long prompts (reads the file)

Optional:
  --plan <file>         default: <project>/plan.md
  --spec <file>         default: <project>/spec.md
  --adr <file>          default: <project>/adr.md
  --force               (plan only) overwrite existing spec.md/adr.md/plan.md
  --profile <id>        Methodology: ${PROFILE_NAMES.join(", ")} (default: huginn)
  --mode auto|supervised   auto=autonomous with retry budget; supervised=ask at every gate  (default: auto)
  --permissions auto|ask|deny  auto-approve tool permissions  (default: auto)
  --max-retries <n>     fix attempts per blocked gate before escalating  (default: 3)
  --from-iteration <n>  start at iteration n
  --only-phase <name>   run a single phase per iteration (debugging)
  --sandbox             run each iteration in an isolated git worktree sandbox  (default)
  --no-sandbox          run iterations in place (disables worktree sandboxing)
  --resume              resume from saved state; errors if no saved state exists
  --force-restart       discard saved state and start over
  --ignore-plan-changes resume even if plan.md/spec.md/adr.md changed
  --tui | --headless    interactive dashboard vs stdout logs  (default: tui if TTY)
  --port <n>            port for the opencode server  (default: free port)
  --server-timeout <ms> server startup timeout  (default: 60000)
  --phase-timeout <ms>  hard deadline per phase step (0 disables)  (default: 1200000, 20 min)
  --agent <target>      target agent runtime (opencode, claude, codex, omp, etc.)
  --choose-model        open the interactive model selector on startup

Install:
  --yes                 install without asking (non-interactive / CI)
  --force               overwrite existing files in ~/.config/opencode (default: never)
  --only agents|commands  restrict the install to subagents or slash commands only
`;
}

export interface ParsedArgs {
  [key: string]: string | boolean | undefined | string[];
  _command?: string;
  _positional?: string;
  _positionals?: string[];
}

const BOOLEAN_FLAGS = new Set([
  "--yes",
  "--force",
  "--resume",
  "--force-restart",
  "--ignore-plan-changes",
  "--tui",
  "--headless",
  "--import",
  "--sandbox",
  "--no-sandbox",
  "--global",
  "--choose-model",
  "--skip-setup",
  "--all",
  "--installed",
  "--status",
  "--dry-run",
  "--help",
  "-h",
]);

/**
 * Subcommands that keep explicit routing. Anything else (no command, or a
 * free-text idea positional) is treated as live-first input (REQ-14.4).
 */
const KNOWN_COMMANDS = new Set([
  "run",
  "plan",
  "live",
  "init",
  "install",
  "memory",
  "mcp",
  "check",
  "setup",
  "doctor",
  "config",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    _positionals: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("-") && arg !== "-") {
      const eq = arg.indexOf("=");
      let key = arg;
      let value: string | boolean = true;
      if (eq !== -1) {
        key = arg.slice(0, eq);
        value = arg.slice(eq + 1);
      } else if (!BOOLEAN_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (
          next !== undefined &&
          (!next.startsWith("-") || /^-\d+(\.\d+)?$/.test(next))
        ) {
          value = next;
          i++;
        }
      }
      out[key] = value;
    } else if (out._command === undefined) {
      out._command = arg;
    } else {
      out._positional = arg;
      (out._positionals as string[]).push(arg);
    }
  }
  return out;
}

export function num(v: unknown, fallback: number): number {
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // clamp so negative values (e.g. --max-retries -1) can never silently skip
  // a phase or invert a loop
  return Math.max(0, n);
}

/**
 * Resolve a path and follow symlinks so that paths huginn embeds in agent
 * prompts match the canonical directory the opencode server resolves. Falls
 * back to `resolve()` when the path does not exist yet (e.g. plan mode before
 * the documents are drafted).
 */
export function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * A repository is "greenfield" for huginn when it has never run a huginn
 * command: the `.huginn/` directory is created by every stateful command
 * (`init`, `config set`, `memory`, `live`), so its absence is the signal that
 * the developer has not been onboarded yet (AC-26.1, requirement 3).
 */
export function isGreenfieldLaunch(projectPath: string): boolean {
  return !existsSync(join(projectPath, ".huginn"));
}

/**
 * Flags that request no work and no mode (target paths and the
 * non-interactive switch), so a bare first-run launch may still carry them.
 * Kept in sync with {@link BOOLEAN_FLAGS}: each entry is either a boolean
 * switch declared there or a value-taking path flag.
 */
const BENIGN_BARE_FLAGS = new Set(["--project", "--home", "--opencode-config-dir", "--yes"]);

/**
 * Decide whether a bare live-first invocation should be replaced by the init
 * wizard: only when there is no subcommand at all, no free-text idea
 * positional, no work/mode flag (AC-26.1 scopes onboarding to a *bare* launch)
 * and the target project has never run huginn. An explicit idea, an explicit
 * flag such as `--headless`/`--resume`, or an already configured project keeps
 * the documented live-first behavior.
 */
export function shouldLaunchInit(args: ParsedArgs, projectPath: string): boolean {
  if (args._command !== undefined || args._positional !== undefined) return false;
  if (args["--help"] || args["-h"]) return false;
  for (const key of Object.keys(args)) {
    if (key.startsWith("-") && !BENIGN_BARE_FLAGS.has(key)) return false;
  }
  return isGreenfieldLaunch(projectPath);
}

/** True only on a real interactive terminal and outside CI. */
function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !process.env.CI;
}

/**
 * Greenfield launch ergonomics (iteration 24, bullet 3): instead of failing with
 * "not a git repository" or dumping template warnings, an unconfigured
 * repository gets the onboarding wizard (TTY) or a short pointer to
 * `huginn init` (non-interactive). The pointer itself never exits non-zero —
 * it is guidance; on a TTY the delegated wizard still reports a failed step
 * (e.g. MCP registration) through `process.exitCode` (REV-201).
 */
export async function handleGreenfieldLaunch(
  args: ParsedArgs,
  projectPath: string,
  deps: { interactive?: boolean } = {},
): Promise<void> {
  if (deps.interactive ?? isInteractiveTerminal()) {
    // The wizard and the pointer below must name the same directory: forward the
    // canonical path `main()` already resolved both as the `--project` flag (the
    // wizard's first choice, so a raw/relative flag cannot win) and as the
    // `projectPath` default used by a truly bare launch (REV-210).
    await handleInitCommand(
      { ...(args as Record<string, string | boolean | undefined>), "--project": projectPath },
      { projectPath },
    );
    return;
  }
  console.log(
    `[huginn] ${projectPath} has not been set up for huginn yet.\n` +
      `  Run \`huginn init\` to detect your agent CLIs, choose the agent/models and ` +
      `register the Muninn MCP.\n` +
      `  Or pass an idea directly: huginn "<idea>".\n` +
      `  Run \`huginn --help\` for the command overview.`,
  );
}

async function getFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 4096;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const command = args._command;
  if (command === "help" || args["--help"] || args["-h"]) {
    printBanner({});
    if (command === "init") {
      printInitUsage();
    } else if (args["--all"]) {
      console.log(usage());
    } else {
      console.log(usageCore());
    }
    return;
  }
  if (command === "plan") {
    await runPlan(args);
    return;
  }
  if (command === "init") {
    await handleInitCommand(args as Record<string, string | boolean | undefined>);
    return;
  }
  if (command === "live") {
    await runLive(args);
    return;
  }
  if (command === "install") {
    await runInstall(args);
    return;
  }
  if (command === "memory") {
    const positionals = (args._positionals as string[] | undefined) ?? [];
    const subcommand =
      typeof positionals[0] === "string"
        ? positionals[0]
        : (typeof args._positional === "string" ? args._positional : undefined);
    const restPositionals = positionals.slice(1);
    await handleMemoryCommand(
      subcommand,
      args as Record<string, string | boolean | undefined>,
      restPositionals
    );
    return;
  }
  if (command === "mcp") {
    const positionals = (args._positionals as string[] | undefined) ?? [];
    const subcommand =
      typeof positionals[0] === "string"
        ? positionals[0]
        : (typeof args._positional === "string" ? args._positional : undefined);
    await handleMcpCommand(
      subcommand,
      args as Record<string, string | boolean | undefined>
    );
    return;
  }
  if (command === "config") {
    const positionals = (args._positionals as string[] | undefined) ?? [];
    const subcommand =
      typeof positionals[0] === "string"
        ? positionals[0]
        : (typeof args._positional === "string" ? args._positional : undefined);
    await handleConfigCommand(
      subcommand,
      args as Record<string, string | boolean | undefined>
    );
    return;
  }
  if (command === "check") {
    const positionals = (args._positionals as string[] | undefined) ?? [];
    const files =
      positionals.length > 0
        ? positionals
        : typeof args._positional === "string" && args._positional !== "check"
          ? [args._positional]
          : [];
    await handleCheckCommand(
      files,
      args as Record<string, string | boolean | undefined>
    );
    return;
  }
  if (command === "setup") {
    await handleSetupCommand(args as Record<string, string | boolean | undefined>);
    return;
  }
  if (command === "doctor") {
    await handleDoctorCommand(args as Record<string, string | boolean | undefined>);
    return;
  }
  // Live-first default (REQ-14.4): an unknown/absent subcommand — including a
  // free-text idea such as `huginn "crear módulo"` — enters live mode. A bare
  // invocation inside a repository that never ran huginn is the one exception:
  // it onboards through `huginn init` instead of failing (AC-26.1).
  if (command === undefined || !KNOWN_COMMANDS.has(command)) {
    const projectPath = canonicalize(
      typeof args["--project"] === "string" ? args["--project"] : process.cwd(),
    );
    if (shouldLaunchInit(args, projectPath)) {
      await handleGreenfieldLaunch(args, projectPath);
      return;
    }
    await runLive(args, command);
    return;
  }

  const projectPath = canonicalize(
    typeof args["--project"] === "string" ? args["--project"] : process.cwd()
  );
  const layers = loadConfigLayers(projectPath);
  const { thinker, executor } = resolveModelsFromConfig({
    flagThinker: typeof args["--thinker"] === "string" ? args["--thinker"] : undefined,
    flagExecutor: typeof args["--executor"] === "string" ? args["--executor"] : undefined,
    projectConfig: layers.project,
    userConfig: layers.user,
  });

  if (!existsSync(join(projectPath, ".git"))) {
    console.error(`"${projectPath}" is not a git repository.`);
    process.exit(1);
  }

  const resolvedAgent = await resolveAgent({
    flagAgent: typeof args["--agent"] === "string" ? args["--agent"] : undefined,
    projectConfig: layers.project,
    userConfig: layers.user,
  });

  const cfg: RunConfig = {
    projectPath,
    planPath: canonicalize(resolve(join(projectPath, String(args["--plan"] ?? "plan.md")))),
    specPath: canonicalize(resolve(join(projectPath, String(args["--spec"] ?? "spec.md")))),
    adrPath: canonicalize(resolve(join(projectPath, String(args["--adr"] ?? "adr.md")))),
    thinker,
    executor,
    agent: resolvedAgent,
    mode: args["--mode"] === "supervised" ? "supervised" : "auto",
    profile: resolveProfile(args["--profile"], layers.project.profile ?? layers.user.profile),
    permissions:
      args["--permissions"] === "ask"
        ? "ask"
        : args["--permissions"] === "deny"
          ? "deny"
          : "auto",
    maxRetries: num(args["--max-retries"], 3),
    fromIteration: typeof args["--from-iteration"] === "string" ? num(args["--from-iteration"], 1) : undefined,
    onlyPhase: typeof args["--only-phase"] === "string" ? validatePhase(args["--only-phase"]) : undefined,
    tui: args["--headless"] ? false : args["--tui"] ? true : process.stdout.isTTY,
    port: num(args["--port"], 0),
    serverTimeoutMs: num(args["--server-timeout"], 60000),
    phaseTimeoutMs: num(args["--phase-timeout"], 20 * 60 * 1000),
    ignorePlanChanges: Boolean(args["--ignore-plan-changes"]),
    chooseModel: Boolean(args["--choose-model"]),
    sandbox: !args["--no-sandbox"],
  };

  for (const [name, path] of [
    ["plan", cfg.planPath],
    ["spec", cfg.specPath],
    ["adr", cfg.adrPath],
  ] as const) {
    if (!existsSync(path)) {
      console.error(`Missing ${name} file: ${path}`);
      process.exit(1);
    }
  }

  const plan = loadPlan(cfg.planPath);
  const planHash = computePlanHash([cfg.planPath, cfg.specPath, cfg.adrPath]);
  const existing = loadState(projectPath);
  if (args["--resume"] && !existing) {
    console.error("No saved harness state to resume. Run without --resume to start fresh.");
    process.exit(1);
  }
  warnIfMissingTemplates(cfg.tui);

  let state;
  if (args["--force-restart"]) {
    clearStaleHarness(projectPath);
    state = undefined;
  } else if (existing) {
    if (existing.planHash !== planHash && !cfg.ignorePlanChanges) {
      console.error(
        `Saved harness state does not match the current plan/spec/adr.\n` +
          `  - Pass --force-restart to discard saved progress.\n` +
          `  - Pass --ignore-plan-changes to resume anyway.`,
      );
      process.exit(1);
    }
    state = { ...existing, models: { thinker, executor }, mode: cfg.mode };
  }

  const bannerInfo: BannerInfo = {
    thinker,
    executor,
    projectPath,
    iteration: state ? state.currentIteration : 1,
    totalIterations: plan.iterations.length,
    phase: state ? state.currentPhase : "START",
  };

  if (!cfg.tui) {
    printBanner(bannerInfo);
    void maybePrintUpdateReminder();
    console.log(
      `[huginn] project=${projectPath}\n` +
        `[huginn] agent=${cfg.agent} thinker=${thinker} executor=${executor} mode=${cfg.mode} profile=${cfg.profile ?? DEFAULT_PROFILE} max-retries=${cfg.maxRetries}\n` +
        `[huginn] iterations=${plan.iterations.length}` +
        (state ? ` (resuming at iteration ${state.currentIteration}, phase ${state.currentPhase})` : ""),
    );
  } else {
    events.emit("log", {
      level: "info",
      message:
        `project=${projectPath} agent=${cfg.agent} thinker=${thinker} executor=${executor} mode=${cfg.mode} ` +
        `iterations=${plan.iterations.length}` +
        (state ? ` (resuming at iteration ${state.currentIteration}, phase ${state.currentPhase})` : ""),
    });
  }

  if (cfg.port === 0) cfg.port = await getFreePort();

  const runtime = getAgentRuntime(resolvedAgent as AgentTarget, {
    projectPath,
    port: cfg.port,
    serverTimeoutMs: cfg.serverTimeoutMs,
  });

  try {
    await runtime.startDaemon?.();
  } catch (err) {
    console.error(chalk.red(`[huginn] failed to start ${runtime.name} daemon: ${(err as Error).message}`));
    process.exit(1);
  }

  const serverUrl = runtime instanceof OpencodeRuntimeAdapter ? runtime.serverUrl : undefined;
  if (serverUrl) {
    if (!cfg.tui) {
      console.log(`${chalk.green("✓")} ${chalk.dim("opencode server ready at")} ${chalk.cyan(serverUrl)}`);
    } else {
      events.emit("log", {
        level: "info",
        message: `opencode server ready at ${serverUrl}`,
      });
    }
  }

  const engine = new CycleEngine({ cfg, plan, state, runtime });
  if (runtime.id === "opencode" && engine.client) {
    await validateModels(engine.client, cfg);
  }
  const sub = runtime.id === "opencode" && engine.client
    ? subscribeToEvents(engine.client, cfg, (req) => engine.ask(req))
    : { close: () => {} };

  const cleanup = async (code: number) => {
    sub.close();
    await runtime.stopDaemon?.();
    process.exit(code);
  };
  process.on("SIGINT", async () => {
    engine.requestAbort();
    try {
      engine.cleanupSandboxes();
    } catch {
      // best-effort
    }
    setTimeout(() => void cleanup(1), 3000).unref();
  });
  process.on("SIGTERM", async () => {
    engine.requestAbort();
    try {
      engine.cleanupSandboxes();
    } catch {
      // best-effort
    }
    setTimeout(() => void cleanup(1), 3000).unref();
  });

  try {
    if (cfg.tui) {
      const { runTui } = await import("./tui/app");
      await runTui(engine, cfg);
    } else {
      const { runHeadless } = await import("./headless");
      await runHeadless(engine);
    }
    const outcome = engine.getOutcome();
    console.log(
      outcome.reason === "completed"
        ? chalk.green.bold(`\n✨ [huginn] Plan completed successfully!`)
        : outcome.reason === "aborted"
          ? chalk.yellow.bold(`\n🛑 [huginn] Run aborted. State saved for --resume.`)
          : chalk.red.bold(`\n✗ [huginn] Run failed: ${outcome.error}`),
    );
  } catch (err) {
    console.error(chalk.red(`[huginn] fatal: ${(err as Error).message}`));
  } finally {
    sub.close();
    await runtime.stopDaemon?.();
  }
}

async function runPlan(args: ParsedArgs): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printBanner({});
    console.log(usage());
    return;
  }
  const projectPath = canonicalize(
    typeof args["--project"] === "string" ? args["--project"] : ""
  );
  if (!projectPath) {
    console.error("Missing required --project.\n\n" + usage());
    process.exit(1);
  }
  const thinker = typeof args["--thinker"] === "string" ? args["--thinker"] : "";
  if (!thinker) {
    console.error("Missing required --thinker.\n\n" + usage());
    process.exit(1);
  }
  warnIfMissingTemplates();
  if (!existsSync(join(projectPath, ".git"))) {
    console.error(`"${projectPath}" is not a git repository.`);
    process.exit(1);
  }

  const promptFile =
    typeof args["--prompt-file"] === "string" ? args["--prompt-file"] : "";
  let idea: string;
  if (promptFile) {
    const p = resolve(promptFile);
    if (!existsSync(p)) {
      console.error(`Prompt file not found: ${p}`);
      process.exit(1);
    }
    idea = await Bun.file(p).text();
  } else {
    idea = String(args._positional ?? "").trim();
  }
  if (!idea) {
    console.error("Missing idea. Pass a prompt as the last argument or use --prompt-file.\n\n" + usage());
    process.exit(1);
  }

  const specPath = canonicalize(resolve(join(projectPath, String(args["--spec"] ?? "spec.md"))));
  const adrPath = canonicalize(resolve(join(projectPath, String(args["--adr"] ?? "adr.md"))));
  const planPath = canonicalize(resolve(join(projectPath, String(args["--plan"] ?? "plan.md"))));

  const force = Boolean(args["--force"]);
  const existing = [
    ["spec", specPath],
    ["adr", adrPath],
    ["plan", planPath],
  ].filter(([, p]) => existsSync(p));
  if (!force && existing.length > 0) {
    console.error(
      `Refusing to overwrite existing document(s): ${existing.map(([n, p]) => `${n} (${p})`).join(", ")}.\n` +
        `  - Pass --force to overwrite them.`,
    );
    process.exit(1);
  }

  printBanner({ thinker, projectPath, phase: "PLAN" });

  void maybePrintUpdateReminder();

  let port = num(args["--port"], 0);
  if (port === 0) port = await getFreePort();
  const serverTimeoutMs = num(args["--server-timeout"], 60000);
  await runPlanMode({ projectPath, idea, thinker, specPath, adrPath, planPath, port, serverTimeoutMs });
}

async function runLive(args: ParsedArgs, ideaOverride?: string): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printBanner({});
    console.log(usage());
    return;
  }
  const projectPath = canonicalize(
    typeof args["--project"] === "string" ? args["--project"] : process.cwd()
  );
  const layers = loadConfigLayers(projectPath);
  const modelSources = describeModelSources({
    flagThinker: typeof args["--thinker"] === "string" ? args["--thinker"] : undefined,
    flagExecutor: typeof args["--executor"] === "string" ? args["--executor"] : undefined,
    projectConfig: layers.project,
    userConfig: layers.user,
  });
  const thinker = modelSources.thinker.value;
  const executor = modelSources.executor.value;
  if (!existsSync(join(projectPath, ".git"))) {
    console.error(`"${projectPath}" is not a git repository.`);
    process.exit(1);
  }

  const promptFile =
    typeof args["--prompt-file"] === "string" ? args["--prompt-file"] : "";
  let idea: string;
  if (promptFile) {
    const p = resolve(promptFile);
    if (!existsSync(p)) {
      console.error(`Prompt file not found: ${p}`);
      process.exit(1);
    }
    idea = await Bun.file(p).text();
  } else if (ideaOverride !== undefined) {
    idea = ideaOverride.trim();
  } else {
    idea = String(args._positional ?? "").trim();
  }

  const resolvedAgent = await resolveAgent({
    flagAgent: typeof args["--agent"] === "string" ? args["--agent"] : undefined,
    projectConfig: layers.project,
    userConfig: layers.user,
  });

  const cfg: RunConfig = {
    projectPath,
    planPath: canonicalize(resolve(join(projectPath, String(args["--plan"] ?? "plan.md")))),
    specPath: canonicalize(resolve(join(projectPath, String(args["--spec"] ?? "spec.md")))),
    adrPath: canonicalize(resolve(join(projectPath, String(args["--adr"] ?? "adr.md")))),
    thinker,
    executor,
    agent: resolvedAgent,
    mode: args["--mode"] === "supervised" ? "supervised" : "auto",
    profile: resolveProfile(args["--profile"], layers.project.profile ?? layers.user.profile),
    permissions:
      args["--permissions"] === "ask"
        ? "ask"
        : args["--permissions"] === "deny"
          ? "deny"
          : "auto",
    maxRetries: num(args["--max-retries"], 3),
    fromIteration: typeof args["--from-iteration"] === "string" ? num(args["--from-iteration"], 1) : undefined,
    onlyPhase: typeof args["--only-phase"] === "string" ? validatePhase(args["--only-phase"]) : undefined,
    tui: args["--headless"] ? false : args["--tui"] ? true : process.stdout.isTTY,
    port: num(args["--port"], 0),
    serverTimeoutMs: num(args["--server-timeout"], 60000),
    phaseTimeoutMs: num(args["--phase-timeout"], 20 * 60 * 1000),
    ignorePlanChanges: Boolean(args["--ignore-plan-changes"]),
    chooseModel: Boolean(args["--choose-model"]),
    sandbox: !args["--no-sandbox"],
  };

  warnIfMissingTemplates(cfg.tui);

  if (!cfg.tui) {
    printBanner({ thinker, executor, projectPath, iteration: 1, phase: "LIVE" });
    void maybePrintUpdateReminder();
    console.log(
      `[huginn] live mode · project=${projectPath}\n` +
        `[huginn] agent=${cfg.agent} thinker=${thinker} executor=${executor} mode=${cfg.mode} profile=${cfg.profile ?? DEFAULT_PROFILE} max-retries=${cfg.maxRetries}` +
        (idea ? `\n[huginn] initial idea: ${idea.slice(0, 80)}${idea.length > 80 ? "…" : ""}` : ""),
    );
  } else {
    events.emit("log", {
      level: "info",
      message:
        `live mode · project=${projectPath} agent=${cfg.agent} thinker=${thinker} executor=${executor} mode=${cfg.mode} profile=${cfg.profile ?? DEFAULT_PROFILE}` +
        (idea ? ` initial idea: ${idea.slice(0, 80)}${idea.length > 80 ? "…" : ""}` : ""),
    });
  }

  if (cfg.port === 0) cfg.port = await getFreePort();

  const runtime = getAgentRuntime(resolvedAgent as AgentTarget, {
    projectPath,
    port: cfg.port,
    serverTimeoutMs: cfg.serverTimeoutMs,
  });

  try {
    await runtime.startDaemon?.();
  } catch (err) {
    console.error(chalk.red(`[huginn] failed to start ${runtime.name} daemon: ${(err as Error).message}`));
    process.exit(1);
  }

  // Pre-flight model check: if thinker or executor came from default source, check if runtime.getAvailableModels()
  // returns models and whether defaults are present. If models are returned and neither default is present,
  // set cfg.chooseModel = true for auto-onboarding! (REV-003)
  if (modelSources.thinker.source === "default" || modelSources.executor.source === "default") {
    try {
      const models = await runtime.getAvailableModels();
      if (models && models.length > 0) {
        const hasDefaultThinker = models.some((m) => m.id === DEFAULT_THINKER_MODEL);
        const hasDefaultExecutor = models.some((m) => m.id === DEFAULT_EXECUTOR_MODEL);
        if (!hasDefaultThinker && !hasDefaultExecutor) {
          cfg.chooseModel = true;
        }
      }
    } catch {
      // Best-effort pre-flight check; proceed if discovery fails
    }
  }

  const serverUrl = runtime instanceof OpencodeRuntimeAdapter ? runtime.serverUrl : undefined;
  if (serverUrl) {
    if (!cfg.tui) {
      console.log(`${chalk.green("✓")} ${chalk.dim("opencode server ready at")} ${chalk.cyan(serverUrl)}`);
    } else {
      events.emit("log", {
        level: "info",
        message: `opencode server ready at ${serverUrl}`,
      });
    }
  }

  const live = new LiveEngine({ cfg, idea: idea || undefined, runtime });
  if (runtime.id === "opencode" && live.client) {
    await validateModels(live.client, cfg);
  }
  const sub = runtime.id === "opencode" && live.client
    ? subscribeToEvents(live.client, cfg, (req) => live.ask(req))
    : { close: () => {} };

  const cleanup = async (code: number) => {
    sub.close();
    await runtime.stopDaemon?.();
    process.exit(code);
  };
  process.on("SIGINT", async () => {
    live.requestAbort();
    try {
      live.cycleEngine?.cleanupSandboxes();
    } catch {
      // best-effort
    }
    setTimeout(() => void cleanup(1), 3000).unref();
  });
  process.on("SIGTERM", async () => {
    live.requestAbort();
    try {
      live.cycleEngine?.cleanupSandboxes();
    } catch {
      // best-effort
    }
    setTimeout(() => void cleanup(1), 3000).unref();
  });

  try {
    if (cfg.tui) {
      const { runLiveTui } = await import("./tui/app");
      await runLiveTui(live, cfg);
    } else {
      const { runLiveHeadless } = await import("./headless");
      await runLiveHeadless(live);
    }
    console.log(
      live.hasAborted
        ? chalk.yellow.bold(`\n🛑 [huginn] Live session aborted.`)
        : chalk.green.bold(`\n✨ [huginn] Live session completed.`),
    );
  } catch (err) {
    console.error(chalk.red(`[huginn] fatal: ${(err as Error).message}`));
  } finally {
    sub.close();
    await runtime.stopDaemon?.();
  }
}

async function runInstall(args: ParsedArgs): Promise<void> {
  const force = Boolean(args["--force"]);
  const auto = Boolean(args["--yes"]) || process.env.CI === "true";
  const only: TemplateKind | undefined =
    args["--only"] === "agents" ? "agent" : args["--only"] === "commands" ? "command" : undefined;

  const configDir = getOpencodeConfigDir();
  let all: ReturnType<typeof listTemplates>;
  try {
    all = listTemplates(configDir).filter((t) => !only || t.kind === only);
  } catch (err) {
    console.error(`[huginn] could not locate the bundled templates: ${(err as Error).message}`);
    console.error(`[huginn] set HUGINN_TEMPLATES_DIR to the huginn templates/ directory.`);
    process.exit(1);
  }
  const missing = getMissing(configDir).filter((t) => !only || t.kind === only);
  const targets = force ? all : missing;

  if (targets.length === 0) {
    console.log(
      force
        ? `[huginn] nothing to overwrite — no templates are installed yet. Run without --force to install them.`
        : `[huginn] all required opencode agents/commands are already present in ${configDir}.`,
    );
    return;
  }

  console.log(`[huginn] opencode config dir: ${configDir}\n`);
  console.log(
    force
      ? `[huginn] the following will be (re)installed, overwriting existing files:`
      : `[huginn] the following required opencode agents/commands are missing:`,
  );
  for (const line of describeTemplates(targets)) console.log(line);
  console.log();

  if (!auto) {
    const ok = await promptYesNo("Install these opencode agents/commands now?");
    if (!ok) {
      console.log("[huginn] cancelled. Run `huginn install --yes` later to install them.");
      return;
    }
  }

  const result = installTemplates({ force, only });
  const installed = result.installed;
  const skipped = result.skipped;
  const overwritten = result.overwritten;
  const remaining = only ? getMissing(configDir).filter((t) => t.kind === only) : getMissing(configDir);

  if (installed.length > 0) {
    console.log(`[huginn] installed ${installed.length}: ${installed.join(", ")}`);
  }
  if (overwritten.length > 0) {
    console.log(`[huginn] overwrote ${overwritten.length}: ${overwritten.join(", ")}`);
  }
  if (skipped.length > 0) {
    console.log(`[huginn] skipped (already present): ${skipped.join(", ")}`);
  }
  if (remaining.length > 0) {
    console.log(`[huginn] ⚠ still missing: ${remaining.map((t) => `${t.kind}s/${t.name}`).join(", ")}`);
  } else if (listInstalled(configDir).filter((t) => !only || t.kind === only).length > 0) {
    console.log("[huginn] ✓ all required opencode agents/commands are now present.");
  }
}

function warnIfMissingTemplates(tui?: boolean): void {
  let missing;
  try {
    missing = getMissing();
  } catch (err) {
    const msg =
      `[huginn] ⚠ could not check opencode agents/commands: ${(err as Error).message}. ` +
      `Set HUGINN_TEMPLATES_DIR to the huginn templates/ directory.`;
    if (tui) {
      events.emit("log", { level: "warn", message: msg });
    } else {
      console.warn(msg);
    }
    return;
  }
  if (missing.length === 0) return;
  if (tui) {
    events.emit("log", {
      level: "warn",
      message: `${missing.length} required opencode agent(s)/command(s) are not installed yet: ${missing.map((t) => `${t.kind}s/${t.name}`).join(", ")}. Run 'huginn install'.`,
    });
  } else {
    console.warn(
      `[huginn] ⚠ ${missing.length} required opencode agent(s)/command(s) are not installed yet:\n` +
        `  ${missing.map((t) => `${t.kind}s/${t.name}`).join(", ")}\n` +
        `  Run \`huginn install\` to install them into ${getOpencodeConfigDir()}.`,
    );
  }
}

function validatePhase(name: string): PhaseName {
  // Any profile's phases are accepted: the active one decides what actually runs
  // (REQ-36), and `--only-phase` is a debugging aid across methodologies.
  if ((PROFILE_PHASES as string[]).includes(name)) {
    return name as PhaseName;
  }
  console.error(`Invalid --only-phase "${name}". Valid: ${PROFILE_PHASES.join(", ")}`);
  process.exit(1);
}

/** Resolve `--profile`, failing closed on an unknown id (AC-36.2/AC-36.6). */
function resolveProfile(flag: unknown, fallback?: string): ProfileName {
  const raw = typeof flag === "string" ? flag.trim().toLowerCase() : (fallback ?? DEFAULT_PROFILE);
  if (!isProfileName(raw)) {
    console.error(
      `Invalid --profile "${String(flag)}". Valid: ${PROFILE_NAMES.join(", ")}`,
    );
    process.exit(1);
  }
  return raw;
}

/**
 * Validates the configured thinker/executor provider ids against the
 * server's configured provider list (AC-27.6).
 *
 * `config.providers()` returns `{ providers, default }` — NOT `{ all }` — so
 * reading the wrong field left `known` empty and warned on every run. Exported
 * for the provider-validation test.
 */
export async function validateModels(
  client: import("@opencode-ai/sdk").OpencodeClient,
  cfg: RunConfig,
): Promise<void> {
  try {
    const res = await client.config.providers();
    const providers = (res as { providers?: Array<{ id: string }> }).providers ?? [];
    const known = new Set(providers.map((p) => p.id));
    for (const [role, model] of [
      ["thinker", cfg.thinker],
      ["executor", cfg.executor],
    ] as const) {
      const pid = model.split("/")[0];
      if (!known.has(pid)) {
        const warnMsg =
          `[huginn] ⚠ provider "${pid}" (${role}) is not in the configured provider list. ` +
          `If it is an env-only provider, this is fine — otherwise check the model string.`;
        if (cfg.tui) {
          events.emit("log", { level: "warn", message: warnMsg });
        } else {
          console.warn(warnMsg);
        }
      }
    }
  } catch {
    const warnMsg = `[huginn] ⚠ could not validate models against providers (continuing anyway).`;
    if (cfg.tui) {
      events.emit("log", { level: "warn", message: warnMsg });
    } else {
      console.warn(warnMsg);
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then(() => {
      process.exit(process.exitCode ?? 0);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[huginn] fatal: ${msg}`);
      if (process.env.HUGINN_DEBUG) {
        console.error(err);
      }
      process.exit(1);
    });
}
