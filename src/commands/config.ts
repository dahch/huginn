/**
 * `huginn config` command handler (Iteration 14, REQ-14 AC-14.3).
 *
 * `show` is a read-only view of the effective thinker/executor and the layer
 * each value came from; `set` is the runtime write path for the previously
 * unreachable `saveUserConfig` / `saveGlobalUserConfig` layer. The handler
 * never touches the real user home on its own: `--home` (and `--project`)
 * override the defaults, which the tests rely on.
 */
import { homedir } from "node:os";
import path from "node:path";
import chalk from "chalk";
import {
  describeModelSources,
  getProjectConfigPath,
  getUserConfigPath,
  loadConfigLayers,
  resolveModelsFromConfig,
  saveGlobalUserConfig,
  saveUserConfig,
  type UserConfig,
} from "../config.js";
import {
  DEFAULT_PROFILE,
  isProfileName,
  PROFILE_NAMES,
  profileSpec,
  type ProfileName,
} from "../engine/profiles.js";
import { isAgentTarget } from "../engine/agent/registry.js";
import { AGENT_TARGETS } from "../agents/integrator.js";

export function printConfigUsage(): void {
  console.log(`huginn config — Persistent model, profile and runtime configuration

Usage:
  huginn config show [--project <path>] [--home <path>]
  huginn config set [--thinker <m>] [--executor <m>] [--profile <id>] [--agent <id>]
                    [--project <path>] [--home <path>] [--global]

Subcommands:
  show   Print the effective thinker/executor, profile and runtime, with the layer each came from
  set    Persist them to the project config (or the user config with --global)

Options:
  --thinker <m>   Model string for the thinker role (set)
  --executor <m>  Model string for the executor role (set)
  --profile <id>  Methodology profile (set)
  --agent <id>    Runtime that executes the cycle (set); without it the runtime is
                  detected from PATH at launch
  --global        Write to <home>/.huginn/config.json instead of the project config
  --project <path> Project root whose .huginn/config.json is read/written (default: cwd)
  --home <path>   Home directory override for the user config (default: os.homedir())

Precedence (show):
  CLI flag → project config → user config → environment → defaults (models);
  flag → project config → user config → HUGINN_AGENT → first runtime detected on
  PATH, alphabetically (agent).
`);
}

function asFlagString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function handleConfigCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  const projectPath = path.resolve(asFlagString(args["--project"]) ?? process.cwd());
  const homeDir = asFlagString(args["--home"])
    ? path.resolve(asFlagString(args["--home"]) as string)
    : homedir();

  if (
    !subcommand ||
    args["--help"] ||
    args["-h"] ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printConfigUsage();
    return;
  }

  if (subcommand === "show") {
    const flagThinker = asFlagString(args["--thinker"]);
    const flagExecutor = asFlagString(args["--executor"]);
    const layers = loadConfigLayers(projectPath, homeDir);
    const effective = resolveModelsFromConfig({
      flagThinker,
      flagExecutor,
      projectConfig: layers.project,
      userConfig: layers.user,
    });
    const described = describeModelSources({
      flagThinker,
      flagExecutor,
      projectConfig: layers.project,
      userConfig: layers.user,
    });

    console.log(chalk.bold("[huginn] model resolution"));
    console.log(
      `  thinker  = ${chalk.cyan(effective.thinker)}  (source: ${described.thinker.source})`,
    );
    console.log(
      `  executor = ${chalk.cyan(effective.executor)}  (source: ${described.executor.source})`,
    );
    console.log(chalk.bold("[huginn] methodology"));
    console.log(
      `  profile  = ${chalk.cyan(layers.project.profile ?? layers.user.profile ?? DEFAULT_PROFILE)}` +
        `  (${profileSpec(layers.project.profile ?? layers.user.profile).name})`,
    );
    console.log(chalk.bold("[huginn] runtime"));
    // Only the *persisted* layers are described here; detection happens at launch
    // and needs PATH, so claiming a resolved runtime from this command would lie.
    const persistedAgent =
      (isAgentTarget(layers.project.agent ?? "") && layers.project.agent) ||
      (isAgentTarget(layers.user.agent ?? "") && layers.user.agent) ||
      undefined;
    const agentSource = persistedAgent
      ? layers.project.agent === persistedAgent
        ? "project"
        : "user"
      : undefined;
    console.log(
      persistedAgent
        ? `  agent    = ${chalk.cyan(persistedAgent)}  (source: ${agentSource})`
        : `  agent    = ${chalk.cyan("auto")}  (detected from PATH at launch)`,
    );
    console.log(chalk.bold("[huginn] config files"));
    console.log(`  project: ${getProjectConfigPath(projectPath)}`);
    console.log(`  user:    ${getUserConfigPath(homeDir)}`);
    return;
  }

  if (subcommand === "set") {
    const rawFlags: Array<["thinker" | "executor", string, unknown]> = [
      ["thinker", "--thinker", args["--thinker"]],
      ["executor", "--executor", args["--executor"]],
    ];
    const updates: UserConfig = {};
    let provided = false;
    for (const [key, flag, raw] of rawFlags) {
      if (raw === undefined) continue;
      provided = true;
      if (typeof raw !== "string" || raw.trim() === "") {
        console.error(chalk.red(`Error: ${flag} requires a non-empty model string.`));
        printConfigUsage();
        process.exitCode = 1;
        return;
      }
      updates[key] = raw.trim();
    }
    // Methodology profile (REQ-36 / AC-36.2): validated like every other enum.
    const rawProfile = args["--profile"];
    if (rawProfile !== undefined) {
      provided = true;
      const candidate = typeof rawProfile === "string" ? rawProfile.trim().toLowerCase() : "";
      if (!isProfileName(candidate)) {
        console.error(
          chalk.red(`Error: --profile must be one of [${PROFILE_NAMES.join(", ")}].`),
        );
        printConfigUsage();
        process.exitCode = 1;
        return;
      }
      updates.profile = candidate as ProfileName;
    }
    // The runtime that executes the cycle. Until now only the `--agent` flag and
    // a hand-edited config could set it, so a fixed choice never survived a
    // restart and PATH detection decided every launch.
    const rawAgent = args["--agent"];
    if (rawAgent !== undefined) {
      provided = true;
      const candidate = typeof rawAgent === "string" ? rawAgent.trim().toLowerCase() : "";
      if (!isAgentTarget(candidate)) {
        console.error(chalk.red(`Error: --agent must be one of [${AGENT_TARGETS.join(", ")}].`));
        printConfigUsage();
        process.exitCode = 1;
        return;
      }
      updates.agent = candidate;
    }
    if (!provided) {
      console.error(
        chalk.red(
          "Error: at least one of --thinker, --executor, --profile or --agent is required.",
        ),
      );
      printConfigUsage();
      process.exitCode = 1;
      return;
    }

    const global = Boolean(args["--global"]);
    if (global) {
      saveGlobalUserConfig(updates, homeDir);
    } else {
      saveUserConfig(projectPath, updates);
    }
    const target = global ? getUserConfigPath(homeDir) : getProjectConfigPath(projectPath);
    console.log(
      `[huginn] wrote ${global ? "user" : "project"} config to ${chalk.cyan(target)}`,
    );
    if (updates.thinker !== undefined) console.log(`  thinker  = ${updates.thinker}`);
    if (updates.executor !== undefined) console.log(`  executor = ${updates.executor}`);
    if (updates.profile !== undefined) console.log(`  profile  = ${updates.profile}`);
    if (updates.agent !== undefined) console.log(`  agent    = ${updates.agent}`);
    return;
  }

  console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
  printConfigUsage();
  process.exitCode = 1;
}
