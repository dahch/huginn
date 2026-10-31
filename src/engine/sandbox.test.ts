import { describe, expect, it } from "bun:test";
import {
  formatSizeBytes,
  parseSizeBytes,
  planScopedCommand,
  planScopedShellCommand,
  resolveMemoryMax,
  resolveSwapMax,
  resolveTasksMax,
  userScopeAvailable,
  type ScopeOptions,
} from "./sandbox";

const GIB = 1024 ** 3;

/** Options that look like "Linux laptop, user manager present, binary on PATH". */
function scopeable(env: Record<string, string | undefined> = {}): ScopeOptions {
  return {
    env: {
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      ...env,
    },
    platform: "linux",
    totalBytes: 16 * GIB,
    exists: () => true,
    getuid: () => 1000,
  };
}

describe("parseSizeBytes", () => {
  it("parses the suffixes systemd accepts", () => {
    expect(parseSizeBytes("6G")).toBe(6 * GIB);
    expect(parseSizeBytes("512M")).toBe(512 * 1024 ** 2);
    expect(parseSizeBytes("1GiB")).toBe(GIB);
    expect(parseSizeBytes("2g")).toBe(2 * GIB);
  });

  it("treats a bare number as bytes", () => {
    expect(parseSizeBytes("1048576")).toBe(1048576);
  });

  it("rejects nonsense instead of guessing", () => {
    expect(parseSizeBytes("")).toBeUndefined();
    expect(parseSizeBytes("0")).toBeUndefined();
    expect(parseSizeBytes("-4G")).toBeUndefined();
    expect(parseSizeBytes("lots")).toBeUndefined();
    expect(parseSizeBytes("6 gigabytes")).toBeUndefined();
  });
});

describe("formatSizeBytes", () => {
  it("renders whole gigabytes and megabytes", () => {
    expect(formatSizeBytes(GIB)).toBe("1G");
    expect(formatSizeBytes(12 * GIB)).toBe("12G");
    expect(formatSizeBytes(900 * 1024 ** 2)).toBe("900M");
  });

  it("never rounds a positive size down to zero", () => {
    expect(formatSizeBytes(1)).toBe("1M");
  });
});

describe("resolveMemoryMax", () => {
  it("defaults to 70% of RAM", () => {
    expect(resolveMemoryMax(scopeable())).toBe("11G");
  });

  it("clamps tiny and huge machines", () => {
    expect(resolveMemoryMax({ ...scopeable(), totalBytes: GIB })).toBe("2G");
    expect(resolveMemoryMax({ ...scopeable(), totalBytes: 64 * GIB })).toBe("12G");
  });

  it("lets an explicit size win", () => {
    expect(resolveMemoryMax(scopeable({ HUGINN_MEMORY_MAX: "6G" }))).toBe("6G");
  });

  it("only an explicit off-value disables the cap", () => {
    for (const value of ["off", "none", "0", "false", "disabled"]) {
      expect(resolveMemoryMax(scopeable({ HUGINN_MEMORY_MAX: value }))).toBeUndefined();
    }
    // A typo must fall back to the automatic limit, not to "no protection".
    expect(resolveMemoryMax(scopeable({ HUGINN_MEMORY_MAX: "6GBs" }))).toBe("11G");
  });
});

describe("resolveSwapMax", () => {
  it("defaults to 4G and can be turned off", () => {
    expect(resolveSwapMax({})).toBe("4G");
    expect(resolveSwapMax({ HUGINN_MEMORY_SWAP_MAX: "off" })).toBeUndefined();
    expect(resolveSwapMax({ HUGINN_MEMORY_SWAP_MAX: "1G" })).toBe("1G");
  });
});

describe("resolveTasksMax", () => {
  it("defaults to 1024 and rejects non-positive values", () => {
    expect(resolveTasksMax({})).toBe(1024);
    expect(resolveTasksMax({ HUGINN_TASKS_MAX: "512" })).toBe(512);
    expect(resolveTasksMax({ HUGINN_TASKS_MAX: "0" })).toBe(1024);
    expect(resolveTasksMax({ HUGINN_TASKS_MAX: "many" })).toBe(1024);
  });
});

describe("userScopeAvailable", () => {
  it("is false off Linux and for root", () => {
    expect(userScopeAvailable({ ...scopeable(), platform: "darwin" })).toBe(false);
    expect(userScopeAvailable({ ...scopeable(), getuid: () => 0 })).toBe(false);
  });

  it("needs a reachable user manager socket", () => {
    expect(userScopeAvailable({ ...scopeable(), exists: () => false })).toBe(false);
    expect(userScopeAvailable(scopeable())).toBe(true);
  });
});

describe("planScopedCommand", () => {
  it("leaves the command untouched when the cap is disabled", () => {
    const planned = planScopedCommand("pi", ["-c"], scopeable({ HUGINN_MEMORY_MAX: "off" }));
    expect(planned).toEqual({ command: "pi", args: ["-c"], scoped: false });
  });

  it("leaves the command untouched where no user scope exists", () => {
    const planned = planScopedCommand("pi", ["-c"], { ...scopeable(), platform: "darwin" });
    expect(planned.scoped).toBe(false);
    expect(planned.command).toBe("pi");
  });

  it("wraps the payload with the resolved limits", () => {
    const planned = planScopedCommand("pi", ["-c"], scopeable());
    expect(planned.scoped).toBe(true);
    expect(planned.command).toBe("/usr/bin/systemd-run");
    expect(planned.args).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "-p",
      "MemoryMax=11G",
      "-p",
      "MemorySwapMax=4G",
      "-p",
      "TasksMax=1024",
      "--",
      "pi",
      "-c",
    ]);
  });

  it("escapes dollars so systemd expansion preserves shell semantics", () => {
    const planned = planScopedCommand("sh", ["-c", "kill -SEGV $$"], scopeable());
    expect(planned.args.slice(-2)).toEqual(["-c", "kill -SEGV $$$$"]);
  });

  it("omits MemorySwapMax when swap is disabled", () => {
    const planned = planScopedCommand("pi", [], scopeable({ HUGINN_MEMORY_SWAP_MAX: "off" }));
    expect(planned.args).not.toContain("MemorySwapMax");
    expect(planned.args.at(-2)).toBe("--");
    expect(planned.args.at(-1)).toBe("pi");
  });
});

describe("planScopedShellCommand", () => {
  it("runs verification commands through a signal-aware sh -c inside the scope", () => {
    const planned = planScopedShellCommand("cargo test --workspace", scopeable());
    expect(planned.scoped).toBe(true);
    // A nested shell reports the payload's 128+n status on every systemd
    // version, instead of the scope swallowing a signal as exit 1. The wrapper
    // carries no `$` of its own; only the payload keeps its dollars (escaped).
    expect(planned.args.slice(-3)).toEqual([
      "/bin/sh",
      "-c",
      "ulimit -c 0 2>/dev/null\n/bin/sh -c 'cargo test --workspace'\nexit",
    ]);
  });

  it("keeps the payload's own dollars through the wrapper", () => {
    const planned = planScopedShellCommand("kill -SEGV $$", scopeable());
    expect(planned.args.at(-1)).toBe(
      "ulimit -c 0 2>/dev/null\n/bin/sh -c 'kill -SEGV $$$$'\nexit",
    );
  });

  it("keeps the caller's shell semantics when unscoped", () => {
    const planned = planScopedShellCommand("cargo test", scopeable({ HUGINN_MEMORY_MAX: "off" }));
    expect(planned).toEqual({ command: "cargo test", args: [], scoped: false });
  });
});
