import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Directory where opencode loads its configuration, and where huginn keeps its
 * update-check cache (`huginn-update-cache.json`). `HUGINN_OPENCODE_CONFIG_DIR`
 * overrides the default `<home>/.config/opencode`, so tests and custom installs
 * can point at an isolated directory.
 */
export function getOpencodeConfigDir(): string {
  const override = process.env.HUGINN_OPENCODE_CONFIG_DIR;
  if (override) return resolve(override);
  return join(homedir(), ".config", "opencode");
}
