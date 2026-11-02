import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultPiAdapter,
  createPiSdkPort,
  parsePiMcpListJson,
  type PiSdkAdapter,
  type PiSessionHandle,
} from "../../../src/engine/agent/drivers/pi-sdk.js";
import { getEnginePort } from "../../../src/engine/agent/registry.js";
import { fetchMcpStatusWithTimeout } from "../../../src/engine/agent/mcpStatus.js";
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
      { projectPath: tempDir("huginn-pi-bridge-project-"), homeDir: tempDir("huginn-pi-bridge-home-") },
    );

    expect(port.capabilities.mcpListing).toBe(true);
    expect(await port.listMcpServers!()).toHaveLength(2);
    expect((await port.mcpStatus!()).unverified).toBe(true);

  });

  it("stays honest when the adapter cannot enumerate MCP", async () => {
    const port = createPiSdkPort(fakeAdapter());
    expect(port.listMcpServers).toBeUndefined();
    expect(port.mcpStatus).toBeUndefined();
    const status = await fetchMcpStatusWithTimeout(port, 50);
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

  it("discovers the project and user config files through the engine port", async () => {
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

    const runtime = getEnginePort("pi", { projectPath: project, homeDir: home });
    // The in-process driver can enumerate MCP, so the badge is no longer "none".
    expect(typeof runtime.listMcpServers).toBe("function");
    const status = await runtime.mcpStatus!();
    expect(status.servers.map((server) => server.name).sort()).toEqual(["muninn", "rea"]);
    // Config discovery is not a liveness probe.
    expect(status.servers.every((server) => server.status === "unknown")).toBe(true);
    expect(status.unverified).toBe(true);
    expect(status.healthy).toBe(false);
  });
});

/** Write pi's MCP config at the user (`~/.pi/agent`) or project (`<project>/.pi`) path. */
function writePiConfig(
  dir: string,
  scope: "home" | "project",
  servers: Record<string, unknown>,
): void {
  const base = scope === "home" ? join(dir, ".pi", "agent") : join(dir, ".pi");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

describe("pi MCP keeps configured servers when the listing cannot see them", () => {
  it("(a) enumerates both configured servers when the listing is empty", async () => {
    const home = tempDir("huginn-pi-empty-home-");
    const project = tempDir("huginn-pi-empty-project-");
    writePiConfig(home, "home", {
      rea: { command: "npx", args: ["-y", "rea-agents", "mcp"] },
      muninn: { command: "huginn", args: ["mcp", "run"] },
    });

    const port = createPiSdkPort(
      fakeAdapter({
        async listMcpServers() {
          return [];
        },
      }),
      { projectPath: project, homeDir: home },
    );
    const listings = await port.listMcpServers!();
    const report = reportFromListings("pi", listings);

    expect(listings.map((listing) => listing.name).sort()).toEqual(["muninn", "rea"]);
    expect(listings.every((listing) => listing.status === "unknown")).toBe(true);
    expect(report).toMatchObject({ totalTools: 0, healthy: false, unverified: true });
    expect(formatMcpBadge(report, "pi")).toEqual({
      text: "MCP: ⚪ 2 configured · pi",
      status: "unknown",
    });

    // The driver's own probe reads the same files and is equally honest.
    const configured = await createDefaultPiAdapter({ projectPath: project, homeDir: home }).getMcpStatus!();
    expect(configured).toMatchObject({ totalTools: 0, healthy: false, unverified: true });
    expect(configured.servers.every((server) => server.status === "unknown")).toBe(true);
    expect(configured.servers.map((server) => server.name).sort()).toEqual(["muninn", "rea"]);
  });

  it("(b) names the failed server without dropping the healthy configured one", async () => {
    const home = tempDir("huginn-pi-error-home-");
    const project = tempDir("huginn-pi-error-project-");
    writePiConfig(home, "home", {
      rea: { command: "npx", args: ["-y", "rea-agents", "mcp"] },
      muninn: { command: "huginn", args: ["mcp", "run"] },
    });

    const port = createPiSdkPort(
      fakeAdapter({
        async listMcpServers() {
          return [{ name: "rea", status: "error" as const, detail: "cannot start" }];
        },
      }),
      { projectPath: project, homeDir: home },
    );
    const listings = await port.listMcpServers!();
    const report = reportFromListings("pi", listings);

    expect(listings.map((listing) => listing.name).sort()).toEqual(["muninn", "rea"]);
    expect(report.degraded).toBe(true);
    expect(report.servers.map((server) => `${server.name}:${server.status}`).sort()).toEqual([
      "muninn:unknown",
      "rea:error",
    ]);
    const badge = formatMcpBadge(report, "pi");
    expect(badge.status).toBe("degraded");
    expect(badge.text).toBe("MCP: 🟡 error — rea: cannot start · pi");
  });

  it("(c) says none only when there is neither a listing nor configuration", async () => {
    const home = tempDir("huginn-pi-none-home-");
    const project = tempDir("huginn-pi-none-project-");
    const port = createPiSdkPort(
      fakeAdapter({
        async listMcpServers() {
          return [];
        },
      }),
      { projectPath: project, homeDir: home },
    );

    const listings = await port.listMcpServers!();
    expect(listings).toEqual([]);
    expect(formatMcpBadge(reportFromListings("pi", listings), "pi")).toEqual({
      text: "MCP: ⚪ none · pi",
      status: "unknown",
    });

    const configured = await createDefaultPiAdapter({ projectPath: project, homeDir: home }).getMcpStatus!();
    expect(configured.servers).toEqual([]);
    expect(formatMcpBadge(configured, "pi")).toEqual({
      text: "MCP: ⚪ none · pi",
      status: "unknown",
    });
  });

  it("(d) leaves a healthy listing exactly as it was", async () => {
    const home = tempDir("huginn-pi-healthy-home-");
    const project = tempDir("huginn-pi-healthy-project-");
    writePiConfig(home, "home", {
      rea: { command: "npx", args: ["-y", "rea-agents", "mcp"] },
      muninn: { command: "huginn", args: ["mcp", "run"] },
    });

    const port = createPiSdkPort(
      fakeAdapter({
        async listMcpServers() {
          return parsePiMcpListJson(fixture);
        },
      }),
      { projectPath: project, homeDir: home },
    );
    const listings = await port.listMcpServers!();
    const report = reportFromListings("pi", listings);

    expect(listings).toHaveLength(2);
    expect(listings.every((listing) => listing.status === "connected")).toBe(true);
    expect(report.totalTools).toBe(10);
    expect(report.healthy).toBe(true);
    expect(formatMcpBadge(report, "pi")).toEqual({
      text: "MCP: 🟢 2 connected (10 tools) · pi",
      status: "healthy",
    });
  });

  it("lets the project config win a name collision, as config discovery always has", async () => {
    const home = tempDir("huginn-pi-precedence-home-");
    const project = tempDir("huginn-pi-precedence-project-");
    writePiConfig(home, "home", {
      muninn: { command: "huginn", tools: [{ name: "home_tool" }, { name: "other_tool" }] },
    });
    writePiConfig(project, "project", {
      muninn: { command: "huginn", tools: [{ name: "project_tool" }] },
    });

    const configured = await createDefaultPiAdapter({ projectPath: project, homeDir: home }).getMcpStatus!();
    expect(configured.servers).toHaveLength(1);
    expect(configured.servers[0]).toMatchObject({ name: "muninn", toolsCount: 1 });
    expect(configured.servers[0]?.tools?.map((tool) => tool.name)).toEqual(["project_tool"]);
  });
});

