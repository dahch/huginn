import chalk from "chalk";
import type { RuntimePort } from "../engine/agent/port.js";
import { getRuntimePort } from "../engine/agent/registry.js";
import type { AgentTarget } from "../agents/integrator.js";

/**
 * The runtimes the cycle can execute, and what each one actually promises.
 *
 * Deliberately independent of `huginn setup`: that command still provisions
 * MCP config for every agent it knows, while this one answers "what can run the
 * cycle, and with which capabilities?".
 */
const RUNTIMES: Array<{ id: AgentTarget; kind: string }> = [
  { id: "pi", kind: "native (in-process)" },
  { id: "codex", kind: "native (SDK)" },
  { id: "claude", kind: "native (SDK, optional)" },
  { id: "opencode", kind: "daemon (HTTP)" },
  { id: "kimi", kind: "CLI bridge" },
];

export interface RuntimeCommandDeps {
  getPort: (id: AgentTarget) => RuntimePort;
}

export function printRuntimeUsage(): void {
  console.log(`huginn runtime — which runtimes can execute the cycle

Usage:
  huginn runtime list [--check]

Options:
  --check   probe each runtime's availability (loads the SDK / looks for the CLI)
`);
}

function capabilityLine(caps: RuntimePort["capabilities"]): string {
  const on: string[] = [];
  if (caps.inProcess) on.push("in-process");
  if (caps.sessionHistory) on.push("history");
  if (caps.sessionResume) on.push("resume");
  if (caps.streaming) on.push("streaming");
  if (caps.permissions === "interactive") on.push("permissions");
  else if (caps.permissions === "gate") on.push("permissions: gate");
  if (caps.interrupt) on.push("interrupt");
  if (caps.modelCatalog !== "none") on.push(`catalog:${caps.modelCatalog}`);
  return on.length > 0 ? on.join(" · ") : "prompt only";
}

export async function handleRuntimeCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>,
  deps: RuntimeCommandDeps = { getPort: (id) => getRuntimePort(id) },
): Promise<void> {
  if (!subcommand || subcommand === "help" || args["--help"] || args["-h"]) {
    printRuntimeUsage();
    return;
  }
  if (subcommand !== "list") {
    console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
    printRuntimeUsage();
    process.exitCode = 1;
    return;
  }

  const check = args["--check"] === true;
  console.log(chalk.bold("\n[huginn] runtimes that can execute the cycle\n"));
  for (const { id, kind } of RUNTIMES) {
    const port = deps.getPort(id);
    const caps = port.capabilities;
    let status = "";
    if (check) {
      try {
        const availability = await port.isAvailable();
        status = availability.ok
          ? chalk.green("  available")
          : chalk.yellow(`  unavailable: ${availability.reason ?? "unknown reason"}`);
      } catch (err) {
        status = chalk.red(`  probe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(
      `  ${chalk.cyan(id.padEnd(10))} ${kind.padEnd(22)} ${chalk.dim(capabilityLine(caps))}${status}`,
    );
  }
  console.log(
    chalk.dim(
      "\n  A capability that is not listed is not claimed: no surface waits for events a runtime cannot emit.\n" +
        "  \`huginn setup\` still provisions MCP config for every agent, runtime or not.\n",
    ),
  );
}
