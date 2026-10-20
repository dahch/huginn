import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TARGET_RUNTIME,
  AGENT_TARGETS,
  RUNTIME_IDS,
  runtimeIdForTarget,
} from "../../../src/agents/integrator.js";
import { getAgentRuntime } from "../../../src/engine/agent/registry.js";
import {
  GENERIC_TARGETS,
  GENERIC_TARGET_SPECS,
} from "../../../src/engine/agent/genericTargets.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function installCli(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "huginn-generic-target-"));
  tempDirs.push(dir);
  const bin = join(dir, name);
  writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  chmodSync(bin, 0o755);
  return dir;
}

describe("RuntimeId vs provisioning target (M4b)", () => {
  it("keeps five runtimes and maps every provisioning target onto one", () => {
    expect(RUNTIME_IDS).toEqual(["pi", "codex", "claude", "opencode", "generic"]);
    for (const target of AGENT_TARGETS) {
      expect(RUNTIME_IDS).toContain(AGENT_TARGET_RUNTIME[target]);
      expect(runtimeIdForTarget(target)).toBe(AGENT_TARGET_RUNTIME[target]);
    }
    expect(AGENT_TARGETS).toHaveLength(13);
  });

  it("keeps the four dedicated drivers and routes the rest through generic", () => {
    expect(runtimeIdForTarget("pi")).toBe("pi");
    expect(runtimeIdForTarget("opencode")).toBe("opencode");
    expect(runtimeIdForTarget("codex")).toBe("codex");
    expect(runtimeIdForTarget("claude")).toBe("claude");
    for (const target of GENERIC_TARGETS) {
      expect(runtimeIdForTarget(target)).toBe("generic");
    }
    expect(GENERIC_TARGETS).toEqual([
      "cursor",
      "agy",
      "commandcode",
      "devin",
      "kimi",
      "mcode",
      "mimo",
      "omp",
      "qwen",
    ]);
  });
});

describe("configured generic runtimes (step 2 of M4b)", () => {
  it("constructs every CLI-only target and keeps its provisioning id", () => {
    for (const target of GENERIC_TARGETS) {
      const runtime = getAgentRuntime(target);
      expect(runtime.id, target).toBe(target);
      expect(runtime.name, target).toBe(GENERIC_TARGET_SPECS[target].name);
      // A subprocess CLI is one-shot: no server-side history to replay.
      expect(runtime.sessionHistory, target).toBe(false);
    }
  });

  it("keeps the secondary binary names for commandcode and qwen", async () => {
    const commandCodeDir = installCli("command-code");
    expect(await getAgentRuntime("commandcode", { env: { PATH: commandCodeDir } }).isAvailable()).toBe(
      true,
    );
    const qwenDir = installCli("qwen-code");
    expect(await getAgentRuntime("qwen", { env: { PATH: qwenDir } }).isAvailable()).toBe(true);
  });
});
