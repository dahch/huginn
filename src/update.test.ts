import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareVersions,
  checkForUpdate,
  isCacheFresh,
  readUpdateCache,
  writeUpdateCache,
  UPDATE_CHECK_TTL_MS,
} from "./update";

const configDir = join(import.meta.dir, "..", "..", ".tmp-update-test");

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