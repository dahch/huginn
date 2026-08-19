import chalk from "chalk";
import pkg from "../package.json";

export interface BannerInfo {
  version?: string;
  thinker?: string;
  executor?: string;
  projectPath?: string;
  iteration?: number;
  totalIterations?: number;
  phase?: string;
}

const ART = [
  "    __  ____  _____________   ___   __",
  "   / / / / / / / ____/  _/ | / / | / /",
  "  / /_/ / / / / / __ / //  |/ /  |/ / ",
  " / __  / /_/ / /_/ // // /|  / /|  /  ",
  "/_/ /_/\\____/\\____/___/_/ |_/_/ |_/   ",
];

const QUOTE = [
  "  Two ravens fly each day over the whole world;",
  "  I fear for Huginn, that he might not return —",
  "  yet I worry more for Muninn.",
  "                                    — Grímnismál, Poetic Edda",
];

export function shortenPath(path?: string): string {
  if (!path) return "";
  const home = process.env.HOME;
  if (home && path.startsWith(home + "/")) {
    return "~" + path.slice(home.length);
  }
  return path;
}

export function printBanner(info: BannerInfo): void {
  const version = info.version ?? pkg.version;
  const models = [
    info.thinker && `${chalk.dim("thinker:")} ${chalk.magenta(info.thinker)}`,
    info.executor && `${chalk.dim("executor:")} ${chalk.blueBright(info.executor)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const runLine = [
    info.projectPath && `${chalk.dim("project:")} ${chalk.cyan(shortenPath(info.projectPath))}`,
    info.iteration && info.totalIterations && `${chalk.dim("iter:")} ${chalk.yellow(`${info.iteration}/${info.totalIterations}`)}`,
    info.phase && `${chalk.dim("phase:")} ${chalk.green(info.phase)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  console.log("\n" + ART.map((l) => chalk.cyanBright.bold(l)).join("\n"));
  console.log(chalk.dim("\n        the raven that thinks, builds, and remembers"));
  console.log(chalk.cyan("        " + "─".repeat(50)));
  console.log(`        ${chalk.bgCyan.black.bold(` v${version} `)}${models ? "  " + models : ""}`);
  if (runLine) console.log(`        ${runLine}`);
  console.log("\n" + QUOTE.map((q) => chalk.dim.italic(q)).join("\n") + "\n");
}
