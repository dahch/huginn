import { describe, it, expect } from "vitest";
import { getAgentRuntime, getEnginePort } from "../../../src/engine/agent/registry.js";

describe("getEnginePort", () => {
  it("returns a native port for every runtime with a driver", () => {
    expect(getEnginePort("pi").id).toBe("pi");
    expect(getEnginePort("opencode").id).toBe("opencode");
    expect(getEnginePort("codex").id).toBe("codex");
    expect(getEnginePort("claude").id).toBe("claude");
  });

  it("keeps the provisioning factory separate (getAgentRuntime)", () => {
    // The CLI-shaped view still exists for setup/model discovery.
    expect(getAgentRuntime("opencode").id).toBe("opencode");
  });

  it("declares the capabilities the engines rely on", () => {
    const opencode = getEnginePort("opencode");
    expect(opencode.capabilities.streaming).toBe(true);
    expect(opencode.capabilities.sessionResume).toBe(true);
    expect(opencode.capabilities.permissions).toBe("interactive");
    expect(typeof opencode.resumeSession).toBe("function");
  });
});
