import path from "node:path";
import chalk from "chalk";
import { MemoryService } from "../muninn/service/memory-service.js";
import { startMcpServer } from "../muninn/mcp/server.js";

export function printMemoryUsage(): void {
  console.log(`huginn memory — Persistent codebase memory across spec-build cycles

Usage:
  huginn memory init [--db <path>] [--project <path>]
  huginn memory search <query> [--category <cat>] [--limit <n>] [--project <path>]
  huginn memory sync [--import] [--file <path>] [--project <path>]

Subcommands:
  init     Initialize SQLite database and verify schema
  search   Search observations with BM25 relevance ranking
  sync     Export observations to disk (.jsonl) or import with --import
`);
}

export function printMcpUsage(): void {
  console.log(`huginn mcp — Model Context Protocol server for Muninn memory

Usage:
  huginn mcp run [--db <path>] [--project <path>]

Subcommands:
  run     Start the stdio MCP server for agent memory integration
`);
}

export async function handleMemoryCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>,
  positionals?: string[]
): Promise<void> {
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string"
      ? args["--project"]
      : typeof args["--root"] === "string"
        ? args["--root"]
        : undefined;

  if (
    !subcommand ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printMemoryUsage();
    return;
  }

  if (subcommand === "init") {
    const service = new MemoryService({ dbPath, projectRoot });
    try {
      const project = service.currentProject;
      console.log(chalk.green("✔ Muninn memory database initialized"));
      console.log(`  Database: ${service.db.name}`);
      console.log(`  Project:  ${project.name} (${project.root_path})`);
      console.log(`  Status:   Tables ready`);
    } finally {
      service.close?.();
    }
    return;
  }

  if (subcommand === "search") {
    const queryPositional =
      positionals?.[0] ??
      (typeof args._positional === "string" && args._positional !== "search"
        ? args._positional
        : undefined);
    const query =
      typeof args["--query"] === "string" ? args["--query"] : queryPositional;

    if (!query || query.trim() === "") {
      console.error(chalk.red("Error: Search query is required."));
      process.exitCode = 1;
      return;
    }

    const category =
      typeof args["--category"] === "string" ? args["--category"] : undefined;
    const parsedLimit =
      typeof args["--limit"] === "string"
        ? Math.floor(Number(args["--limit"]))
        : undefined;
    const limit = parsedLimit && parsedLimit > 0 ? parsedLimit : 10;

    const service = new MemoryService({ dbPath, projectRoot });
    try {
      const results = service.search({
        query: query.trim(),
        category,
        limit,
      });

      if (results.length === 0) {
        console.log(`No observations found matching "${query.trim()}".`);
        return;
      }

      console.log(
        chalk.bold(
          `Found ${results.length} result(s) for "${query.trim()}" (BM25 ranked):`
        )
      );

      for (const obs of results) {
        const categoryTag = chalk.cyan(`[${obs.category.toUpperCase()}]`);
        const rankScore = chalk.gray(`(score: ${obs.rank.toFixed(3)})`);
        console.log(`\n${categoryTag} ${chalk.bold(obs.title)} ${rankScore}`);

        if (obs.topic_key) {
          console.log(`  ${chalk.dim("Topic:")} ${obs.topic_key}`);
        }

        const preview =
          obs.content.length > 150
            ? `${obs.content.slice(0, 147)}...`
            : obs.content;
        console.log(`  ${chalk.white(preview.replace(/\n/g, " "))}`);

        if (obs.entities && obs.entities.length > 0) {
          const symbols = obs.entities.map((e) => e.identifier).join(", ");
          console.log(`  ${chalk.dim("Symbols:")} ${chalk.yellow(symbols)}`);
        }
      }
    } finally {
      service.close?.();
    }
    return;
  }

  if (subcommand === "sync") {
    const syncPositional =
      positionals?.[0] ??
      (typeof args._positional === "string" && args._positional !== "sync"
        ? args._positional
        : undefined);
    const filePath =
      typeof args["--file"] === "string" ? args["--file"] : syncPositional;

    const isImport = Boolean(args["--import"]);
    const service = new MemoryService({ dbPath, projectRoot });

    try {
      if (isImport) {
        const result = service.importFromDisk(filePath);
        console.log(
          `Imported ${result.imported} memories (skipped ${result.skipped} duplicates) from ${filePath ?? path.join(service.currentProject.root_path || process.cwd(), ".huginn", "memories.jsonl")}.`
        );
      } else {
        const result = service.syncToDisk(filePath);
        console.log(`Synced ${result.count} memories to ${result.path}.`);
      }
    } finally {
      service.close?.();
    }
    return;
  }

  console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
  printMemoryUsage();
  process.exitCode = 1;
}

export async function handleMcpCommand(
  subcommand: string | undefined,
  args: Record<string, string | boolean | undefined>
): Promise<void> {
  const dbPath = typeof args["--db"] === "string" ? args["--db"] : undefined;
  const projectRoot =
    typeof args["--project"] === "string"
      ? args["--project"]
      : typeof args["--root"] === "string"
        ? args["--root"]
        : undefined;

  if (
    !subcommand ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printMcpUsage();
    return;
  }

  if (subcommand === "run") {
    const { server, transport, service } = await startMcpServer({
      dbPath,
      projectRoot,
    });
    try {
      // Keep process alive while stdio transport is connected:
      await new Promise<void>((resolve) => {
        const done = () => {
          process.removeListener("SIGINT", done);
          process.removeListener("SIGTERM", done);
          resolve();
        };
        if (transport) {
          transport.onclose = () => done();
        } else {
          done();
        }
        process.on("SIGINT", done);
        process.on("SIGTERM", done);
      });
    } finally {
      service?.close?.();
      await server?.close?.();
    }
    return;
  }

  console.error(chalk.red(`Unknown subcommand: ${subcommand}`));
  printMcpUsage();
  process.exitCode = 1;
}
