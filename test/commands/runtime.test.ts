import { describe, it, expect, vi, afterEach } from "vitest";
import { handleRuntimeCommand } from "../../src/commands/runtime.js";
import type { RuntimeCapabilities, RuntimeId, RuntimePort } from "../../src/engine/agent/port.js";

const CAPS: RuntimeCapabilities = {
  inProcess: true, structuredEvents: false, streaming: false, permissions: "none",
  sessionHistory: true, sessionResume: false, modelCatalog: "dynamic",
  structuredOutput: false, usageCost: false, mcpListing: false, interrupt: true,
  filesystemIsolation: "worktree",
};

function port(caps: Partial<RuntimeCapabilities> = {}, available = true): RuntimePort {
  const merged = { ...CAPS, ...caps };
  return {
    id: "pi", name: "fake", capabilities: merged,
    async isAvailable() {
      return available ? { ok: true } : { ok: false, reason: "not signed in" };
    },
    async listModels() { return { models: [] }; },
    resolveModel(r) { return { ok: true, model: r }; },
    async createSession() { throw new Error("not used"); },
  };
}

const silent = () => vi.spyOn(console, "log").mockImplementation(() => {});

describe("huginn runtime list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("lists every runtime with its declared capabilities and never probes by default", async () => {
    const getPort = vi.fn((_id: RuntimeId) => port());
    silent();
    await handleRuntimeCommand("list", {}, { getPort });
    expect(getPort).toHaveBeenCalledTimes(5);
    expect(getPort.mock.calls.map((c) => c[0])).toEqual([
      "pi",
      "codex",
      "claude",
      "opencode",
      "generic",
    ]);
  });

  it("prints the capability text instead of claiming what is not there", async () => {
    const log = silent();
    await handleRuntimeCommand("list", {}, { getPort: () => port({ streaming: false, permissions: "none" }) });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("in-process");
    expect(out).toContain("history");
    expect(out).toContain("interrupt");
    expect(out).not.toContain("streaming");
    // The filesystem claim is printed even when it is the unflattering one.
    expect(out).toContain("fs: worktree only");
  });

  it("names a contained runtime as contained, and an uncontained one as such", async () => {
    const contained = silent();
    await handleRuntimeCommand("list", {}, {
      getPort: () => port({ filesystemIsolation: "home-read-only" }),
    });
    expect(contained.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "fs: home read-only",
    );
    contained.mockRestore();

    const none = silent();
    await handleRuntimeCommand("list", {}, {
      getPort: () => port({ filesystemIsolation: "none" }),
    });
    expect(none.mock.calls.map((c) => String(c[0])).join("\n")).toContain("fs: uncontained");
  });

  it("probes availability only with --check, and reports the reason", async () => {
    const log = silent();
    await handleRuntimeCommand("list", { "--check": true }, { getPort: () => port({}, false) });
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("unavailable: not signed in");
  });

  it("rejects an unknown subcommand", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    silent();
    await handleRuntimeCommand("nope", {}, { getPort: () => port() });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalled();
  });
});
