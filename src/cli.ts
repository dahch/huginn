#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunConfig } from "./config";
import { MAIN_PHASES, type PhaseName } from "./engine/types";
import { loadPlan } from "./plan/parser";
import {
  loadState,
  freshState,
  computePlanHash,
  clearStaleHarness,
} from "./state/store";
import { CycleEngine } from "./engine/cycle";
import { subscribeToEvents } from "./engine/permissions";
import { startServer, type ServerHandle } from "./server/lifecycle";
import { events } from "./engine/engineEvents";
import { printBanner, type BannerInfo } from "./banner";
import { runPlanMode } from "./engine/planMode";
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

function usage(): string {
  return `huginn — the raven that thinks, builds, and remembers.
Orchestrator for the opencode spec→commit cycle.

Usage:
  huginn run --project <repo> --thinker <provider/model> --executor <provider/model> [flags]
  huginn plan --project <repo> --thinker <provider/model> "<idea>" [flags]
  huginn install [--yes] [--force] [--only agents|commands]

Commands:
  run     execute the build cycle against plan.md/spec.md/adr.md
  plan    use the thinker to draft spec.md, adr.md and plan.md from an idea
  install install the opencode subagents and slash commands huginn needs into
          ~/.config/opencode (agents/ and commands/)

Required (run):
  --project <path>      git repo being built (must contain plan.md, spec.md, adr.md)
  --thinker <m>         "thinking" model used to FIX findings (auditor + reviewer + any blocker)
  --executor <m>        model used for everything else (execution, gates, docs, commits)

Required (plan):
  --project <path>      git repo where spec.md/adr.md/plan.md will be written
  --thinker <m>         model that drafts the three documents
  <idea>                prompt/idea describing what should be built
  --prompt-file <file>  alternative to <idea> for long prompts (reads the file)

Optional:
  --plan <file>         default: <project>/plan.md
  --spec <file>         default: <project>/spec.md
  --adr <file>          default: <project>/adr.md
  --force               (plan only) overwrite existing spec.md/adr.md/plan.md
  --mode auto|supervised   auto=autonomous with retry budget; supervised=ask at every gate  (default: auto)
  --permissions auto|ask|deny  auto-approve tool permissions  (default: auto)
  --max-retries <n>     fix attempts per blocked gate before escalating  (default: 3)
  --from-iteration <n>  start at iteration n
  --only-phase <name>   run a single phase per iteration (debugging)
  --resume              resume from saved state; errors if no saved state exists
  --force-restart       discard saved state and start over
  --ignore-plan-changes resume even if plan.md/spec.md/adr.md changed
  --tui | --headless    interactive dashboard vs stdout logs  (default: tui if TTY)
  --port <n>            port for the opencode server  (default: free port)
  --server-timeout <ms> server startup timeout  (default: 60000)
  --phase-timeout <ms>  hard deadline per phase step (0 disables)  (default: 1200000, 20 min)

Install:
  --yes                 install without asking (non-interactive / CI)
  --force               overwrite existing files in ~/.config/opencode (default: never)
  --only agents|commands  restrict the install to subagents or slash commands only
`;
}

interface ParsedArgs {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      let key = arg;
      let value: string | boolean = true;
      if (eq !== -1) {
        key = arg.slice(0, eq);
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i++;
        }
      }
      out[key] = value;
    } else if (i === 0) {
      out._command = arg;
    } else {
      out._positional = arg;
    }
  }
  return out;
}

export function num(v: string | boolean | undefined, fallback: number): number {
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
  const command = args._command ?? "run";
  if (command === "help" || command === "--help" || command === "-h") {
    printBanner({});
    console.log(usage());
    return;
  }
  if (command === "plan") {
    await runPlan(args);
    return;
  }
  if (command === "install") {
    await runInstall(args);
    return;
  }
  if (command !== "run") {
    console.error(`Unknown command: ${command}\n\n${usage()}`);
    process.exit(1);
  }

  const projectPath = canonicalize(String(args["--project"] ?? ""));
  if (!projectPath) {
    console.error("Missing required --project.\n\n" + usage());
    process.exit(1);
  }
  const thinker = String(args["--thinker"] ?? "");
  const executor = String(args["--executor"] ?? "");
  if (!thinker || !executor) {
    console.error("Missing required --thinker and/or --executor.\n\n" + usage());
    process.exit(1);
  }

  if (!existsSync(join(projectPath, ".git"))) {
    console.error(`"${projectPath}" is not a git repository.`);
    process.exit(1);
  }

  const cfg: RunConfig = {
    projectPath,
    planPath: canonicalize(resolve(join(projectPath, String(args["--plan"] ?? "plan.md")))),
    specPath: canonicalize(resolve(join(projectPath, String(args["--spec"] ?? "spec.md")))),
    adrPath: canonicalize(resolve(join(projectPath, String(args["--adr"] ?? "adr.md")))),
    thinker,
    executor,
    mode: args["--mode"] === "supervised" ? "supervised" : "auto",
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
  warnIfMissingTemplates();

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
  printBanner(bannerInfo);

  console.log(
    `[huginn] project=${projectPath}\n` +
      `[huginn] thinker=${thinker} executor=${executor} mode=${cfg.mode} max-retries=${cfg.maxRetries}\n` +
      `[huginn] iterations=${plan.iterations.length}` +
      (state ? ` (resuming at iteration ${state.currentIteration}, phase ${state.currentPhase})` : ""),
  );

  if (cfg.port === 0) cfg.port = await getFreePort();

  let server: ServerHandle;
  try {
    server = await startServer(projectPath, cfg.port, cfg.serverTimeoutMs);
  } catch (err) {
    console.error(`[huginn] failed to start opencode server: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`[huginn] opencode server ready at ${server.url}`);

  const engine = new CycleEngine({ cfg, plan, state });
  await validateModels(engine.client, cfg);
  const sub = subscribeToEvents(engine.client, cfg, (req) => engine.ask(req));

  const cleanup = async (code: number) => {
    sub.close();
    await server.close();
    process.exit(code);
  };
  process.on("SIGINT", async () => {
    engine.requestAbort();
    setTimeout(() => void cleanup(1), 3000).unref();
  });
  process.on("SIGTERM", async () => {
    engine.requestAbort();
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
        ? `[huginn] ✓ plan completed.`
        : outcome.reason === "aborted"
          ? `[huginn] 🛑 aborted. State saved for --resume.`
          : `[huginn] ✗ failed: ${outcome.error}`,
    );
  } catch (err) {
    console.error(`[huginn] fatal: ${(err as Error).message}`);
  } finally {
    sub.close();
    await server.close();
  }
}

async function runPlan(args: ParsedArgs): Promise<void> {
  const projectPath = canonicalize(String(args["--project"] ?? ""));
  if (!projectPath) {
    console.error("Missing required --project.\n\n" + usage());
    process.exit(1);
  }
  const thinker = String(args["--thinker"] ?? "");
  if (!thinker) {
    console.error("Missing required --thinker.\n\n" + usage());
    process.exit(1);
  }
  warnIfMissingTemplates();
  if (!existsSync(join(projectPath, ".git"))) {
    console.error(`"${projectPath}" is not a git repository.`);
    process.exit(1);
  }

  const promptFile = String(args["--prompt-file"] ?? "");
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

  let port = num(args["--port"], 0);
  if (port === 0) port = await getFreePort();
  const serverTimeoutMs = num(args["--server-timeout"], 60000);
  await runPlanMode({ projectPath, idea, thinker, specPath, adrPath, planPath, port, serverTimeoutMs });
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

function warnIfMissingTemplates(): void {
  let missing;
  try {
    missing = getMissing();
  } catch (err) {
    console.warn(
      `[huginn] ⚠ could not check opencode agents/commands: ${(err as Error).message}. ` +
        `Set HUGINN_TEMPLATES_DIR to the huginn templates/ directory.`,
    );
    return;
  }
  if (missing.length === 0) return;
  console.warn(
    `[huginn] ⚠ ${missing.length} required opencode agent(s)/command(s) are not installed yet:\n` +
      `  ${missing.map((t) => `${t.kind}s/${t.name}`).join(", ")}\n` +
      `  Run \`huginn install\` to install them into ${getOpencodeConfigDir()}.`,
  );
}

function validatePhase(name: string): PhaseName {
  if ((MAIN_PHASES as string[]).includes(name)) {
    return name as PhaseName;
  }
  console.error(`Invalid --only-phase "${name}". Valid: ${MAIN_PHASES.join(", ")}`);
  process.exit(1);
}

async function validateModels(
  client: import("@opencode-ai/sdk").OpencodeClient,
  cfg: RunConfig,
): Promise<void> {
  try {
    const res = await client.config.providers();
    const providers = (res as { all?: Array<{ id: string }> }).all ?? [];
    const known = new Set(providers.map((p) => p.id));
    for (const [role, model] of [
      ["thinker", cfg.thinker],
      ["executor", cfg.executor],
    ] as const) {
      const pid = model.split("/")[0];
      if (!known.has(pid)) {
        console.warn(
          `[huginn] ⚠ provider "${pid}" (${role}) is not in the configured provider list. ` +
            `If it is an env-only provider, this is fine — otherwise check the model string.`,
        );
      }
    }
  } catch {
    console.warn(`[huginn] ⚠ could not validate models against providers (continuing anyway).`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then(() => {
      process.exit(0);
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
