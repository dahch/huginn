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

const DIVIDER = "─".repeat(45);

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
  const models = [info.thinker && `thinker: ${info.thinker}`, info.executor && `executor: ${info.executor}`]
    .filter(Boolean)
    .join(" · ");

  const runLine = [
    info.projectPath && `project: ${shortenPath(info.projectPath)}`,
    info.iteration && info.totalIterations && `iteration ${info.iteration}/${info.totalIterations}`,
    info.phase && `phase ${info.phase}`,
  ]
    .filter(Boolean)
    .join(" · ");

  console.log("\n" + ART.join("\n"));
  console.log("\n        the raven that thinks, builds, and remembers");
  console.log(`        ${DIVIDER}`);
  console.log(`        v${version}${models ? " · " + models : ""}`);
  if (runLine) console.log(`        ${runLine}`);
  console.log("\n" + QUOTE.join("\n") + "\n");
}
