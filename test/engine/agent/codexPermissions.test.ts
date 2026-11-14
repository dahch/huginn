import { describe, expect, it } from "vitest";
import { codexApprovalPolicy, createCodexSdkPort } from "../../../src/engine/agent/drivers/codex-sdk";

/**
 * Codex has a policy but no callback. These pin the mapping the declared
 * `gate` capability rests on, and the refusal that keeps `ask|deny` from
 * pretending to be honoured.
 */
describe("codex permission posture", () => {
  it("declares a gate, not an interactive channel", () => {
    const port = createCodexSdkPort({
      probe: async () => {},
      startThread: async () => ({
        run: async () => "ok",
      }),
    } as never);
    expect(port.capabilities.permissions).toBe("gate");
  });

  it("maps each huginn mode onto an approval policy", () => {
    expect(codexApprovalPolicy(undefined)).toBe("never");
    expect(codexApprovalPolicy("auto")).toBe("never");
    expect(codexApprovalPolicy("ask")).toBe("on-request");
    expect(codexApprovalPolicy("deny")).toBe("untrusted");
  });
});
