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

export function printConfigUsage(): void {
  console.log(`huginn config — Persistent model configuration (thinker/executor)

Usage:
  huginn config show [--project <path>] [--home <path>]
  huginn config set [--thinker <m>] [--executor <m>] [--project <path>] [--home <path>] [--global]

Subcommands:
  show   Print the effective thinker/executor and the layer each value came from
  set    Persist thinker/executor to the project config (or the user config with --global)

Options:
  --thinker <m>   Model string for the thinker role (set)
  --executor <m>  Model string for the executor role (set)
  --global        Write to <home>/.huginn/config.json instead of the project config
  --project <path> Project root whose .huginn/config.json is read/written (default: cwd)
  --home <path>   Home directory override for the user config (default: os.homedir())

Precedence (show):
  CLI flag → project config → user config → environment → defaults.
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
    if (!provided) {
      console.error(chalk.red("Error: at least one of --thinker or --executor is required."));
      printConfigUsage();
      process.exitCode = 1;
      return;
    }

    const global = Boolean(args["--global"]);
    if (global) {
      saveGlobalUserConfig(homeDir, updates);
    } else {
      saveUserConfig(projectPath, updates);
    }
    const target = global ? getUserConfigPath(homeDir) : getProjectConfigPath(projectPath);
    console.log(
      `[huginn] wrote ${global ? "user" : "project"} config to ${chalk.cyan(target)}`,
    );
    if (updates.thinker !== undefined) console.log(`  thinker  = ${updates.thinker}`);
    if (updates.executor !== undefined) console.log(`  executor = ${updates.executor}`);
    return;
  }

  console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
  printConfigUsage();
  process.exitCode = 1;
}
