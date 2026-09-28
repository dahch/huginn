import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_MCP_LIST_TIMEOUT_MS,
  MCP_LIST_TIMEOUT_MS,
  inferListingTransport,
  listMcpServersViaCommand,
  mapMcpListingStatus,
  parseAgyMcpList,
  parseClaudeMcpList,
  parseCommandcodeMcpList,
  parseOpencodeMcpList,
  parseQwenMcpList,
  runMcpListCommand,
} from "../../../src/engine/agent/adapters/mcpList.js";
import type { McpListingStatus } from "../../../src/engine/agent/types.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/** Captured, real CLI output (see test/fixtures/README.md for provenance). */
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

describe("per-agent MCP listing parsers (REQ-32 / AC-32.1)", () => {
  it("parses `opencode mcp list` and strips the ANSI codes around the status word", () => {
    const raw = fixture("opencode-mcp-list.txt");
    // The captured output really does carry colour codes: the parser must not
    // depend on them disappearing first (AC-32.1).
    expect(raw).toContain("\u001b[90m");

    expect(parseOpencodeMcpList(raw)).toEqual([
      { name: "playwright", transport: "stdio", status: "connected", detail: "npx @playwright/mcp@latest" },
      { name: "codegraph", transport: "stdio", status: "connected", detail: "codegraph serve --mcp" },
      {
        name: "engram",
        transport: "stdio",
        status: "connected",
        detail: "/opt/homebrew/bin/engram mcp --tools=agent",
      },
    ]);
  });

  it("never turns the opencode box heading or the `N server(s)` footer into a server", () => {
    const listings = parseOpencodeMcpList(fixture("opencode-mcp-list.txt"));
    const names = listings.map((l) => l.name);
    expect(names).toEqual(["playwright", "codegraph", "engram"]);
    for (const junk of ["MCP Servers", "3 server(s)", "server(s)", "npx @playwright/mcp@latest"]) {
      expect(names).not.toContain(junk);
    }
    // …nor does the command line become the following server's name.
    expect(names.some((name) => name.includes(" "))).toBe(false);
  });

  it("parses `claude mcp list` past its health-check preamble", () => {
    expect(parseClaudeMcpList(fixture("claude-mcp-list.txt"))).toEqual([
      {
        name: "plugin:engram:engram",
        transport: "stdio",
        status: "connected",
        detail: "engram mcp --tools=agent",
      },
      { name: "leann-server", transport: "stdio", status: "connected", detail: "leann_mcp" },
      { name: "codegraph", transport: "stdio", status: "connected", detail: "codegraph serve --mcp" },
    ]);
  });

  it("keeps a name that contains colons intact and drops the preamble", () => {
    const listings = parseClaudeMcpList(fixture("claude-mcp-list.txt"));
    expect(listings.map((l) => l.name)).toContain("plugin:engram:engram");
    expect(listings.map((l) => l.name)).not.toContain("Checking MCP server health…");
  });

  it("parses `qwen mcp list` including the reported transport", () => {
    expect(parseQwenMcpList(fixture("qwen-mcp-list.txt"))).toEqual([
      {
        name: "engram",
        transport: "stdio",
        status: "connected",
        detail: "/opt/homebrew/bin/engram mcp --tools=agent",
      },
    ]);
  });

  it("parses `agy mcp list` as configuration (`enabled`), never as a live probe", () => {
    const listings = parseAgyMcpList(fixture("agy-mcp-list.txt"));
    expect(listings.map((l) => l.name)).toEqual([
      "codegraph",
      "engram",
      "muninn",
      "sequential-thinking",
      "tabularis",
    ]);
    expect(listings.map((l) => l.status)).toEqual([
      "enabled",
      "enabled",
      "enabled",
      "enabled",
      "enabled",
    ]);
    expect(listings.every((l) => l.transport === "stdio")).toBe(true);
    expect(listings.find((l) => l.name === "muninn")?.detail).toContain("huginn mcp run");
    // The `NAME TYPE STATUS COMMAND/URL` header is not a server.
    expect(listings.map((l) => l.name)).not.toContain("NAME");
  });

  it("parses `commandcode mcp list` with scope as detail and drops the footer", () => {
    const listings = parseCommandcodeMcpList(fixture("commandcode-mcp-list.txt"));
    expect(listings).toEqual([
      { name: "muninn", transport: "stdio", status: "enabled", detail: "scope user" },
    ]);
    expect(listings.map((l) => l.name)).not.toContain("MCP Servers");
    expect(listings.map((l) => l.name)).not.toContain("Total: 1 server");
    expect(listings.map((l) => l.name)).not.toContain("NAME");
  });

  it("returns [] for empty or unstructured output instead of inventing servers", () => {
    for (const parser of [
      parseOpencodeMcpList,
      parseClaudeMcpList,
      parseQwenMcpList,
      parseAgyMcpList,
      parseCommandcodeMcpList,
    ]) {
      expect(parser("")).toEqual([]);
      expect(parser("\n\n   \n")).toEqual([]);
    }
    expect(parseOpencodeMcpList("┌  MCP Servers\n│\n└  0 server(s)\n")).toEqual([]);
    expect(parseClaudeMcpList("Checking MCP server health…\n\nNo MCP servers configured.\n")).toEqual([]);
    expect(parseQwenMcpList("Configured MCP servers:\n")).toEqual([]);
    expect(parseCommandcodeMcpList("MCP Servers\n\nTotal: 0 server(s)\n")).toEqual([]);
  });

  it("strips ANSI codes and never claims a transport it was not told about", () => {
    const colored = "\u001b[90m●  ✓ demo \u001b[32mconnected\u001b[0m\n";
    expect(parseOpencodeMcpList(colored)).toEqual([
      { name: "demo", transport: undefined, status: "connected", detail: undefined },
    ]);
    expect(parseOpencodeMcpList(colored)[0]?.name).not.toContain("\u001b");
  });
});

describe("honest listing→status mapping (AC-32.2)", () => {
  it("maps every status word the CLIs print to its true meaning", () => {
    const table: Array<[string, McpListingStatus]> = [
      ["connected", "connected"],
      ["Connected", "connected"],
      ["✔", "connected"],
      ["✓ Connected", "connected"],
      ["healthy", "connected"],
      ["enabled", "enabled"],
      ["enabled\n", "enabled"],
      ["configured", "enabled"],
      ["➜ ready", "enabled"],
      ["disabled", "disabled"],
      ["pending approval", "pending"],
      ["pending", "pending"],
      // Anything unrecognised — including failed and disconnected — is unknown,
      // never an upgrade to live.
      ["disconnected", "unknown"],
      ["not connected", "unknown"],
      ["✗ Failed to connect", "unknown"],
      ["", "unknown"],
      ["weird", "unknown"],
    ];
    for (const [raw, expected] of table) {
      expect(mapMcpListingStatus(raw), raw).toBe(expected);
    }
  });

  it("classifies a listing command as stdio and a URL as http", () => {
    expect(inferListingTransport("npx @playwright/mcp@latest")).toBe("stdio");
    expect(inferListingTransport("https://example.com/mcp")).toBe("http");
    expect(inferListingTransport(undefined)).toBeUndefined();
    expect(inferListingTransport("   ")).toBeUndefined();
  });
});

describe("bounded MCP listing runner (REQ-32 / NFR-9)", () => {
  it("runs the CLI, parses stdout, and stays within the shared deadline constant", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-list-run-"));
    try {
      const bin = join(tempDir, "fakemcp");
      writeFileSync(
        bin,
        "#!/bin/sh\n" +
          '[ "$1" = "mcp" ] && [ "$2" = "list" ] || exit 9\n' +
          "printf '  NAME    TYPE   SCOPE  AUTH  STATUS\\n  muninn  stdio  user   -     enabled\\n\\nTotal: 1 server\\n'\n",
      );
      chmodSync(bin, 0o755);

      const result = await runMcpListCommand(
        { command: "fakemcp", args: ["mcp", "list"], parse: parseCommandcodeMcpList },
        { env: { PATH: tempDir } },
      );

      expect(result.error).toBeUndefined();
      expect(result.listings).toEqual([
        { name: "muninn", transport: "stdio", status: "enabled", detail: "scope user" },
      ]);
      expect(MCP_LIST_TIMEOUT_MS).toBe(5000);
      expect(CLAUDE_MCP_LIST_TIMEOUT_MS).toBeGreaterThanOrEqual(MCP_LIST_TIMEOUT_MS);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a reason (never a throw, never a fabricated server) when the CLI fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-list-fail-"));
    try {
      const missing = await runMcpListCommand(
        { command: "definitely-not-a-real-cli", args: ["mcp", "list"], parse: parseClaudeMcpList },
        { env: { PATH: tempDir } },
      );
      expect(missing.listings).toBeUndefined();
      expect(missing.error).toContain("could not run");

      // A non-zero exit names the command that failed.
      const failing = join(tempDir, "failcli");
      writeFileSync(failing, "#!/bin/sh\necho 'boom' >&2\nexit 3\n");
      chmodSync(failing, 0o755);
      const errored = await runMcpListCommand({
        command: failing,
        args: ["mcp", "list"],
        parse: parseClaudeMcpList,
      });
      expect(errored.listings).toBeUndefined();
      expect(errored.error).toContain("exited with code 3");
      expect(errored.error).toContain("boom");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("kills a hanging listing at its deadline and says so", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "huginn-mcp-list-hang-"));
    try {
      const hanging = join(tempDir, "hangcli");
      writeFileSync(hanging, "#!/bin/sh\nsleep 30\n");
      chmodSync(hanging, 0o755);

      const started = Date.now();
      const result = await runMcpListCommand({
        command: hanging,
        args: ["mcp", "list"],
        parse: parseClaudeMcpList,
        timeoutMs: 300,
      });
      const elapsed = Date.now() - started;

      expect(result.listings).toBeUndefined();
      expect(result.error).toContain("timed out after 300ms");
      expect(elapsed).toBeLessThan(5000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("collapses any failure to [] for the runtime contract", async () => {
    const listings = await listMcpServersViaCommand(
      { command: "definitely-not-a-real-cli", args: ["mcp", "list"], parse: parseOpencodeMcpList },
      { env: { PATH: "" } },
    );
    expect(listings).toEqual([]);
  });
});
