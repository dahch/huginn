import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import pkg from "../package.json";
import { getOpencodeConfigDir } from "./setup/install";

export const UPDATE_CHECK_URL = `https://registry.npmjs.org/${pkg.name}/latest`;
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCache {
  checkedAt: string;
  latest: string;
}

function coreParts(v: string): number[] {
  return v
    .split("-")[0]
    ?.split(".")
    .map((s) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    }) ?? [0];
}

function preParts(v: string): string[] {
  const dash = v.indexOf("-");
  return dash === -1 ? [] : v.slice(dash + 1).split(".");
}

function comparePreSegment(x: string, y: string): number {
  if (x === y) return 0;
  const nx = Number(x);
  const ny = Number(y);
  const numericX = Number.isFinite(nx);
  const numericY = Number.isFinite(ny);
  if (numericX && numericY) return nx < ny ? -1 : 1;
  if (numericX) return -1;
  if (numericY) return 1;
  return x < y ? -1 : 1;
}

/**
 * Lightweight semver comparison: numeric dot-segments first, then the
 * prerelease suffix (a release is newer than a prerelease of the same core,
 * and prerelease identifiers compare segment-wise — numeric numerically,
 * numeric before alphanumeric, shorter prefix first).
 */
export function compareVersions(a: string, b: string): number {
  const pa = coreParts(a);
  const pb = coreParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const preA = preParts(a);
  const preB = preParts(b);
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const cmp = comparePreSegment(x, y);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function cachePath(): string {
  return join(getOpencodeConfigDir(), "huginn-update-cache.json");
}

export function readUpdateCache(): UpdateCache | null {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as UpdateCache;
    if (typeof parsed?.latest !== "string" || typeof parsed?.checkedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeUpdateCache(latest: string): void {
  try {
    mkdirSync(getOpencodeConfigDir(), { recursive: true });
    writeFileSync(
      cachePath(),
      JSON.stringify({ checkedAt: new Date().toISOString(), latest }),
      "utf8",
    );
  } catch {
    // best effort — a failed cache write must never break the run
  }
}

export function isCacheFresh(cache: UpdateCache): boolean {
  const checked = Date.parse(cache.checkedAt);
  if (!Number.isFinite(checked)) return false;
  return Date.now() - checked < UPDATE_CHECK_TTL_MS;
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const res = await fetch(UPDATE_CHECK_URL, {
      signal: controller.signal,
      headers: { "user-agent": `huginn/${pkg.version}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the latest published version when it is newer than the installed
 * one, otherwise null. Checks the registry at most once per TTL; a stale
 * cache is used as fallback when the registry is unreachable. Disable with
 * HUGINN_NO_UPDATE_CHECK=1 (any non-empty value disables the check).
 */
export async function checkForUpdate(): Promise<string | null> {
  if (process.env.HUGINN_NO_UPDATE_CHECK) return null;
  const cached = readUpdateCache();
  if (cached && isCacheFresh(cached)) {
    return compareVersions(cached.latest, pkg.version) > 0 ? cached.latest : null;
  }
  const latest = await fetchLatestVersion();
  if (latest === null) {
    return cached && compareVersions(cached.latest, pkg.version) > 0 ? cached.latest : null;
  }
  writeUpdateCache(latest);
  return compareVersions(latest, pkg.version) > 0 ? latest : null;
}

export function printUpdateReminder(latest: string): void {
  console.error(
    chalk.yellow(`[huginn] ⬆ A new version of huginn is available: v${pkg.version} → v${latest}`) +
      `\n${chalk.dim("  Update:")} ${chalk.cyan(`npm i -g ${pkg.name}@latest`)} ${chalk.dim(`(or bun add -g ${pkg.name}@latest)`)}`,
  );
}

/**
 * Fire-and-forget entry point: never awaited, fails silent, prints the
 * reminder to stderr only when a newer version exists. Must not be awaited —
 * the check must never delay or block the run (the fetch timeout timer is
 * unref'd so it cannot hold the event loop open).
 */
export async function maybePrintUpdateReminder(): Promise<void> {
  try {
    const latest = await checkForUpdate();
    if (latest) printUpdateReminder(latest);
  } catch {
    // never fail a run because of an update check
  }
}

