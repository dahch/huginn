import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  commandAliases,
  commandUsage,
  describeCommand,
  findCommand,
  matchCommands,
  normalizeCommandToken,
} from "../../src/tui/commandRegistry";
import { SLASH_COMMANDS as CHEAT_SHEET } from "../../src/tui/HelpModal";

const DASHBOARD_SOURCE = readFileSync(
  new URL("../../src/tui/LiveDashboard.tsx", import.meta.url),
  "utf8",
);

/** Every exact `"/token"` string literal in the live dashboard (dispatch + help copy). */
function dispatchedTokens(source: string): string[] {
  const tokens = new Set<string>();
  for (const match of source.matchAll(/"(\/[a-z][a-z-]*)"/g)) {
    tokens.add(match[1]!);
  }
  return [...tokens].sort();
}

/** Canonical command ids handled by `switch (command.id)` in `submit()`. */
function handledCommandIds(source: string): string[] {
  const ids = new Set<string>();
  for (const match of source.matchAll(/case "(\/[a-z][a-z-]*)":/g)) {
    ids.add(match[1]!);
  }
  return [...ids].sort();
}

/** The Phase 5 command surface that must remain reachable (AC-28.5). */
const PHASE_5_COMMANDS = [
  "/help",
  "/agent",
  "/model",
  "/models",
  "/mcp",
  "/skills",
  "/skill",
  "/status",
  "/clear",
  "/draft",
  "/go",
  "/quit",
  "/abort",
];

describe("command registry (AC-28.1, AC-28.5)", () => {
  it("resolves every slash token dispatched by submit()", () => {
    const tokens = dispatchedTokens(DASHBOARD_SOURCE);
    // Guard the guard: the scan must actually find the dispatcher's literals.
    expect(tokens.length).toBeGreaterThanOrEqual(9);
    for (const token of tokens) {
      expect(findCommand(token)?.id, `dispatched command ${token} is missing from the registry`).toBeDefined();
    }
  });

  it("gives every registry entry a handler in submit() and vice versa (drift guard)", () => {
    expect(handledCommandIds(DASHBOARD_SOURCE)).toEqual(SLASH_COMMANDS.map((c) => c.id).sort());
  });

  it("keeps every Phase 5 command dispatchable through the registry", () => {
    for (const token of PHASE_5_COMMANDS) {
      const command = findCommand(token);
      expect(command, `${token} is no longer dispatchable`).toBeDefined();
      expect(command!.aliases).toContain(token);
    }
    const aliases = SLASH_COMMANDS.flatMap((c) => c.aliases);
    for (const token of PHASE_5_COMMANDS) {
      expect(aliases).toContain(token);
    }
  });

  it("describes every command with an id, a description and a category", () => {
    const categories = new Set(["session", "config", "view", "workflow"]);
    for (const command of SLASH_COMMANDS) {
      expect(command.id.startsWith("/")).toBe(true);
      expect(command.aliases).toContain(command.id);
      expect(command.description.length).toBeGreaterThan(0);
      expect(categories.has(command.category)).toBe(true);
      for (const alias of command.aliases) {
        expect(findCommand(alias)).toBe(command);
      }
    }
  });

  it("generates the HelpModal cheat sheet from the registry", () => {
    expect(CHEAT_SHEET.map((entry) => entry.command)).toEqual(SLASH_COMMANDS.map(commandUsage));
    expect(CHEAT_SHEET.map((entry) => entry.description)).toEqual(SLASH_COMMANDS.map(describeCommand));
  });

  it("spells out aliases in the cheat sheet copy", () => {
    const model = findCommand("/model")!;
    expect(commandAliases(model)).toEqual(["/models"]);
    expect(describeCommand(model)).toContain("alias: /models");
    const draft = findCommand("/draft")!;
    expect(describeCommand(draft)).toContain("alias: /go");
  });
});

describe("findCommand / normalizeCommandToken", () => {
  it("resolves canonical ids and aliases", () => {
    expect(findCommand("/model")?.id).toBe("/model");
    expect(findCommand("/models")?.id).toBe("/model");
    expect(findCommand("/go")?.id).toBe("/draft");
    expect(findCommand("/abort")?.id).toBe("/quit");
    expect(findCommand("/skill")?.id).toBe("/skills");
  });

  it("resolves a leading token even when arguments follow", () => {
    expect(findCommand("/model anthropic/claude-3-7-sonnet")?.id).toBe("/model");
    expect(findCommand("  /agent   claude ")?.id).toBe("/agent");
  });

  it("is case-insensitive and tolerates a missing slash", () => {
    expect(normalizeCommandToken("  /MODEL ")).toBe("/model");
    expect(normalizeCommandToken("model")).toBe("/model");
    expect(findCommand("/Help")?.id).toBe("/help");
  });

  it("returns undefined for unknown or empty input", () => {
    expect(findCommand("/nope")).toBeUndefined();
    expect(findCommand("just a prompt")).toBeUndefined();
    expect(findCommand("")).toBeUndefined();
    expect(findCommand("   ")).toBeUndefined();
  });
});

describe("matchCommands", () => {
  it("lists every command for an empty or bare-slash prefix", () => {
    expect(matchCommands("").map((c) => c.id)).toEqual(SLASH_COMMANDS.map((c) => c.id));
    expect(matchCommands("/").map((c) => c.id)).toEqual(SLASH_COMMANDS.map((c) => c.id));
  });

  it("matches id prefixes and aliases", () => {
    expect(matchCommands("/mod").map((c) => c.id)).toEqual(["/model"]);
    expect(matchCommands("/models").map((c) => c.id)).toEqual(["/model"]);
    expect(matchCommands("/skill").map((c) => c.id)).toEqual(["/skills"]);
    expect(matchCommands("/go").map((c) => c.id)).toEqual(["/draft"]);
    expect(matchCommands("model").map((c) => c.id)).toEqual(["/model"]);
  });

  it("ranks alias-prefix matches above substring matches", () => {
    // "/a" → /agent (alias "agent") and /quit (alias "abort") start with it; the
    // rest merely contain it.
    expect(matchCommands("/a").map((c) => c.id)).toEqual(["/agent", "/quit", "/status", "/clear", "/draft"]);
    // "/c" → /clear is a prefix match, /mcp only contains it.
    expect(matchCommands("/c").map((c) => c.id)).toEqual(["/clear", "/mcp"]);
  });

  it("does not match aliases it contains no characters of", () => {
    expect(matchCommands("/mcp").map((c) => c.id)).toEqual(["/mcp"]);
    expect(matchCommands("/nope")).toEqual([]);
    expect(matchCommands("/zzz")).toEqual([]);
  });

  it("matches substrings anywhere in the alias, not just the start", () => {
    expect(matchCommands("/odel").map((c) => c.id)).toEqual(["/model"]);
    expect(matchCommands("/tus").map((c) => c.id)).toEqual(["/status"]);
  });
});
