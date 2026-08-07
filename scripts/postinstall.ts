#!/usr/bin/env bun
import { describeTemplates, getMissing, getOpencodeConfigDir, installTemplates, promptYesNo } from "../src/setup/install";

/**
 * Runs on `bun install`. If the required opencode agents/commands are already
 * installed, it stays silent. Otherwise it asks the user (when interactive)
 * whether to install them, or prints a hint when unattended (CI/pipe).
 */
const configDir = getOpencodeConfigDir();
const missing = getMissing(configDir);

if (missing.length === 0) {
  process.exit(0);
}

console.log(
  `\n[huginn] This project needs opencode agents/commands in ${configDir} to run its build cycle:\n`,
);
for (const line of describeTemplates(missing)) console.log(line);
console.log();

const ok = await promptYesNo("Install these opencode agents/commands now?");
if (!ok) {
  console.log(
    `[huginn] skipped. Run \`huginn install --yes\` (or \`huginn install\`) at any time to install them.\n`,
  );
  process.exit(0);
}

const result = installTemplates({});
console.log(`[huginn] installed ${result.installed.length}: ${result.installed.join(", ")}`);
if (result.skipped.length > 0) {
  console.log(`[huginn] skipped (already present): ${result.skipped.join(", ")}`);
}
console.log();
