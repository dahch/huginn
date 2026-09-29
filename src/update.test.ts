import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  checkForUpdate,
  isCacheFresh,
  readUpdateCache,
  writeUpdateCache,
  UPDATE_CHECK_TTL_MS,
} from "./update";

const configDir = join(import.meta.dir, "..", ".tmp-update-test");

function freshCache(latest: string, ageMs = 0): void {
  writeUpdateCache(latest);
  const checkedAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(join(configDir, "huginn-update-cache.json"), JSON.stringify({ checkedAt, latest }));
}

beforeEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  process.env.HUGINN_OPENCODE_CONFIG_DIR = configDir;
  delete process.env.HUGINN_NO_UPDATE_CHECK;
});

afterEach(() => {
  delete process.env.HUGINN_OPENCODE_CONFIG_DIR;
  delete process.env.HUGINN_NO_UPDATE_CHECK;
  rmSync(configDir, { recursive: true, force: true });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
  });

  it("orders by numeric dot segments", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  it("treats a release as newer than a prerelease of the same core", () => {
    expect(compareVersions("1.1.0", "1.1.0-beta.1")).toBe(1);
    expect(compareVersions("1.1.0-beta.2", "1.1.0-beta.1")).toBe(1);
    expect(compareVersions("1.1.0-beta.1", "1.1.0")).toBe(-1);
  });

  it("orders prerelease identifiers segment-wise", () => {
    expect(compareVersions("1.1.0-alpha", "1.1.0-beta")).toBe(-1);
    expect(compareVersions("1.1.0-beta.10", "1.1.0-beta.2")).toBe(1);
    expect(compareVersions("1.1.0-beta.2", "1.1.0-beta.10")).toBe(-1);
    expect(compareVersions("1.1.0-beta.10", "1.1.0-beta.10")).toBe(0);
    expect(compareVersions("1.1.0-alpha", "1.1.0-alpha.1")).toBe(-1);
  });

  it("handles malformed input without throwing", () => {
    expect(compareVersions("garbage", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "")).toBe(1);
    expect(compareVersions("", "")).toBe(0);
  });
});

describe("update cache", () => {
  it("round-trips write and read", () => {
    writeUpdateCache("2.0.0");
    const cached = readUpdateCache();
    expect(cached?.latest).toBe("2.0.0");
    expect(typeof cached?.checkedAt).toBe("string");
  });

  it("returns null for a missing or corrupt cache", () => {
    expect(readUpdateCache()).toBeNull();
    writeFileSync(join(configDir, "huginn-update-cache.json"), "{not json");
    expect(readUpdateCache()).toBeNull();
  });

  it("isCacheFresh honors the TTL", () => {
    freshCache("2.0.0");
    const fresh = readUpdateCache();
    expect(fresh).not.toBeNull();
    expect(isCacheFresh(fresh!)).toBe(true);

    freshCache("2.0.0", UPDATE_CHECK_TTL_MS + 1000);
    expect(isCacheFresh(readUpdateCache()!)).toBe(false);
  });

  it("writes the cache atomically as 0o600, leaving no temp file behind (SEC-105)", () => {
    writeUpdateCache("2.0.0");

    expect(readdirSync(configDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(configDir, "huginn-update-cache.json"), "utf8")).latest).toBe(
      "2.0.0",
    );
    if (process.platform === "win32") return; // no POSIX mode bits to assert
    expect(statSync(join(configDir, "huginn-update-cache.json")).mode & 0o777).toBe(0o600);
  });

  it("never follows a symlink planted at the cache path (SEC-105)", () => {
    // The cache lives in a *user* directory, but a same-user attacker (or a stray
    // link) is exactly the case: the write must replace the name, never the link's
    // target, and must refuse the path outright when it is a link.
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "huginn-update-victim-"));
    try {
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "keep me\n");
      symlinkSync(victim, join(configDir, "huginn-update-cache.json"));

      writeUpdateCache("9.9.9");

      expect(readFileSync(victim, "utf8")).toBe("keep me\n");
      // Nothing was written through the link either: the target is not JSON.
      expect(readUpdateCache()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkForUpdate", () => {
  it("returns null when the update check is disabled", async () => {
    process.env.HUGINN_NO_UPDATE_CHECK = "1";
    freshCache("99.0.0");
    expect(await checkForUpdate()).toBeNull();
  });

  it("serves a fresh cache without hitting the registry", async () => {
    freshCache("99.0.0");
    expect(await checkForUpdate()).toBe("99.0.0");
  });

  it("returns null when a fresh cache has no newer version", async () => {
    freshCache("0.0.1");
    expect(await checkForUpdate()).toBeNull();
  });

  it("falls back to a stale cache when the registry is unreachable", async () => {
    freshCache("99.0.0", UPDATE_CHECK_TTL_MS + 1000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    try {
      expect(await checkForUpdate()).toBe("99.0.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refetches when the cache is stale and the registry reports a newer version", async () => {
    freshCache("0.0.1", UPDATE_CHECK_TTL_MS + 1000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 }))) as unknown as typeof fetch;
    try {
      expect(await checkForUpdate()).toBe("99.0.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null when a stale cache has no newer version and the registry is unreachable", async () => {
    freshCache("0.0.1", UPDATE_CHECK_TTL_MS + 1000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    try {
      expect(await checkForUpdate()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});