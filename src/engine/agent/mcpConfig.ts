import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeTerminalText } from "../../util/text.js";
import type { McpServerStatus, McpToolInfo } from "./types.js";

export const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

export interface ProjectMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: string;
  url?: string;
  tools?: Array<string | McpToolInfo>;
  latencyMs?: number;
  status?: "connected" | "disconnected" | "error";
  description?: string;
  [key: string]: unknown;
}

export interface ProjectMcpConfig {
  mcpServers?: Record<string, ProjectMcpServerConfig>;
  mcp?: Record<string, ProjectMcpServerConfig>;
  servers?: Record<string, ProjectMcpServerConfig>;
  [key: string]: unknown;
}

/**
 * Loads project-level MCP configuration from `<project>/.huginn/mcp.json`.
 * Returns null if the file does not exist, exceeds 1MB, or is not a regular file (SEC-002).
 * Prototype pollution keys are ignored and filtered out (SEC-003).
 * Throws SyntaxError if the file contains invalid JSON.
 */
export function loadProjectMcpConfig(projectPath: string): ProjectMcpConfig | null {
  const configPath = join(projectPath, ".huginn", "mcp.json");
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      console.warn(
        `[huginn] Warning: MCP config at ${configPath} is not a regular file or exceeds 1MB limit (${stat.size} bytes); ignoring.`,
      );
      return null;
    }
  } catch (err) {
    console.warn(`[huginn] Warning: Failed to stat MCP config at ${configPath}: ${(err as Error).message}`);
    return null;
  }

  const content = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(content, (key, value) => {
    if (isReservedKey(key)) return undefined;
    return value;
  }) as Record<string, unknown>;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const out: ProjectMcpConfig = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (isReservedKey(key)) continue;
    if (key === "mcpServers" || key === "mcp" || key === "servers") {
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        const cleanSection: Record<string, ProjectMcpServerConfig> = {};
        for (const [sKey, sVal] of Object.entries(val as Record<string, ProjectMcpServerConfig>)) {
          if (isReservedKey(sKey)) continue;
          cleanSection[sKey] = sVal;
        }
        out[key] = cleanSection;
      }
    } else {
      out[key] = val;
    }
  }

  return out;
}

export function parseMcpServerEntry(name: string, val: unknown): McpServerStatus {
  const safeName = sanitizeTerminalText(name);
  if (typeof val !== "object" || val === null) {
    return {
      id: safeName,
      name: safeName,
      status: "connected",
      transport: "stdio",
      toolsCount: 0,
      tools: [],
    };
  }

  const s = val as Record<string, unknown>;
  const tools: McpToolInfo[] = Array.isArray(s.tools)
    ? s.tools
        .filter((t) => {
          if (typeof t === "string") return !isReservedKey(t);
          if (typeof t === "object" && t !== null && "name" in t) {
            return !isReservedKey(String((t as { name: unknown }).name));
          }
          return true;
        })
        .map((t) => {
          if (typeof t === "string") return { name: sanitizeTerminalText(t) };
          if (typeof t === "object" && t !== null && "name" in t) {
            const info = t as { name: unknown; description?: unknown };
            return {
              name: sanitizeTerminalText(String(info.name)),
              description: info.description !== undefined ? sanitizeTerminalText(String(info.description)) : undefined,
            };
          }
          return { name: sanitizeTerminalText(String(t)) };
        })
    : [];

  let status: "connected" | "disconnected" | "error" = "connected";
  if (s.status === "error" || s.status === "disconnected") {
    status = s.status;
  }

  const transport = s.command
    ? "stdio"
    : s.transport
      ? sanitizeTerminalText(String(s.transport))
      : s.url
        ? "sse"
        : "stdio";

  return {
    id: safeName,
    name: safeName,
    status,
    transport,
    toolsCount: tools.length,
    tools,
    latencyMs: typeof s.latencyMs === "number" ? s.latencyMs : undefined,
    error: typeof s.error === "string" ? sanitizeTerminalText(s.error) : undefined,
  };
}
