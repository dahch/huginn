import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPiSdkPort,
  parsePiMcpListJson,
  type PiSdkAdapter,
  type PiSessionHandle,
} from "../../../src/engine/agent/drivers/pi-sdk.js";
import { toLegacyRuntime } from "../../../src/engine/agent/legacy-bridge.js";
import { getEngineRuntime } from "../../../src/engine/agent/registry.js";
import { formatMcpBadge, reportFromListings } from "../../../src/engine/agent/mcpStatus.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fakeHandle(): PiSessionHandle {
  return {
    id: "pi-session",
    async prompt() {
      return "ok";
    },
    async interrupt() {},
    async dispose() {},
  };
}

function fakeAdapter(overrides: Partial<PiSdkAdapter> = {}): PiSdkAdapter {
  return {
    async createSession() {
      return fakeHandle();
    },
    async listModels() {
      return [{ id: "deepseek/deepseek-v4-pro", name: "deepseek-v4-pro", provider: "deepseek" }];
    },
    ...overrides,
  };
}

const fixture = readFileSync(join(process.cwd(), "test/fixtures/pi-mcp-list.json"), "utf8");

describe("pi mcp list --json parser", () => {
  it("reads real connections and tool counts from the captured fixture", () => {
    const listings = parsePiMcpListJson(fixture);
    expect(listings.map((server) => server.name)).toEqual(["rea", "muninn"]);
    expect(listings[0]).toMatchObject({
      status: "connected",
      transport: "npx -y rea-agents@6.7.0 mcp",
      toolsCount: 3,
    });
    expect(listings[1]).toMatchObject({ status: "connected", toolsCount: 7 });
    expect(listings[1]!.detail).toContain("project");
  });

  it("maps disabled and failed servers honestly and never fabricates connections", () => {
    const listings = parsePiMcpListJson(
      JSON.stringify({
        servers: [
          { name: "off", enabled: false, state: "disabled" },
          { name: "broken", state: "failed" },
          { name: "idle", state: "unknown" },
          { name: "negated", state: "not connected" },
        ],
      }),
    );
    expect(listings.map((server) => server.status)).toEqual([
      "disabled",
      "error",
      "unknown",
      "unknown",
    ]);
  });

  it("returns [] for malformed output instead of inventing servers", () => {
    expect(parsePiMcpListJson("not json")).toEqual([]);
    expect(parsePiMcpListJson("{}")).toEqual([]);
  });
});

describe("MCP reporting for the native pi driver", () => {
  it("forwards the adapter listing and status through the port and the legacy bridge", async () => {
    const listings = parsePiMcpListJson(fixture);
    const port = createPiSdkPort(
      fakeAdapter({
        async listMcpServers() {
          return listings;
        },
        async getMcpStatus() {
          return {
            servers: [
              {
                id: "pi:muninn",
                name: "muninn",
                status: "unknown",
                transport: "stdio",
                toolsCount: 0,
              },
            ],
            totalTools: 0,
            healthy: false,
            unverified: true,
          };
        },
      }),
    );

    expect(port.capabilities.mcpListing).toBe(true);
    expect(await port.listMcpServers!()).toHaveLength(2);
    expect((await port.mcpStatus!()).unverified).toBe(true);

    const legacy = toLegacyRuntime(port);
    expect(await legacy.listMcpServers!()).toHaveLength(2);
    expect((await legacy.getMcpStatus()).unverified).toBe(true);
  });

  it("stays honest when the adapter cannot enumerate MCP", async () => {
    const legacy = toLegacyRuntime(createPiSdkPort(fakeAdapter()));
    expect(legacy.listMcpServers).toBeUndefined();
    const status = await legacy.getMcpStatus();
    expect(status).toMatchObject({ servers: [], healthy: false, unverified: true });
  });

  it("reports the configured servers and their tools through the badge", () => {
    const connected = parsePiMcpListJson(fixture);
    const report = reportFromListings("pi", connected);
    expect(report.totalTools).toBe(10);
    expect(report.healthy).toBe(true);
    expect(formatMcpBadge(report, "Pi (in-process)").text).toBe(
      "MCP: 🟢 2 connected (10 tools) · Pi (in-process)",
    );

    const degraded = reportFromListings("pi", [
      { name: "broken", status: "error" },
    ]);
    expect(degraded.degraded).toBe(true);
    expect(formatMcpBadge(degraded, "Pi (in-process)").status).toBe("degraded");
  });

  it("discovers the project and user config files through getEngineRuntime", async () => {
    const home = tempDir("huginn-pi-home-");
    const project = tempDir("huginn-pi-project-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { rea: { command: "npx", args: ["-y", "rea"] } } }),
    );
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: { muninn: { command: "huginn", args: ["mcp", "run", "--project", project] } },
      }),
    );

    const runtime = getEngineRuntime("pi", { projectPath: project, homeDir: home });
    // The in-process driver can enumerate MCP, so the badge is no longer "none".
    expect(typeof runtime.listMcpServers).toBe("function");
    const status = await runtime.getMcpStatus();
    expect(status.servers.map((server) => server.name).sort()).toEqual(["muninn", "rea"]);
    // Config discovery is not a liveness probe.
    expect(status.servers.every((server) => server.status === "unknown")).toBe(true);
    expect(status.unverified).toBe(true);
    expect(status.healthy).toBe(false);
  });
});
