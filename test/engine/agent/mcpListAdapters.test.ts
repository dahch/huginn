import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ClaudeRuntimeAdapter,
  CommandCodeRuntimeAdapter,
  MimoRuntimeAdapter,
  OmpRuntimeAdapter,
  OpencodeRuntimeAdapter,
  QwenRuntimeAdapter,
} from "../../../src/engine/agent/adapters/index.js";
import { getAgentRuntime } from "../../../src/engine/agent/registry.js";
import type { IAgentRuntime } from "../../../src/engine/agent/types.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/**
 * Installs a fake CLI in a temp dir that answers *only* the verified argv
 * (`<cli> mcp list`) by echoing a captured fixture, so a test failure proves the
 * wiring (binary + argv + parser), not just the parser (REQ-32 / AC-32.1).
 *
 * The real `PATH` is kept behind the temp dir so the script can still use
 * external utilities (`cat`); the fake binary shadows the real one.
 *
 * Returns the `PATH` to hand to the adapter, and a cleanup.
 */
function installFakeCli(binary: string, fixtureFile: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `huginn-mcp-wiring-${binary}-`));
  const script = join(dir, binary);
  writeFileSync(
    script,
    "#!/bin/sh\n" +
      '[ "$1" = "mcp" ] && [ "$2" = "list" ] || exit 9\n' +
      `cat '${join(FIXTURES, fixtureFile)}'\n`,
  );
  chmodSync(script, 0o755);
  return {
    path: `${dir}:${process.env.PATH ?? ""}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** True when the fixture is non-empty and really was the source of a listing. */
function fixtureText(file: string): string {
  return readFileSync(join(FIXTURES, file), "utf8");
}

describe("runtimes enumerate their own MCP servers (REQ-32 / AC-32.1)", () => {
  it("opencode runs `opencode mcp list` and attributes the servers to itself", async () => {
    const { path: cliPath, cleanup } = installFakeCli("opencode", "opencode-mcp-list.txt");
    try {
      const adapter = new OpencodeRuntimeAdapter({ env: { PATH: cliPath } });
      const listings = await adapter.listMcpServers();

      expect(listings.map((l) => l.name)).toEqual(["playwright", "codegraph", "engram"]);
      expect(listings.every((l) => l.status === "connected")).toBe(true);
      expect(listings[0]?.detail).toBe("npx @playwright/mcp@latest");
      // The captured ANSI codes never survive into a listing.
      expect(JSON.stringify(listings)).not.toContain("\u001b");
    } finally {
      cleanup();
    }
  });

  it("claude runs `claude mcp list` and reports its health-checked statuses", async () => {
    const { path: cliPath, cleanup } = installFakeCli("claude", "claude-mcp-list.txt");
    try {
      const adapter = new ClaudeRuntimeAdapter({ env: { PATH: cliPath } });
      const listings = await adapter.listMcpServers();

      expect(listings).toHaveLength(3);
      expect(listings.map((l) => l.name)).toEqual([
        "plugin:engram:engram",
        "leann-server",
        "codegraph",
      ]);
      expect(listings.every((l) => l.status === "connected")).toBe(true);
      // The 15 s health-check deadline is the *CLI* bound; the ladder stays
      // bounded (NFR-9) and the spawn above proves the argv.
      expect(fixtureText("claude-mcp-list.txt")).toContain("Checking MCP server health");
    } finally {
      cleanup();
    }
  });

  it("qwen runs `qwen mcp list` and keeps the transport the CLI reported", async () => {
    const { path: cliPath, cleanup } = installFakeCli("qwen", "qwen-mcp-list.txt");
    try {
      const adapter = new QwenRuntimeAdapter({ env: { PATH: cliPath } });
      const listings = await adapter.listMcpServers();

      expect(listings).toEqual([
        {
          name: "engram",
          transport: "stdio",
          status: "connected",
          detail: "/opt/homebrew/bin/engram mcp --tools=agent",
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("commandcode runs `commandcode mcp list` and surfaces scope as detail", async () => {
    const { path: cliPath, cleanup } = installFakeCli("commandcode", "commandcode-mcp-list.txt");
    try {
      const adapter = new CommandCodeRuntimeAdapter({ env: { PATH: cliPath } });
      const listings = await adapter.listMcpServers();

      expect(listings).toEqual([
        { name: "muninn", transport: "stdio", status: "enabled", detail: "scope user" },
      ]);
    } finally {
      cleanup();
    }
  });

  it("agy (registry construction) runs `agy mcp list` and reports configured, not live", async () => {
    const { path: cliPath, cleanup } = installFakeCli("agy", "agy-mcp-list.txt");
    try {
      const runtime = getAgentRuntime("agy", { env: { PATH: cliPath } });
      const listings = await runtime.listMcpServers?.();

      expect(listings?.map((l) => l.name)).toEqual([
        "codegraph",
        "engram",
        "muninn",
        "sequential-thinking",
        "tabularis",
      ]);
      expect(listings?.every((l) => l.status === "enabled")).toBe(true);
      expect(listings?.some((l) => l.status === "connected")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("mimo (Phase 3B) runs `mimo mcp list`, whose box list is opencode's own format", async () => {
    // MiMo Code is an opencode-derived CLI and prints the exact same box list,
    // so the *shared* parser is what consumes it. Re-verified against a fresh
    // capture (test/fixtures/mimo-mcp-list.txt) rather than assumed from the
    // lineage: the status cell also carries the config the server came from
    // (`connected claude:~/.claude.json`), which must not become the status.
    const { path: cliPath, cleanup } = installFakeCli("mimo", "mimo-mcp-list.txt");
    try {
      const runtime = getAgentRuntime("mimo", { env: { PATH: cliPath } });
      const listings = await runtime.listMcpServers?.();

      expect(listings).toEqual([
        {
          name: "leann-server",
          transport: "stdio",
          status: "connected",
          detail: "leann_mcp",
        },
        {
          name: "codegraph",
          transport: "stdio",
          status: "connected",
          detail: "codegraph serve --mcp",
        },
        {
          name: "muninn",
          transport: "stdio",
          status: "connected",
          detail: "huginn mcp run --project /home/dev/projects/huginn",
        },
      ]);
      expect(JSON.stringify(listings)).not.toContain("\u001b");
    } finally {
      cleanup();
    }
  });

  it("devin (registry construction) runs `devin mcp list`, keeping enabled/disabled and transport", async () => {
    const { path: cliPath, cleanup } = installFakeCli("devin", "devin-mcp-list.txt");
    try {
      const runtime = getAgentRuntime("devin", { env: { PATH: cliPath } });
      const listings = await runtime.listMcpServers?.();

      expect(listings?.map((l) => l.name)).toEqual([
        "leann-server",
        "codegraph",
        "muninn",
        "playwright",
        "testhttp",
        "teststdio",
      ]);
      // The CLI's own configuration word (never a liveness probe).
      expect(listings?.find((l) => l.name === "teststdio")).toEqual({
        name: "teststdio",
        status: "disabled",
        transport: "stdio",
        detail: "echo",
      });
      // A remote server is `URL: …` → an http transport.
      expect(listings?.find((l) => l.name === "testhttp")).toEqual({
        name: "testhttp",
        status: "enabled",
        transport: "http",
        detail: "https://example.com/mcp",
      });
      // A redacted command stays verbatim rather than being guessed at.
      expect(listings?.find((l) => l.name === "playwright")?.detail).toBe("<redacted>");
      expect(listings?.some((l) => l.status === "connected")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("opencode reads its binary override so a wrapper can be enumerated too", async () => {
    // Two different CLIs in one temp dir, both emitting *opencode-format* output so
    // the parser is not the variable: the wrapper answers with opencode's captured
    // fixture, the default binary with a one-server listing — so the assertion can
    // only pass if the override really chose the binary (REQ-32 / AC-32.1).
    const dir = mkdtempSync(join(tmpdir(), "huginn-mcp-wiring-override-"));
    try {
      const scripts: Array<[string, string]> = [
        ["opencode", "┌  MCP Servers\n│\n●  ✓ default-only connected\n│      default-cmd\n└  1 server(s)\n"],
        ["opencode-wrapper", fixtureText("opencode-mcp-list.txt")],
      ];
      for (const [binary, body] of scripts) {
        const script = join(dir, binary);
        writeFileSync(
          script,
          "#!/bin/sh\n" +
            '[ "$1" = "mcp" ] && [ "$2" = "list" ] || exit 9\n' +
            `cat <<'HUGINN_EOF'\n${body}HUGINN_EOF\n`,
        );
        chmodSync(script, 0o755);
      }
      const path = `${dir}:${process.env.PATH ?? ""}`;

      const overridden = new OpencodeRuntimeAdapter({ env: { PATH: path }, mcpListCommand: "opencode-wrapper" });
      expect((await overridden.listMcpServers()).map((l) => l.name)).toEqual([
        "playwright",
        "codegraph",
        "engram",
      ]);

      const defaultBinary = new OpencodeRuntimeAdapter({ env: { PATH: path } });
      expect((await defaultBinary.listMcpServers()).map((l) => l.name)).toEqual(["default-only"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves [] (never a throw) for a missing binary", async () => {
    const empty = mkdtempSync(join(tmpdir(), "huginn-mcp-wiring-empty-"));
    try {
      const runtimes: IAgentRuntime[] = [
        new OpencodeRuntimeAdapter({ env: { PATH: empty } }),
        new ClaudeRuntimeAdapter({ env: { PATH: empty } }),
        new QwenRuntimeAdapter({ env: { PATH: empty } }),
        new CommandCodeRuntimeAdapter({ env: { PATH: empty } }),
        // Phase 3B: `mimo mcp list` is wired but the binary is absent here.
        new MimoRuntimeAdapter({ env: { PATH: empty } }),
        getAgentRuntime("agy", { env: { PATH: empty } }),
      ];
      for (const runtime of runtimes) {
        await expect(runtime.listMcpServers?.()).resolves.toEqual([]);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("runtimes without a listing command answer [] so callers fall back to config discovery", async () => {
    const { path: cliPath, cleanup } = installFakeCli("omp", "opencode-mcp-list.txt");
    try {
      // `omp` is present on PATH, but exposes no MCP listing command: the honest
      // answer is "nothing enumerated", not another CLI's output.
      const omp = new OmpRuntimeAdapter({ env: { PATH: cliPath } });
      expect(await omp.listMcpServers()).toEqual([]);

      // `mcode` is the same: the CLI has no `mcp` command at all, so its absence
      // is reported as "nothing enumerated" rather than a fabricated listing —
      // even when a fake binary echoes opencode's output.
      for (const target of ["kimi", "pi", "cursor", "codex", "mcode"] as const) {
        const runtime = getAgentRuntime(target, { env: { PATH: cliPath } });
        expect(await runtime.listMcpServers?.(), target).toEqual([]);
      }
    } finally {
      cleanup();
    }
  });
});
