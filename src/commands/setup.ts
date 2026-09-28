/**
 * `huginn setup` / `huginn doctor` command handlers.
 *
 * `setup` (Iteration 10) registers the Muninn MCP server and injects the
 * directive rules into every supported agent via the declarative registry in
 * `src/agents/integrator.ts`. `doctor` (Iteration 11) lives in `./doctor.ts`
 * and is re-exported here so the CLI's `./commands/setup` import stays stable.
 */
import { homedir } from "node:os";
import path from "node:path";
import chalk from "chalk";
import {
  AGENT_REGISTRY,
  AGENT_TARGETS,
  listRegistry,
  setup,
  type AgentTarget,
  type MCPRegistration,
  type SetupReport,
} from "../agents/integrator.js";

export {
  runDoctorChecks,
  handleDoctorCommand,
  printDoctorUsage,
  printDoctorReport,
  configRegistersMuninn,
  type DoctorCheck,
  type DoctorReport,
  type DoctorOptions,
} from "./doctor.js";

export function printSetupUsage(): void {
  console.log(`huginn setup — Register Muninn MCP + agent rules across supported agents

Usage:
  huginn setup [--agent <target|all>] [--project <path>] [--home <path>] [--force] [--list]

Options:
  --agent <target|all>  Agent to configure (default: all)
  --project <path>      Project root the MCP server runs against (default: cwd)
  --home <path>         Home directory override (mainly for tests)
  --force               Overwrite an existing conflicting "muninn" entry
  --list                Print the registry (targets, paths, formats) and exit

Targets:
  ${AGENT_TARGETS.join(", ")}

Always writes the portable fallback at <home>/.huginn/mcp.json.
`);
}

function printRegistryTable(): void {
  const specs = listRegistry();
  console.log(chalk.bold(`[huginn] setup registry — ${specs.length} target(s)\n`));
  for (const spec of specs) {
    const id = spec.id.padEnd(12);
    const label = spec.label.padEnd(22);
    console.log(
      `  ${chalk.cyan(id)} ${label} ${chalk.dim(`[${spec.format}]`)}  ` +
        `${spec.mcpPaths.join(", ")}  rules=${spec.rulesFile}`,
    );
  }
}

function statusMarker(reg: MCPRegistration): string {
  if (reg.skipped) return chalk.yellow("•");
  if (reg.changed) return chalk.green("✔");
  return chalk.dim("=");
}

function statusLabel(reg: MCPRegistration): string {
  if (reg.skipped) return chalk.yellow("skipped (existing muninn differs; use --force)");
  if (reg.changed) return chalk.green("registered");
  return chalk.dim("unchanged");
}

function printReport(report: SetupReport, projectPath: string, homeDir: string): void {
  console.log(`[huginn] setup — project=${projectPath} home=${homeDir}\n`);

  const byTarget = new Map<AgentTarget, MCPRegistration[]>();
  for (const reg of report.registrations) {
    const list = byTarget.get(reg.target) ?? [];
    list.push(reg);
    byTarget.set(reg.target, list);
  }

  for (const target of AGENT_TARGETS) {
    const regs = byTarget.get(target);
    if (!regs) continue;
    console.log(`${chalk.bold(AGENT_REGISTRY[target].label)} (${target})`);
    for (const reg of regs) {
      console.log(`  ${statusMarker(reg)} ${reg.path} ${statusLabel(reg)}`);
    }
  }

  console.log(chalk.bold("\nRules"));
  for (const rule of report.rules) {
    const label = rule.changed ? chalk.green("updated") : chalk.dim("unchanged");
    console.log(`  ${rule.changed ? chalk.green("✔") : chalk.dim("=")} ${rule.path} ${label}`);
  }

  const portableLabel = report.portable.changed ? chalk.green("written") : chalk.dim("unchanged");
  console.log(chalk.bold("\nPortable fallback"));
  console.log(`  ${statusMarkerFromChanged(report.portable.changed)} ${report.portable.path} ${portableLabel}`);

  const changed = report.registrations.filter((r) => r.changed).length;
  const skipped = report.registrations.filter((r) => r.skipped).length;
  const unchanged = report.registrations.length - changed - skipped;
  const rulesChanged = report.rules.filter((r) => r.changed).length;
  console.log(
    `\n[huginn] summary: ${changed} registered, ${unchanged} unchanged, ${skipped} skipped, ` +
      `${rulesChanged} rules file(s) updated.`,
  );
}

function statusMarkerFromChanged(changed: boolean): string {
  return changed ? chalk.green("✔") : chalk.dim("=");
}

/**
 * `huginn setup` handler. Returns the {@link SetupReport} that was applied, or
 * the terminal status of the handler when no registration happened (`undefined`
 * for `--help`/`--list`, an unknown agent, or a failed `setup()`).
 *
 * Handlers in this CLI report failures through `process.exitCode` instead of
 * throwing; returning the report as well lets programmatic callers (the `init`
 * wizard) observe the outcome instead of assuming success on any resolved
 * await. `src/cli.ts`'s `setup` routing ignores the return value.
 */
export async function handleSetupCommand(
  args: Record<string, string | boolean | undefined>,
): Promise<SetupReport | undefined> {
  if (args["--help"] || args["-h"]) {
    printSetupUsage();
    return undefined;
  }

  const agentArg = typeof args["--agent"] === "string" ? args["--agent"] : "all";
  const list = Boolean(args["--list"]);
  const force = Boolean(args["--force"]);
  const projectPath =
    typeof args["--project"] === "string" ? path.resolve(args["--project"]) : process.cwd();
  const homeDir = typeof args["--home"] === "string" ? path.resolve(args["--home"]) : homedir();
  const opencodeConfigDir =
    typeof args["--opencode-config-dir"] === "string"
      ? path.resolve(args["--opencode-config-dir"])
      : undefined;

  if (list) {
    printRegistryTable();
    return undefined;
  }

  if (agentArg !== "all" && !AGENT_TARGETS.includes(agentArg as AgentTarget)) {
    console.error(chalk.red(`✖ Unknown agent "${agentArg}".`));
    printSetupUsage();
    process.exitCode = 1;
    return undefined;
  }

  let report: SetupReport;
  try {
    report = setup({
      agent: agentArg as AgentTarget | "all",
      projectPath,
      homeDir,
      force,
      opencodeConfigDir,
    });
  } catch (err) {
    console.error(chalk.red(`✖ setup failed: ${(err as Error).message}`));
    process.exitCode = 1;
    return undefined;
  }

  printReport(report, projectPath, homeDir);
  return report;
}
