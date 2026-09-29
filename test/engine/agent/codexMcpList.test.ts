import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCodexMcpList } from "../../../src/engine/agent/adapters/codex.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/codex-mcp-list.json", import.meta.url));
const stdout = readFileSync(fixturePath, "utf8");

/** One server entry, shaped exactly like `codex mcp list --json` emits it. */
function entry(overrides: Record<string, unknown>): string {
  return JSON.stringify([
    {
      name: "srv",
      enabled: true,
      disabled_reason: null,
      transport: { type: "stdio", command: "node", args: ["server.js"], env: null, env_vars: [], cwd: null },
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      auth_status: "unsupported",
      ...overrides,
    },
  ]);
}

describe("REQ-32 · codex MCP listing parser (AC-32.1, Phase 3C)", () => {
  const listings = parseCodexMcpList(stdout);

  it("parses the captured `codex mcp list --json` fixture", () => {
    expect(listings).toEqual([
      {
        name: "muninn",
        transport: "stdio",
        status: "enabled",
        detail: "huginn mcp run --project /home/dev/projects/huginn",
      },
    ]);
  });

  it("maps `enabled` to a configuration word, never to a live probe (AC-32.2)", () => {
    // Codex's own `Status` column is configuration; nothing here ever probed the
    // server, so no listing may be `connected`.
    expect(listings.map((l) => l.status)).toEqual(["enabled"]);
    expect(listings.some((l) => l.status === "connected")).toBe(false);
  });

  it("reads a `streamable_http` transport's URL verbatim", () => {
    const [remote] = parseCodexMcpList(
      entry({
        transport: {
          type: "streamable_http",
          url: "https://example.com/mcp",
          bearer_token_env_var: "REMOTE_MCP_TOKEN",
          http_headers: null,
          env_http_headers: null,
          http_headers_helper: null,
        },
        auth_status: "bearer_token",
      }),
    );
    expect(remote).toEqual({
      name: "srv",
      transport: "streamable_http",
      status: "enabled",
      detail: "https://example.com/mcp",
    });
    // `auth_status` describes how Codex authenticates, not whether the server
    // answered, so it never reaches the status.
    expect(JSON.stringify(remote)).not.toContain("bearer_token");
  });

  it("reports a disabled server as `disabled` with the CLI's own reason", () => {
    const [off] = parseCodexMcpList(
      entry({ name: "switched_off", enabled: false, disabled_reason: "disabled by policy" }),
    );
    expect(off).toEqual({
      name: "switched_off",
      transport: "stdio",
      status: "disabled",
      detail: "node server.js · disabled by policy",
    });
  });

  it("never invents a status for a missing or non-boolean `enabled`", () => {
    for (const enabled of [undefined, null, "yes", 1] as const) {
      const [unknown] = parseCodexMcpList(entry({ enabled }));
      expect(unknown.status, String(enabled)).toBe("unknown");
    }
    // A missing `enabled: false` server with no reason keeps its command detail.
    const [noReason] = parseCodexMcpList(entry({ enabled: false }));
    expect(noReason).toEqual({ name: "srv", transport: "stdio", status: "disabled", detail: "node server.js" });
  });

  it("falls back to inferring the transport from the detail when none was reported", () => {
    const [bare] = parseCodexMcpList(entry({ transport: { command: "npx", args: ["mcp-server"] } }));
    expect(bare).toEqual({ name: "srv", transport: "stdio", status: "enabled", detail: "npx mcp-server" });

    const [urlOnly] = parseCodexMcpList(entry({ transport: undefined }));
    expect(urlOnly).toEqual({ name: "srv", transport: undefined, status: "enabled", detail: undefined });
  });

  it("skips malformed entries and dedupes server names", () => {
    expect(
      parseCodexMcpList(
        JSON.stringify([
          null,
          7,
          ["not", "a", "row"],
          { enabled: true },
          { name: "  ", transport: { type: "stdio" } },
          { name: "ok", transport: { type: "stdio", command: "echo" } },
          { name: "ok", transport: { type: "stdio", command: "other" } },
        ]),
      ),
    ).toEqual([{ name: "ok", transport: "stdio", status: "unknown", detail: "echo" }]);
  });

  it("returns [] for an empty server array or empty output, and throws on a non-array payload", () => {
    expect(parseCodexMcpList("[]")).toEqual([]);
    expect(parseCodexMcpList("   \n")).toEqual([]);
    // A CLI that printed its human table / prose instead of JSON must be a
    // parse failure, not a silent "no servers".
    expect(() => parseCodexMcpList("No MCP servers configured yet. Try `codex mcp add …`.\n")).toThrow();
    expect(() => parseCodexMcpList('{"servers":[]}')).toThrow(/JSON array/);
  });

  it("strips ANSI/control sequences from names and details", () => {
    const colored = JSON.stringify([
      { name: "\u001b[32mmuninn\u001b[0m", enabled: true, transport: { type: "stdio", command: "huginn", args: ["mcp"] } },
    ]);
    const [clean] = parseCodexMcpList(colored);
    expect(clean.name).toBe("muninn");
    expect(JSON.stringify(clean)).not.toContain("\u001b");
  });
});
