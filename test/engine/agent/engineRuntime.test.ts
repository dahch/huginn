import { describe, it, expect } from "vitest";
import { getAgentRuntime, getEngineRuntime } from "../../../src/engine/agent/registry.js";

describe("getEngineRuntime", () => {
  it("routes pi to the native in-process driver", () => {
    const runtime = getEngineRuntime("pi");
    expect(runtime.id).toBe("pi");
    expect(runtime.name).toContain("in-process");
    // A native session keeps history; it does not stream yet, and it says so.
    expect(runtime.sessionHistory).toBe(true);
    expect(runtime.streamsOutput).toBe(false);
  });

  it("leaves every other target on the adapter the cycle already used", () => {
    expect(getEngineRuntime("opencode").id).toBe("opencode");
    expect(getEngineRuntime("codex").id).toBe("codex");
  });

  it("keeps the CLI-shaped factory on the subprocess adapter", () => {
    // Provisioning, model discovery and the argv-level tests keep the CLI shape.
    expect(getAgentRuntime("pi").name).not.toContain("in-process");
  });
});
