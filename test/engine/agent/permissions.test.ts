import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { AgentTarget } from "../../../src/agents/integrator.js";
import {
  GenericSubprocessRuntimeAdapter,
  withPermissionArgs,
} from "../../../src/engine/agent/adapters/generic.js";
import { getAgentRuntime, SUBPROCESS_PERMISSION_ARGS } from "../../../src/engine/agent/registry.js";
import { events } from "../../../src/engine/engineEvents.js";
import { LiveEngine } from "../../../src/engine/liveMode.js";
import { main } from "../../../src/cli.js";
import type { RunConfig } from "../../../src/config.js";
import type { IAgentRuntime, IAgentSession, PromptOptions } from "../../../src/engine/agent/types.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Installs a fake CLI that prints the argv it was spawned with (one token per
 * line), so a failure proves the *argv huginn actually built* — not just an
 * internal field.
 */
function installFakeCli(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "huginn-permissions-"));
  tempDirs.push(dir);
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@"\n`);
  chmodSync(bin, 0o755);
  return dir;
}

async function argvOf(session: IAgentSession, options?: PromptOptions): Promise<string[]> {
  const result = await session.prompt("go", options);
  return result.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Captures the engine log stream for the duration of one test. */
function captureLogs(): { logs: Array<{ level: string; message: string }>; off: () => void } {
  const logs: Array<{ level: string; message: string }> = [];
  const off = events.on("log", (e) => logs.push({ level: e.level, message: e.message }));
  return { logs, off };
}

describe("Phase 2C · withPermissionArgs", () => {
  it("returns the base argv untouched when the runtime has no flags", () => {
    expect(withPermissionArgs(["-p"], undefined)).toEqual(["-p"]);
    expect(withPermissionArgs(["-p"], [])).toEqual(["-p"]);
  });

  it("appends flags that are absent and never duplicates one already present", () => {
    expect(withPermissionArgs(["-p"], ["--yolo"])).toEqual(["-p", "--yolo"]);
    expect(withPermissionArgs(["-p", "--yolo"], ["--yolo"])).toEqual(["-p", "--yolo"]);
    // Inline form (`--flag=value`) counts as present too.
    expect(withPermissionArgs(["-p", "--yolo=true"], ["--yolo"])).toEqual(["-p", "--yolo=true"]);
  });

  it("drops the flag and its separate value when the pair is already there", () => {
    expect(withPermissionArgs(["--permission-mode", "safe"], ["--permission-mode", "dangerous"])).toEqual([
      "--permission-mode",
      "safe",
    ]);
    expect(withPermissionArgs(["-p"], ["--permission-mode", "dangerous"])).toEqual([
      "-p",
      "--permission-mode",
      "dangerous",
    ]);
  });
});

describe("Phase 2C · GenericSubprocessSession runs auto-approved", () => {
  it("appends the runtime's auto-approval flag to argv (default mode)", async () => {
    const dir = installFakeCli("kimi");
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "kimi",
      name: "Kimi Code CLI",
      command: "kimi",
      args: ["prompt"],
      permissionArgs: SUBPROCESS_PERMISSION_ARGS.kimi,
      env: { PATH: dir },
    });

    const session = await adapter.createSession({ title: "auto-approved" });
    expect(await argvOf(session)).toEqual(["prompt", "--auto"]);
  });

  it("does not duplicate a flag the base argv already carries", async () => {
    const dir = installFakeCli("claude");
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "claude",
      name: "Claude Code",
      command: "claude",
      args: ["-p", "--dangerously-skip-permissions"],
      permissionArgs: ["--dangerously-skip-permissions"],
      env: { PATH: dir },
    });

    const session = await adapter.createSession({ title: "no duplicate" });
    const argv = await argvOf(session);
    expect(argv).toEqual(["-p", "--dangerously-skip-permissions"]);
    expect(argv.filter((a) => a === "--dangerously-skip-permissions")).toHaveLength(1);
  });

  it("leaves the flags out when auto-approval is explicitly disabled", async () => {
    const dir = installFakeCli("kimi");
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "kimi",
      name: "Kimi Code CLI",
      command: "kimi",
      args: ["prompt"],
      permissionArgs: ["--auto"],
      autoApprovePermissions: false,
      env: { PATH: dir },
    });

    const session = await adapter.createSession({ title: "opt-out" });
    expect(await argvOf(session)).toEqual(["prompt"]);
  });

  it("never claims auto-approval when --permissions is ask or deny (REV-2C-001)", async () => {
    for (const mode of ["ask", "deny"] as const) {
      const dir = installFakeCli("qwen");
      const { logs, off } = captureLogs();
      try {
        const adapter = new GenericSubprocessRuntimeAdapter({
          id: "qwen",
          name: "Qwen Code",
          command: "qwen",
          args: ["prompt"],
          permissionArgs: ["-y"],
          permissions: mode,
          env: { PATH: dir },
        });

        const session = await adapter.createSession({ title: `permissions ${mode}` });
        // The flags are still wired (a subprocess CLI cannot be asked), but the
        // adapter must not log the misleading "auto-approved" claim: the CLI
        // refuses ask/deny fail-closed before a session is ever created, so
        // nothing is announced here.
        expect(await argvOf(session)).toEqual(["prompt", "-y"]);
        expect(logs.filter((l) => l.message.includes("auto-approved"))).toHaveLength(0);
        expect(logs.filter((l) => l.message.includes("--permissions"))).toHaveLength(0);
      } finally {
        off();
      }
    }
  });

  it("announces an unverified flag as assumed (warn), never as auto-approved (REV-2C-002)", async () => {
    for (const target of ["pi", "windsurf"] as const) {
      const dir = installFakeCli(target);
      const { logs, off } = captureLogs();
      try {
        const runtime = getAgentRuntime(target, { env: { PATH: dir }, permissions: "auto" });
        await runtime.createSession({ title: target });

        const warns = logs.filter((l) => l.level === "warn" && l.message.includes("not verified"));
        expect(warns).toHaveLength(1);
        expect(warns[0].message).toContain(`[huginn] ${target}: assuming `);
        expect(warns[0].message).toContain("the CLI may still prompt");
        // The verified claim must never appear for an unverified flag.
        expect(logs.filter((l) => l.message.includes("auto-approved permissions"))).toHaveLength(0);

        // Still once per runtime, not once per session.
        await runtime.createSession({ title: `${target} again` });
        expect(logs.filter((l) => l.level === "warn" && l.message.includes("not verified"))).toHaveLength(1);
      } finally {
        off();
      }
    }
  });

  it("logs the auto-approved mode once per runtime, not per prompt", async () => {
    const dir = installFakeCli("omp");
    const { logs, off } = captureLogs();
    try {
      const adapter = new GenericSubprocessRuntimeAdapter({
        id: "omp",
        name: "Oh My Pi",
        command: "omp",
        args: ["prompt"],
        permissionArgs: ["--auto-approve"],
        permissions: "auto",
        env: { PATH: dir },
      });

      const session = await adapter.createSession({ title: "transparency" });
      await argvOf(session);
      await argvOf(session);
      await adapter.createSession({ title: "second session" });

      const notices = logs.filter((l) => l.message.includes("auto-approved permissions"));
      expect(notices).toHaveLength(1);
      expect(notices[0].level).toBe("info");
      expect(notices[0].message).toContain("[huginn] omp: running with --auto-approve (auto-approved permissions)");
    } finally {
      off();
    }
  });
});

describe("Phase 2C · every subprocess runtime carries its auto-approval flag", () => {
  // The flag each CLI documents for running without permission prompts
  // (re-verified via `<cli> --help`; see `SUBPROCESS_PERMISSION_ARGS`).
  const runtimes: Array<{ target: AgentTarget; baseArgs: string[]; flags: string[] }> = [
    { target: "claude", baseArgs: ["-p"], flags: ["--dangerously-skip-permissions"] },
    { target: "codex", baseArgs: ["exec"], flags: ["--dangerously-bypass-approvals-and-sandbox"] },
    { target: "qwen", baseArgs: ["prompt"], flags: ["-y"] },
    { target: "omp", baseArgs: ["prompt"], flags: ["--auto-approve"] },
    { target: "commandcode", baseArgs: ["-p"], flags: ["--yolo"] },
    { target: "kimi", baseArgs: [], flags: ["--auto"] },
    { target: "pi", baseArgs: [], flags: ["--approve"] },
    { target: "cursor", baseArgs: [], flags: ["-f"] },
    { target: "windsurf", baseArgs: [], flags: ["--permission-mode", "dangerous"] },
    { target: "agy", baseArgs: [], flags: ["--dangerously-skip-permissions"] },
  ];

  for (const { target, baseArgs, flags } of runtimes) {
    it(
      `spawns \`${target}\` with ${flags.join(" ")}`,
      async () => {
        const dir = installFakeCli(target);
        const runtime = getAgentRuntime(target, { env: { PATH: dir }, permissions: "auto" });
        expect(runtime.id).toBe(target);

        const session = await runtime.createSession({ title: target });
        expect(await argvOf(session)).toEqual([...baseArgs, ...flags]);

        // The documented table and the adapter must never drift apart.
        expect(SUBPROCESS_PERMISSION_ARGS[target]).toEqual(flags);
      },
      20_000,
    );
  }

  it(
    "accepts a permissionArgs override through RuntimeOptions",
    async () => {
      const dir = installFakeCli("pi");
      const runtime = getAgentRuntime("pi", {
        env: { PATH: dir },
        permissionArgs: ["--trust-all"],
      });
      const session = await runtime.createSession({ title: "override" });
      expect(await argvOf(session)).toEqual(["--trust-all"]);
    },
    20_000,
  );
});

describe("Phase 2C · opencode keeps its subscriber-driven permissions", () => {
  it("ignores --permissions and never claims auto-approval in argv or logs", async () => {
    const mockPrompt = vi.fn().mockResolvedValue({
      info: { id: "msg-1" },
      parts: [{ type: "text", text: "ok" }],
    });
    const mockClient = {
      session: {
        create: vi.fn().mockResolvedValue({ id: "ses-opencode" }),
        prompt: mockPrompt,
      },
    } as unknown as OpencodeClient;

    const { logs, off } = captureLogs();
    try {
      const runtime = getAgentRuntime("opencode", { client: mockClient, permissions: "ask" });
      const session = await runtime.createSession({ title: "opencode" });
      await session.prompt("hello");

      // opencode's permissions flow through `subscribeToEvents`, not through a
      // CLI flag: nothing is announced and no argv is built here at all.
      expect(mockPrompt).toHaveBeenCalled();
      expect(logs.filter((l) => l.message.includes("auto-approved permissions"))).toHaveLength(0);
      expect(logs.filter((l) => l.message.includes("--permissions"))).toHaveLength(0);
    } finally {
      off();
    }
  });
});

/** Minimal IAgentRuntime stub for the switchRuntime gate (no session is used). */
function stubRuntime(id: AgentTarget): IAgentRuntime {
  return {
    id,
    name: `stub ${id}`,
    isAvailable: async () => true,
    getAvailableModels: async () => [],
    getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: false }),
    createSession: async () => {
      throw new Error("createSession is not expected in this test");
    },
  };
}

function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    projectPath: "/tmp/huginn-permissions",
    planPath: "/tmp/huginn-permissions/plan.md",
    specPath: "/tmp/huginn-permissions/spec.md",
    adrPath: "/tmp/huginn-permissions/adr.md",
    thinker: "anthropic/claude-opus-4-5",
    executor: "opencode/gpt-5.1-codex",
    agent: "opencode",
    mode: "auto",
    permissions: "auto",
    maxRetries: 1,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 1000,
    ignorePlanChanges: false,
    sandbox: false,
    ...overrides,
  };
}

describe("Phase 2C · LiveEngine.switchRuntime fails closed for subprocess + ask/deny (REV-2C-001)", () => {
  for (const mode of ["ask", "deny"] as const) {
    it(`refuses to switch to a subprocess runtime in --permissions ${mode}, keeping the active one`, async () => {
      const live = new LiveEngine({
        cfg: makeRunConfig({ permissions: mode }),
        runtime: stubRuntime("opencode"),
        runtimeFactory: () => stubRuntime("claude"),
      });

      await expect(live.switchRuntime("claude")).rejects.toThrow(
        `--permissions ${mode} is not supported for the "claude" subprocess runtime`,
      );
      // The runtime is untouched: no partial switch happened.
      expect(live.runtime.id).toBe("opencode");
    });
  }

  it("still switches to a subprocess runtime under --permissions auto", async () => {
    const live = new LiveEngine({
      cfg: makeRunConfig({ permissions: "auto" }),
      runtime: stubRuntime("opencode"),
      runtimeFactory: () => stubRuntime("claude"),
    });

    const switched = await live.switchRuntime("claude");
    expect(switched.id).toBe("claude");
    expect(live.runtime.id).toBe("claude");
  });
});

describe("Phase 2C · CLI gate for --permissions (REV-2C-001/REV-2C-004)", () => {
  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "huginn-permissions-cli-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "plan.md"), "# Plan\n\n## Iteration 1 — Feature\n\nDo the thing.\n");
    writeFileSync(join(dir, "spec.md"), "# Spec\n\nREQ-1: thing\n");
    writeFileSync(join(dir, "adr.md"), "# ADR\n");
    return dir;
  }

  function installExitSpy(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as unknown as typeof process.exit);
  }

  const originalNoUpdateCheck = process.env.HUGINN_NO_UPDATE_CHECK;

  beforeAll(() => {
    // Keep the fire-and-forget update reminder off the network in tests.
    process.env.HUGINN_NO_UPDATE_CHECK = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (originalNoUpdateCheck === undefined) delete process.env.HUGINN_NO_UPDATE_CHECK;
    else process.env.HUGINN_NO_UPDATE_CHECK = originalNoUpdateCheck;
  });

  for (const command of ["run", "live"] as const) {
    for (const mode of ["ask", "deny"] as const) {
      it(`\`${command} --permissions ${mode}\` with a subprocess runtime errors and exits 1`, async () => {
        const dir = makeProject();
        installExitSpy();
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});

        const args = [command, "--project", dir, "--agent", "claude", "--permissions", mode];
        if (command === "run") {
          args.push("--thinker", "anthropic/claude-opus-4-5", "--executor", "opencode/gpt-5.1-codex");
        }

        await expect(main(args)).rejects.toThrow(/process\.exit\(1\)/);
        expect(process.exit).toHaveBeenCalledWith(1);
        const stderr = errorSpy.mock.calls.flat().join(" ");
        expect(stderr).toContain(`--permissions ${mode} is not supported for the "claude" subprocess runtime`);
        expect(stderr).toContain(`Use "auto" (default) or choose the opencode runtime.`);
      });
    }
  }

  it("rejects an invalid --permissions value with exit 1 instead of falling back to auto (REV-2C-004)", async () => {
    const dir = makeProject();
    installExitSpy();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      main(["run", "--project", dir, "--agent", "claude", "--permissions", "denn"]),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain(
      'Invalid --permissions "denn". Valid: auto, ask, deny',
    );
  });
});
