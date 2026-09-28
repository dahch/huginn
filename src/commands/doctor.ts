/**
 * `huginn doctor` — read-only environment diagnostics (REQ-16, SPEC.md §5).
 *
 * Checks the git binary + repository state, the Bun/Node runtime, the
 * `opencode` CLI, the Muninn MCP integrations across every registry target and
 * the Muninn database health. Only the git repository, a runtime and the
 * Muninn DB are **critical** (AC-16.2); everything else degrades to a warning.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import chalk from "chalk";
import {
  listRegistry,
  resolveMcpPaths,
  type McpFormat,
  type ResolveOptions,
} from "../agents/integrator.js";
import { MemoryService } from "../muninn/service/memory-service.js";

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  critical: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorOptions {
  projectPath: string;
  homeDir?: string;
  opencodeConfigDir?: string;
  env?: Record<string, string | undefined>;
  /**
   * Explicit Muninn database path. Defaults to `<projectPath>/.huginn/muninn.db`
   * so the check never depends on the process working directory (AC-16.3).
   */
  dbPath?: string;
}

interface ProbeResult {
  ok: boolean;
  output: string;
}

/**
 * Run a binary probe with `spawnSync` so it behaves identically under Bun and
 * Node/vitest. Never throws: a missing binary or a spawn error is reported as a
 * failed probe with the error message as the detail.
 */
function probe(command: string, args: string[], cwd?: string): ProbeResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) {
    return { ok: false, output: result.error.message };
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  return { ok: result.status === 0, output: stdout || stderr };
}

/**
 * Read-only detection of a `muninn` MCP entry in a target config. JSON uses the
 * target's container key (`mcp` for opencode, `mcpServers` otherwise); TOML uses
 * the `[mcp_servers.muninn]` table. A missing, unreadable or malformed config
 * counts as "not registered" and never throws.
 */
export function configRegistersMuninn(filePath: string, format: McpFormat): boolean {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  if (format === "toml") {
    return /^\s*\[mcp_servers\.muninn\]\s*$/m.test(raw);
  }
  const containerKey = format === "opencode" ? "mcp" : "mcpServers";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const container = (parsed as Record<string, unknown>)[containerKey];
    if (typeof container !== "object" || container === null || Array.isArray(container)) {
      return false;
    }
    return (container as Record<string, unknown>).muninn !== undefined;
  } catch {
    return false;
  }
}

function gitChecks(projectPath: string): DoctorCheck[] {
  const binary = probe("git", ["--version"]);
  const binaryCheck: DoctorCheck = {
    id: "git-binary",
    label: "git binary",
    status: binary.ok ? "ok" : "warn",
    detail: binary.ok ? binary.output : "not found on PATH — version control unavailable",
    critical: false,
  };

  let repoOk = false;
  let repoDetail = "git is not installed";
  if (binary.ok) {
    const inside = probe("git", ["rev-parse", "--is-inside-work-tree"], projectPath);
    repoOk = inside.ok && inside.output === "true";
    repoDetail = repoOk
      ? `${projectPath} is inside a git work tree`
      : `not a git repository: ${projectPath}`;
  }
  const repoCheck: DoctorCheck = {
    id: "git-repo",
    label: "git repository",
    status: repoOk ? "ok" : "fail",
    detail: repoDetail,
    critical: true,
  };
  return [binaryCheck, repoCheck];
}

function runtimeChecks(): DoctorCheck[] {
  const bun = probe("bun", ["--version"]);
  const node = probe("node", ["--version"]);
  const runtimeOk = bun.ok || node.ok;
  const runtimeDetail = bun.ok
    ? `bun ${bun.output}`
    : node.ok
      ? `node ${node.output}`
      : "no Bun or Node runtime found on PATH";
  const runtime: DoctorCheck = {
    id: "runtime",
    label: "runtime",
    status: runtimeOk ? "ok" : "fail",
    detail: runtimeDetail,
    critical: true,
  };
  const nodeCheck: DoctorCheck = {
    id: "node",
    label: "Node runtime",
    status: node.ok ? "ok" : "warn",
    detail: node.ok ? `node ${node.output}` : "not found on PATH (some tooling needs it)",
    critical: false,
  };
  return [runtime, nodeCheck];
}

function opencodeCheck(): DoctorCheck {
  const opencode = probe("opencode", ["--version"]);
  return {
    id: "opencode",
    label: "opencode CLI",
    status: opencode.ok ? "ok" : "warn",
    detail: opencode.ok ? opencode.output : "not found on PATH (install/authenticate opencode)",
    critical: false,
  };
}

function integrationCheck(base: ResolveOptions): DoctorCheck {
  const specs = listRegistry();
  const registered: string[] = [];
  const missing: string[] = [];
  for (const spec of specs) {
    const paths = resolveMcpPaths(spec.id, base);
    if (paths.some((p) => configRegistersMuninn(p, spec.format))) {
      registered.push(spec.id);
    } else {
      missing.push(spec.id);
    }
  }
  const total = specs.length;
  const all = total > 0 && registered.length === total;
  return {
    id: "integrations",
    label: "Muninn integrations",
    status: all ? "ok" : "warn",
    detail:
      `${registered.length}/${total} targets register muninn` +
      (registered.length > 0 ? ` (${registered.join(", ")})` : "") +
      // Muninn is the shared brain; the actionable fix names the exact gaps, and
      // `--installed` keeps it to the agents actually on this machine (AC-38.4).
      (all
        ? ""
        : `; missing: ${missing.join(", ")} — run \`huginn setup --agent ${missing.join(",")}\`` +
          ` (add --installed to target only the agents installed here)`),
    critical: false,
  };
}

function muninnCheck(projectPath: string, dbPath: string): DoctorCheck {
  let status: DoctorCheck["status"] = "fail";
  let detail: string;
  try {
    const service = new MemoryService({ projectRoot: projectPath, dbPath });
    try {
      const stats = service.getStats();
      status = "ok";
      detail =
        `database opened at ${dbPath} — ` +
        `${stats.projects} project(s), ${stats.observations} observation(s)`;
    } finally {
      service.close?.();
    }
  } catch (err) {
    detail = `failed to open Muninn DB at ${dbPath}: ${(err as Error).message}`;
  }
  return {
    id: "muninn",
    label: "Muninn database",
    status,
    detail,
    critical: true,
  };
}

/**
 * Structured diagnostics independent of console output (AC-16.3). `ok` is true
 * only when every **critical** check passed.
 */
export function runDoctorChecks(opts: DoctorOptions): DoctorReport {
  const projectPath = path.resolve(opts.projectPath);
  const homeDir = opts.homeDir ? path.resolve(opts.homeDir) : homedir();
  const opencodeConfigDir = opts.opencodeConfigDir
    ? path.resolve(opts.opencodeConfigDir)
    : undefined;
  const dbPath = opts.dbPath ?? path.join(projectPath, ".huginn", "muninn.db");

  const base: ResolveOptions = {
    projectPath,
    homeDir,
    opencodeConfigDir,
    env: opts.env,
  };

  const checks: DoctorCheck[] = [
    ...gitChecks(projectPath),
    ...runtimeChecks(),
    opencodeCheck(),
    integrationCheck(base),
    muninnCheck(projectPath, dbPath),
  ];

  const ok = checks.every((check) => !check.critical || check.status === "ok");
  return { checks, ok };
}

export function printDoctorUsage(): void {
  console.log(`huginn doctor — diagnose the local environment and Muninn database

Usage:
  huginn doctor [--project <path>] [--home <path>] [--opencode-config-dir <path>]

Options:
  --project <path>              Project root to inspect (default: cwd)
  --home <path>                 Home directory override (mainly for tests)
  --opencode-config-dir <path>  opencode config directory override

Critical checks (exit 1 on failure): git repository, runtime, Muninn database.
Everything else (git binary, Node, opencode CLI, missing integrations) warns.
`);
}

function marker(status: DoctorCheck["status"]): string {
  if (status === "ok") return chalk.green("✔");
  if (status === "warn") return chalk.yellow("⚠");
  return chalk.red("✖");
}

export function printDoctorReport(report: DoctorReport, projectPath: string): void {
  console.log(chalk.bold(`[huginn] doctor — ${projectPath}\n`));
  for (const check of report.checks) {
    const optional = check.critical ? "" : chalk.dim(" (optional)");
    console.log(`  ${marker(check.status)} ${check.label.padEnd(18)} ${chalk.dim(check.detail)}${optional}`);
  }
  const failed = report.checks.filter((c) => c.critical && c.status !== "ok").length;
  if (report.ok) {
    console.log(chalk.green.bold("\n✔ all critical checks passed"));
  } else {
    console.log(chalk.red.bold(`\n✖ ${failed} critical check(s) failed`));
  }
}

export async function handleDoctorCommand(
  args: Record<string, string | boolean | undefined>,
): Promise<void> {
  if (args["--help"] || args["-h"]) {
    printDoctorUsage();
    return;
  }

  const projectPath =
    typeof args["--project"] === "string" ? path.resolve(args["--project"]) : process.cwd();
  const homeDir = typeof args["--home"] === "string" ? path.resolve(args["--home"]) : undefined;
  const opencodeConfigDir =
    typeof args["--opencode-config-dir"] === "string"
      ? path.resolve(args["--opencode-config-dir"])
      : undefined;

  const report = runDoctorChecks({ projectPath, homeDir, opencodeConfigDir });
  printDoctorReport(report, projectPath);
  process.exitCode = report.ok ? 0 : 1;
}
