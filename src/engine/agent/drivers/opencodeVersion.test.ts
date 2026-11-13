import { describe, expect, it } from "bun:test";
import { opencodeMajorVersion } from "../adapters/opencode";
import { opencodeVersionRefusal } from "./opencode";

/**
 * The v1/v2 API split. A v2 binary serves /api/* and answers unknown paths with
 * the web app's HTML, so the v1 health check can only time out — the honest
 * answer is to refuse the binary by version, which is what this pins.
 */
describe("opencode version gate", () => {
  it("reads the major version from the shapes the CLI prints", () => {
    expect(opencodeMajorVersion("opencode v2.3.0")).toBe(2);
    expect(opencodeMajorVersion("1.18.14")).toBe(1);
    expect(opencodeMajorVersion("v1.2.3-beta.1")).toBe(1);
    expect(opencodeMajorVersion("garbage")).toBeUndefined();
    expect(opencodeMajorVersion("")).toBeUndefined();
  });

  it("refuses v2 and accepts v1", () => {
    expect(opencodeVersionRefusal("opencode v2.3.0")).toContain("v2 API");
    expect(opencodeVersionRefusal("opencode v2.3.0")).toContain("v1.x");
    expect(opencodeVersionRefusal("opencode v1.18.14")).toBeUndefined();
    expect(opencodeVersionRefusal("1.0.0")).toBeUndefined();
  });

  it("does not invent a refusal when the version is unreadable", () => {
    expect(opencodeVersionRefusal(undefined)).toBeUndefined();
    expect(opencodeVersionRefusal("not a version")).toBeUndefined();
  });
});
