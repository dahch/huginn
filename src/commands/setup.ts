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
  describeMuninnProvisioning,
  listRegistry,
  setup,
  type AgentTarget,
  type MCPRegistration,
  type SetupReport,
} from "../agents/integrator.js";
import { detectAvailableAgents } from "../engine/agent/registry.js";
import { configRegistersMuninn } from "./doctor.js";

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
  huginn setup [--agent <t1,t2|all>] [--installed] [--status] [--dry-run] [--project <path>] [--home <path>] [--force] [--list]

Options:
  --agent <t1,t2|all>   Agents to configure, comma-separated (default: all)
  --installed           Only configure agents whose CLI is installed
  --project <path>      Project root the MCP server runs against (default: cwd)
  --home <path>         Home directory override (mainly for tests)
  --force               Overwrite an existing conflicting "muninn" entry
  --dry-run             Report exactly what would change, writing nothing
  --list                Print the registry (targets, paths, formats) and exit
  --status              Print the provisioning matrix (installed · muninn registered) and exit

Targets:
  ${AGENT_TARGETS.join(", ")}

Muninn is Huginn's shared brain: the database is project-scoped, so provisioning
several agents points them at the *same* memory. The portable fallback at
<home>/.huginn/mcp.json is written whenever at least one target is configured.
`);
}

/** Format the provisioning matrix (AC-38.4), shared by `--status` and `doctor`. */
export function printProvisioningMatrix(
  rows: ReturnType<typeof describeMuninnProvisioning>,
): void {
  console.log(chalk.bold(`\n[huginn] Muninn provisioning — ${rows.length} target(s)\n`));
  for (const row of rows) {
    const state = row.registered ? chalk.green("✔ registered") : chalk.yellow("• not registered");
    const installed = row.installed ? chalk.dim("installed") : chalk.yellow("not installed");
    console.log(`  ${chalk.cyan(row.id.padEnd(12))} ${row.label.padEnd(24)} ${state}  ${installed}`);
  }
  const missing = rows.filter((r) => r.installed && !r.registered).map((r) => r.id);
  if (missing.length > 0) {
    console.log(
      chalk.dim(`\n  fix: huginn setup --agent ${missing.join(",")}   (only the installed gaps)`),
    );
  }
}

/** Build the matrix for the current environment. */
export async function buildProvisioningRows(opts: {
  projectPath: string;
  homeDir: string;
  opencodeConfigDir?: string;
  env?: Record<string, string | undefined>;
  detected?: Array<{ id: AgentTarget; available: boolean }>;
}): Promise<ReturnType<typeof describeMuninnProvisioning>> {
  const detected = opts.detected ?? (await detectAvailableAgents(opts.env?.PATH ?? process.env.PATH ?? ""));
  return describeMuninnProvisioning({ ...opts, detected, registersMuninn: configRegistersMuninn });
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
  deps: { detect?: typeof detectAvailableAgents } = {},
): Promise<SetupReport | undefined> {
  const detect = deps.detect ?? detectAvailableAgents;
  if (args["--help"] || args["-h"]) {
    printSetupUsage();
    return undefined;
  }

  const agentArg = typeof args["--agent"] === "string" ? args["--agent"] : "all";
  const list = Boolean(args["--list"]);
  const status = Boolean(args["--status"]);
  const installedOnly = Boolean(args["--installed"]);
  const dryRun = Boolean(args["--dry-run"]);
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

  if (status) {
    printProvisioningMatrix(
      await buildProvisioningRows({ projectPath, homeDir, opencodeConfigDir, detected: await detect() }),
    );
    return undefined;
  }

  // `all` (or the default) covers every registered target; a comma-separated list
  // and/or `--installed` narrows it, so the user decides which agents share the
  // brain (AC-38.2). `--installed` *filters* the selection — it never widens it.
  const requested = [...new Set(agentArg.split(",").map((value) => value.trim()).filter(Boolean))];
  if (requested.includes("all")) requested.length = 0;
  const unknown = requested.filter((value) => !AGENT_TARGETS.includes(value as AgentTarget));
  if (unknown.length > 0) {
    console.error(chalk.red(`✖ Unknown agent${unknown.length > 1 ? "s" : ""} "${unknown.join(", ")}".`));
    printSetupUsage();
    process.exitCode = 1;
    return undefined;
  }

  const fleet = (AGENT_TARGETS as readonly AgentTarget[]).slice();
  let targets: AgentTarget[] = requested.length > 0 ? (requested as AgentTarget[]) : fleet;

  if (installedOnly) {
    const detected = await detect();
    const installed = new Set(detected.filter((d) => d.available).map((d) => d.id));
    const skipped = targets.filter((t) => !installed.has(t));
    targets = targets.filter((t) => installed.has(t));
    console.log(
      `[huginn] --installed: configuring ${targets.length} installed agent(s)` +
        (skipped.length > 0 ? `; skipping ${skipped.join(", ")} (not installed)` : ""),
    );
  }

  if (targets.length === 0) {
    console.log("[huginn] nothing to configure for the selected targets — nothing written.");
    return undefined;
  }

  const setupOpts = { projectPath, homeDir, force, dryRun, opencodeConfigDir };
  const isWholeFleet =
    targets.length === fleet.length && targets.every((target) => fleet.includes(target));

  let report: SetupReport;
  try {
    report = isWholeFleet
      ? setup({ agent: "all", ...setupOpts })
      : mergeReports(targets.map((agent) => setup({ agent, ...setupOpts })));
  } catch (err) {
    console.error(chalk.red(`✖ setup failed: ${(err as Error).message}`));
    process.exitCode = 1;
    return undefined;
  }

  printReport(report, projectPath, homeDir);
  if (dryRun) {
    console.log(chalk.dim("\n[huginn] --dry-run: the report above is what *would* change; nothing was written."));
  }
  return report;
}

/** Merge per-target reports into one, so a subset run prints like a full run. */
function mergeReports(reports: SetupReport[]): SetupReport {
  return {
    registrations: reports.flatMap((r) => r.registrations),
    rules: reports.flatMap((r) => r.rules),
    // The portable fallback is written for every target; report the first.
    portable: reports[0]?.portable ?? { path: "", changed: false },
  };
}
