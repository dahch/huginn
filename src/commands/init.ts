/**
 * `huginn init` — guided onboarding wizard (REQ-26, ADR-26).
 *
 * Deliberately a *thin orchestrator*: it introduces no new I/O primitives. Git
 * and lockfile detection are `existsSync` checks, agent discovery is delegated
 * to `detectAvailableAgents`, MCP registration to `huginn setup`, and the config
 * is persisted with the shared atomic `saveUserConfig`. Every side effect is
 * injectable through {@link InitDeps} so tests never touch the real home, the
 * real terminal or the real project — including the `env`/`stdin`/`stdout` seam
 * the prompts read.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { AGENT_TARGETS, type AgentTarget } from "../agents/integrator.js";
import type { SetupReport } from "../agents/integrator.js";
import { detectAvailableAgents, isAgentTarget } from "../engine/agent/registry.js";
import {
  DEFAULT_AGENT,
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_THINKER_MODEL,
  getProjectConfigPath,
  saveUserConfig,
} from "../config.js";
import { promptLine, promptYesNo, type PromptIo } from "../setup/install.js";
import { handleSetupCommand } from "./setup.js";

/** Package manager inferred from the project's lockfile (ADR-26). */
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm" | "unknown";

/** Single entry of the `detectAvailableAgents` PATH scan. */
export type AgentDetection = Awaited<ReturnType<typeof detectAvailableAgents>>[number];

/** The agent CLIs called out by AC-26.1; shown first in the wizard. */
export const PRIMARY_AGENT_CLIS: AgentTarget[] = ["opencode", "claude", "codex", "omp"];

/**
 * `DEFAULT_AGENT` narrowed to a real {@link AgentTarget}. The config constant is
 * typed `string`, so this is where the narrowing happens exactly once instead of
 * an unchecked `as AgentTarget` cast at each use site.
 */
const FALLBACK_AGENT: AgentTarget = isAgentTarget(DEFAULT_AGENT) ? DEFAULT_AGENT : "opencode";

/**
 * Injectable side effects. Every field has a production default, so the wizard
 * is fully driven by real primitives at runtime and by fakes in tests.
 */
export interface InitDeps {
  /** Project root used when `--project` is absent. */
  projectPath?: string;
  /** Home directory used when `--home` is absent. */
  homeDir?: string;
  /** Environment snapshot (CI + PATH); defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Exclusive override for the TTY probe (tests). */
  isTTY?: boolean;
  /** Readline input stream for the prompts; defaults to `process.stdin`. */
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Readline output stream for the prompts; defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream & { isTTY?: boolean };
  detectAgents?: (pathEnv?: string) => Promise<AgentDetection[]>;
  /**
   * `huginn setup` delegation. Resolves with the applied {@link SetupReport}, or
   * `undefined` when no registration happened (the wizard treats that as a
   * failure, REV-201).
   */
  runSetup?: (args: Record<string, string | boolean | undefined>) => Promise<SetupReport | undefined>;
  promptText?: (question: string, fallback: string) => Promise<string>;
  promptChoice?: (question: string, choices: string[], fallback: string) => Promise<string>;
  confirm?: (question: string, fallback?: boolean) => Promise<boolean>;
  log?: (...parts: unknown[]) => void;
  error?: (...parts: unknown[]) => void;
}

/**
 * What the wizard decided and did, trimmed to the fields a caller (the CLI, the
 * greenfield launcher, tests) actually consumes. Pure "step mirror" state —
 * git/package-manager/agent-detection findings and the interactivity/`--help`
 * mode markers — is printed to the terminal but deliberately not part of the
 * contract.
 */
export interface InitReport {
  /** Resolved project root that was configured. */
  projectPath: string;
  /** Resolved home directory the `setup` delegation used. */
  homeDir: string;
  /** Path of the project config; written only when {@link configWritten}. */
  configPath: string;
  agent: AgentTarget;
  thinker: string;
  executor: string;
  /** True when the `huginn setup` delegation registered the Muninn MCP. */
  setupRan: boolean;
  /** True when {@link configPath} was created or overwritten. */
  configWritten: boolean;
}

/**
 * Detect the package manager from the project's lockfiles. `bun.lock`/`bun.lockb`
 * beat pnpm/yarn/npm when several are present. A project with a `package.json`
 * but no lockfile falls back to npm (the historical default); a directory with
 * neither reports "unknown".
 */
export function detectPackageManager(projectPath: string): PackageManager {
  if (existsSync(join(projectPath, "bun.lock")) || existsSync(join(projectPath, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectPath, "package-lock.json"))) return "npm";
  return existsSync(join(projectPath, "package.json")) ? "npm" : "unknown";
}

export function printInitUsage(): void {
  console.log(`huginn init — guided onboarding: agent, models, Muninn MCP and config

Usage:
  huginn init [--yes] [--skip-setup] [flags]

Flags:
  --project <path>              project root to configure (default: cwd)
  --home <path>                 home directory override (mainly for tests)
  --opencode-config-dir <path>  opencode config directory override
  --agent <target>              pre-select the agent (${AGENT_TARGETS.join(", ")})
  --thinker <model>             pre-set the thinker model (default: ${DEFAULT_THINKER_MODEL})
  --executor <model>            pre-set the executor model (default: ${DEFAULT_EXECUTOR_MODEL})
  --yes                         accept every default without prompting
  --skip-setup                  do not register the Muninn MCP
  --force                       overwrite conflicting MCP entries during setup
  --help, -h                    show this help

Steps:
  1. detect the git repository and the package manager
  2. scan the installed agent CLIs (${PRIMARY_AGENT_CLIS.join(", ")}, …)
  3. choose the default agent and the thinker/executor models
  4. register the Muninn MCP with \`huginn setup\` for the chosen agent
  5. write the initial <project>/.huginn/config.json

Every step is non-blocking when stdio is not a TTY or CI is set: flags and the
documented defaults are used instead of prompting.

Note: on a greenfield project a global ~/.huginn/config.json and HUGINN_AGENT are
ignored — the wizard always writes <project>/.huginn/config.json so the choices
stay local to the repository being onboarded.
`);
}

/** Read one line through the shared prompt seam (REV-202/REV-206). */
function askLine(question: string, fallback: string, io: PromptIo): Promise<string> {
  return promptLine(question, fallback, io);
}

async function promptTextDefault(question: string, fallback: string, io: PromptIo): Promise<string> {
  return askLine(`${question} [${fallback}] `, fallback, io);
}

async function promptChoiceDefault(
  question: string,
  choices: string[],
  fallback: string,
  io: PromptIo,
): Promise<string> {
  console.log(question);
  choices.forEach((choice, index) => console.log(`   ${index + 1}) ${choice}`));
  const answer = await askLine(`   Choose [${fallback}] `, fallback, io);
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1];
  }
  return choices.includes(answer) ? answer : fallback;
}

/**
 * Run the onboarding wizard. Each step prints its finding; the decisions and
 * outcomes are mirrored into the returned {@link InitReport}.
 *
 * Never blocks without a TTY and never throws. An unusable `--agent` and a
 * failed `saveUserConfig` write both print an error, set `process.exitCode = 1`
 * and return early before any write. A failed `huginn setup` delegation warns
 * and sets `process.exitCode = 1` too, but the config is still written so the
 * repository stays usable.
 *
 * The `--help`/`-h` early return is intentional exported-API behavior rather
 * than an unreachable CLI branch: `main()` short-circuits `huginn init --help`
 * before delegating, but a programmatic caller passing `--help` gets the same
 * "print usage and write nothing" contract `handleSetupCommand` offers.
 */
export async function handleInitCommand(
  args: Record<string, string | boolean | undefined> = {},
  deps: InitDeps = {},
): Promise<InitReport> {
  const log = deps.log ?? ((...parts: unknown[]): void => void console.log(...parts));
  const error = deps.error ?? ((...parts: unknown[]): void => void console.error(...parts));

  const projectPath = resolve(
    typeof args["--project"] === "string"
      ? args["--project"]
      : (deps.projectPath ?? process.cwd()),
  );
  const homeDir =
    typeof args["--home"] === "string" ? resolve(args["--home"]) : (deps.homeDir ?? homedir());
  const opencodeConfigDir =
    typeof args["--opencode-config-dir"] === "string"
      ? resolve(args["--opencode-config-dir"])
      : undefined;
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const io: PromptIo = { env, stdin, stdout };
  const yes = Boolean(args["--yes"]);
  const skipSetup = Boolean(args["--skip-setup"]);
  const force = Boolean(args["--force"]);
  const interactive = deps.isTTY ?? (Boolean(stdin.isTTY) && Boolean(stdout.isTTY));
  const canPrompt = interactive && !env.CI && !yes;
  const flagAgent =
    typeof args["--agent"] === "string" ? args["--agent"].trim().toLowerCase() : "";
  const flagAgentTarget = flagAgent.length > 0 && isAgentTarget(flagAgent) ? flagAgent : undefined;
  const flagThinker = typeof args["--thinker"] === "string" ? args["--thinker"].trim() : "";
  const flagExecutor = typeof args["--executor"] === "string" ? args["--executor"].trim() : "";

  const report: InitReport = {
    projectPath,
    homeDir,
    configPath: getProjectConfigPath(projectPath),
    agent: flagAgentTarget ?? FALLBACK_AGENT,
    thinker: flagThinker.length > 0 ? flagThinker : DEFAULT_THINKER_MODEL,
    executor: flagExecutor.length > 0 ? flagExecutor : DEFAULT_EXECUTOR_MODEL,
    setupRan: false,
    configWritten: false,
  };

  // Deliberate (and documented above): the wizard's own `--help` contract.
  if (args["--help"] || args["-h"]) {
    printInitUsage();
    return report;
  }

  if (flagAgent.length > 0 && flagAgentTarget === undefined) {
    error(chalk.red(`✖ Unknown agent "${args["--agent"] as string}".`));
    error(`  Supported targets: ${AGENT_TARGETS.join(", ")}`);
    process.exitCode = 1;
    return report;
  }

  log(chalk.bold(`\n[huginn] init — onboarding for ${projectPath}\n`));

  log(chalk.bold("1. Repository"));
  const isGitRepo = existsSync(join(projectPath, ".git"));
  if (isGitRepo) {
    log(`   ${chalk.green("✔")} git repository detected`);
  } else {
    log(`   ${chalk.yellow("•")} no .git directory here`);
    log(chalk.dim(`     tip: run \`git init\` in ${projectPath} so huginn can track iterations`));
  }

  log(chalk.bold("\n2. Package manager"));
  const packageManager = detectPackageManager(projectPath);
  log(
    packageManager === "unknown"
      ? `   ${chalk.dim("unknown (no package.json or lockfile)")}`
      : `   ${chalk.cyan(packageManager)}`,
  );

  log(chalk.bold("\n3. Agent CLIs"));
  const detectAgents = deps.detectAgents ?? detectAvailableAgents;
  const detectedAgents = await detectAgents(env.PATH ?? process.env.PATH ?? "");
  // Display order: the primary CLIs of AC-26.1 first, then the remaining
  // registry targets in their declared order.
  const ordered = [
    ...PRIMARY_AGENT_CLIS.map((id) => detectedAgents.find((d) => d.id === id)).filter(
      (d): d is AgentDetection => d !== undefined,
    ),
    ...detectedAgents.filter((d) => !PRIMARY_AGENT_CLIS.includes(d.id)),
  ];
  for (const detection of ordered) {
    const label = detection.id.padEnd(12);
    log(
      detection.available
        ? `   ${chalk.green("✔")} ${chalk.cyan(label)} ${chalk.dim(detection.path ?? "on PATH")}`
        : `   ${chalk.dim("•")} ${chalk.dim(`${label} not installed`)}`,
    );
  }
  // The default derives from the SAME ordered list that was just printed, so the
  // pre-selected agent can never contradict the first line the developer sees
  // (REV-203); the fallback stays DEFAULT_AGENT.
  const availableIds = ordered.filter((d) => d.available).map((d) => d.id);
  if (flagAgentTarget === undefined && availableIds.length > 0) {
    report.agent = availableIds[0];
  }

  log(chalk.bold("\n4. Agent & models"));
  if (canPrompt) {
    const choices =
      availableIds.length > 0
        ? [...availableIds, ...(availableIds.includes(report.agent) ? [] : [report.agent])]
        : [...AGENT_TARGETS];
    const promptChoice =
      deps.promptChoice ??
      ((question: string, list: string[], fallback: string) =>
        promptChoiceDefault(question, list, fallback, io));
    const promptText =
      deps.promptText ??
      ((question: string, fallback: string) => promptTextDefault(question, fallback, io));
    const pickedAgent = await promptChoice("   Default agent", choices, report.agent);
    if (isAgentTarget(pickedAgent)) report.agent = pickedAgent;
    const pickedThinker = (await promptText("   Thinker model", report.thinker)).trim();
    if (pickedThinker.length > 0) report.thinker = pickedThinker;
    const pickedExecutor = (await promptText("   Executor model", report.executor)).trim();
    if (pickedExecutor.length > 0) report.executor = pickedExecutor;
  } else {
    log(chalk.dim(`   using ${yes ? "--yes" : "non-interactive"} defaults`));
  }
  log(`   agent    ${chalk.magenta(report.agent)}`);
  log(`   thinker  ${chalk.magenta(report.thinker)}`);
  log(`   executor ${chalk.blueBright(report.executor)}`);

  log(chalk.bold("\n5. Muninn MCP"));
  if (skipSetup) {
    log(chalk.dim("   skipped (--skip-setup)"));
  } else {
    log(`   registering with ${chalk.cyan("huginn setup")} for ${chalk.magenta(report.agent)}…`);
    const setupArgs: Record<string, string | boolean | undefined> = {
      "--agent": report.agent,
      "--project": projectPath,
      "--home": homeDir,
    };
    if (opencodeConfigDir) setupArgs["--opencode-config-dir"] = opencodeConfigDir;
    if (force) setupArgs["--force"] = true;
    const runSetup = deps.runSetup ?? handleSetupCommand;
    const setupReport = await runSetup(setupArgs);
    // `handleSetupCommand` reports failures through `process.exitCode` and now
    // also returns `undefined`, so a merely-resolved await is NOT success
    // (REV-201): require both a returned report and a clean exit code.
    report.setupRan = setupReport !== undefined && process.exitCode !== 1;
    if (!report.setupRan) {
      error(chalk.yellow(`   ⚠ Muninn MCP registration did not complete for ${report.agent}.`));
      error(
        chalk.dim(
          `     re-run \`huginn setup --agent ${report.agent}\` to retry (or pass --skip-setup to skip it).`,
        ),
      );
      process.exitCode = 1;
    }
  }

  log(chalk.bold("\n6. Project config"));
  const existing = existsSync(report.configPath);
  if (existing && canPrompt && !force) {
    const confirm =
      deps.confirm ?? ((question: string, fallback = false) => promptYesNo(question, fallback, io));
    const overwrite = await confirm(`${report.configPath} already exists — overwrite it?`, true);
    if (!overwrite) {
      log(chalk.yellow(`   • keeping the existing ${report.configPath}`));
      logCompletion(log, report);
      return report;
    }
  }
  try {
    saveUserConfig(projectPath, {
      agent: report.agent,
      thinker: report.thinker,
      executor: report.executor,
    });
  } catch (err) {
    error(chalk.red(`✖ could not write ${report.configPath}: ${(err as Error).message}`));
    process.exitCode = 1;
    logCompletion(log, report);
    return report;
  }
  report.configWritten = true;
  log(`   ${chalk.green("✔")} ${report.configPath}${existing ? chalk.dim(" (updated)") : ""}`);

  logCompletion(log, report);
  return report;
}

function logCompletion(log: (...parts: unknown[]) => void, report: InitReport): void {
  log(chalk.bold("\n[huginn] init complete"));
  log(`   agent     ${chalk.magenta(report.agent)}`);
  log(`   thinker   ${chalk.magenta(report.thinker)}`);
  log(`   executor  ${chalk.blueBright(report.executor)}`);
  log(`   config    ${report.configWritten ? report.configPath : chalk.dim("unchanged")}`);
  log(
    `   muninn    ${report.setupRan ? chalk.green("registered") : chalk.dim("not registered")}`,
  );
  log(chalk.dim(`\n   next: huginn "<idea>"  ·  huginn doctor  ·  huginn --help\n`));
}
