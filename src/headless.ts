import { createInterface } from "node:readline";
import chalk from "chalk";
import type { CycleEngine } from "./engine/cycle";
import { events } from "./engine/engineEvents";
import type { DecisionChoice, DecisionRequest, Verdict } from "./engine/types";
import { formatDuration, verdictBadge } from "./format";

const BOX_WIDTH = 74;

/** Visible length of a string with ANSI escapes stripped. */
function visibleLength(s: string): number {
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Pads a (possibly ANSI-colored) string to the box's inner content width. */
function padBox(content: string): string {
  return content + " ".repeat(Math.max(0, BOX_WIDTH - 2 - visibleLength(content)));
}

function formatTime(isoDate?: string): string {
  const d = isoDate ? new Date(isoDate) : new Date();
  return d.toTimeString().split(" ")[0] ?? "";
}

function logLevelBadge(level: "info" | "warn" | "error"): string {
  switch (level) {
    case "info":
      return chalk.cyan("INFO ");
    case "warn":
      return chalk.yellow("WARN ");
    case "error":
      return chalk.red.bold("ERROR");
  }
}

export async function runHeadless(engine: CycleEngine): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const tty = Boolean(process.stdin.isTTY);

  let streamEOL = true;
  const startedAt = Date.now();
  const phaseStats: Array<{
    iteration: number;
    phase: string;
    verdict?: Verdict;
    attempt: number;
    durationMs?: number;
  }> = [];

  const writeLine = (line: string) => {
    if (!streamEOL) process.stdout.write("\n");
    process.stdout.write(line + "\n");
    streamEOL = true;
  };

  const askDecision = (req: DecisionRequest): Promise<DecisionChoice> => {
    return new Promise((resolve) => {
      if (!tty) {
        // Unattended (CI / pipe): no human available. Abort so state is preserved.
        process.stdout.write(`\n${chalk.yellow.bold("⚠️  DECISION REQUIRED")} ${chalk.white(req.message)}\n`);
        if (req.kind === "permission") {
          writeLine(chalk.dim("   [CI/non-TTY] Auto-denying permission."));
          resolve("deny");
        } else {
          writeLine(chalk.yellow("   (non-interactive stdin — aborting run; use --resume to continue later)"));
          resolve("abort");
        }
        return;
      }

      writeLine("");
      writeLine(chalk.yellow("┌" + "─".repeat(BOX_WIDTH - 2) + "┐"));
      writeLine(
        chalk.yellow("│") +
          padBox(`  ${chalk.yellow.bold("⚠️  DECISION REQUIRED")} ` + chalk.dim(`(iter ${req.iteration}, phase ${req.phase})`)) +
          chalk.yellow("│"),
      );
      writeLine(chalk.yellow("│") + padBox(`  ${chalk.white.bold(req.message)}`) + chalk.yellow("│"));
      writeLine(chalk.yellow("├" + "─".repeat(BOX_WIDTH - 2) + "┤"));

      if (req.kind === "permission") {
        writeLine(
          chalk.yellow("│") +
            padBox(`  ${chalk.cyan.bold("[a]")} Allow Always   ${chalk.cyan.bold("[o]")} Allow Once   ${chalk.red.bold("[d]")} Deny`) +
            chalk.yellow("│"),
        );
      } else {
        writeLine(
          chalk.yellow("│") +
            padBox(`  ${chalk.cyan.bold("[r]")} Retry with Thinker   ${chalk.yellow.bold("[c]")} Force Continue   ${chalk.red.bold("[a]")} Abort`) +
            chalk.yellow("│"),
        );
      }
      writeLine(chalk.yellow("└" + "─".repeat(BOX_WIDTH - 2) + "┘"));
      process.stdout.write(chalk.cyan.bold("  choice > "));

      const onLine = (line: string) => {
        const c = line.trim().toLowerCase().slice(0, 1);
        if (req.kind === "permission") {
          if (c === "a") return resolve("continue");
          if (c === "o") return resolve("retry");
          if (c === "d") return resolve("deny");
        } else {
          if (c === "r") return resolve("retry");
          if (c === "c") return resolve("continue");
          if (c === "a") return resolve("abort");
        }
        process.stdout.write(chalk.cyan.bold("  choice > "));
        rl.once("line", onLine);
      };
      rl.once("line", onLine);
    });
  };

  const offs: Array<() => void> = [];

  offs.push(
    events.on("iterationStart", (e) => {
      const iterLabel = ` ITERATION ${e.iteration} OF ${e.totalIterations} `;
      const title = e.title;
      writeLine("");
      writeLine(chalk.cyan("╔" + "═".repeat(BOX_WIDTH - 2) + "╗"));
      writeLine(chalk.cyan("║") + padBox(` ${chalk.bgCyan.black.bold(iterLabel)} ${chalk.white.bold(title)}`) + chalk.cyan("║"));
      if (e.modules && e.modules.length > 0) {
        writeLine(chalk.cyan("║") + padBox(`   ${chalk.dim("Modules:")} ${chalk.yellow(e.modules.join(", "))}`) + chalk.cyan("║"));
      }
      writeLine(chalk.cyan("╚" + "═".repeat(BOX_WIDTH - 2) + "╝"));
    }),
  );

  offs.push(
    events.on("phaseStart", (e) => {
      const isFix = e.phase.startsWith("FIX");
      const phaseColor = isFix ? chalk.magenta.bold : chalk.blueBright.bold;
      const attemptStr = e.attempt > 1 ? chalk.yellow(` (attempt ${e.attempt})`) : "";
      const timeStr = chalk.dim(`[${formatTime(e.startedAt)}]`);

      writeLine("");
      writeLine(
        `${timeStr} ${chalk.green("▶")} ${phaseColor(e.phase.padEnd(16))}${attemptStr} ` +
          chalk.dim(`· model `) +
          chalk.magenta(e.model),
      );
    }),
  );

  offs.push(
    events.on("phaseStream", (e) => {
      process.stdout.write(e.text);
      streamEOL = e.text.endsWith("\n");
    }),
  );

  offs.push(
    events.on("verdict", (e) => {
      phaseStats.push({
        iteration: e.iteration,
        phase: e.phase,
        verdict: e.verdict,
        attempt: e.attempt,
        durationMs: e.durationMs,
      });

      const badge = verdictBadge(e.verdict);
      const duration = e.durationMs ? chalk.dim(` (${formatDuration(e.durationMs)})`) : "";
      const attemptStr = e.attempt > 1 ? chalk.dim(` [attempt ${e.attempt}]`) : "";

      writeLine(
        `${badge} ${chalk.white.bold(e.phase.padEnd(16))} ${chalk.dim(`iter ${e.iteration}`)}${attemptStr}${duration}`,
      );
    }),
  );

  offs.push(
    events.on("decision", (req) => {
      void askDecision(req).then((choice) => engine.resolveDecision(choice));
    }),
  );

  offs.push(
    events.on("log", (e) => {
      const time = chalk.dim(`[${formatTime(e.timestamp)}]`);
      const level = logLevelBadge(e.level);
      writeLine(`${time} ${level} │ ${e.message}`);
    }),
  );

  try {
    await engine.run();
  } finally {
    for (const off of offs) off();
    rl.close();

    // Print final execution summary
    const totalElapsed = Date.now() - startedAt;
    const passed = phaseStats.filter((p) => p.verdict === "pass").length;
    const warned = phaseStats.filter((p) => p.verdict === "warning").length;
    const blocked = phaseStats.filter((p) => p.verdict === "blocked").length;
    const skipped = phaseStats.filter((p) => p.verdict === "skipped").length;

writeLine("");
    writeLine(chalk.cyan("┌" + "─".repeat(BOX_WIDTH - 2) + "┐"));
    writeLine(
      chalk.cyan("│") +
        padBox(`  ${chalk.bold("HUGGIN EXECUTION SUMMARY")} ${chalk.dim(`(Total elapsed: ${formatDuration(totalElapsed)})`)}`) +
        chalk.cyan("│"),
    );
    writeLine(chalk.cyan("├" + "─".repeat(BOX_WIDTH - 2) + "┤"));
    writeLine(
      chalk.cyan("│") +
        padBox(
          `  ${chalk.green(`✓ Passed: ${passed}`)}   ` +
            `${chalk.yellow(`⚠ Warnings: ${warned}`)}   ` +
            `${chalk.red(`✗ Blocked: ${blocked}`)}   ` +
            `${chalk.gray(`⏭ Skipped: ${skipped}`)}`,
        ) +
        chalk.cyan("│"),
    );
    writeLine(chalk.cyan("└" + "─".repeat(BOX_WIDTH - 2) + "┘"));
  }
}
