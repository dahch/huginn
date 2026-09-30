/**
 * Single source of truth for the Live console slash commands (ADR-28 / REQ-28).
 *
 * `submit()` resolves command *identity* through this registry, the inline
 * autocomplete overlay (`CommandSuggestions`) is filtered/rendered from it, and
 * `HelpModal`'s cheat sheet is generated from it — so the UI can never advertise
 * a command the dispatcher does not implement (or hide one it does).
 *
 * The per-command argument parsing still lives in the handlers; only identity,
 * aliasing and copy are centralised here.
 */

export type SlashCommandCategory = "session" | "config" | "view" | "workflow";

export interface SlashCommand {
  /** Canonical token, e.g. `/model`. */
  id: string;
  /** Every token (including `id`) that dispatches this command. */
  aliases: string[];
  /** Argument placeholder for display, e.g. `<thinker> [executor]`. */
  argHint?: string;
  description: string;
  category: SlashCommandCategory;
  /** True when the command accepts trailing arguments. */
  takesArgs: boolean;
}

/**
 * Every command the Live dispatcher understands. Order is the display order in
 * the help cheat sheet and the tie-break order for equal autocomplete scores.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "/help",
    aliases: ["/help"],
    description: "Show this command cheat sheet",
    category: "view",
    takesArgs: false,
  },
  {
    id: "/agent",
    aliases: ["/agent"],
    argHint: "[id]",
    description: "Open the runtime picker, or switch to a runtime by id (claude, opencode, agy, …)",
    category: "config",
    takesArgs: true,
  },
  {
    id: "/model",
    aliases: ["/model", "/models"],
    argHint: "<thinker> [executor]",
    description: "Open the model picker or set the active models for this session",
    category: "config",
    takesArgs: true,
  },
  {
    id: "/profile",
    aliases: ["/profile"],
    argHint: "[id]",
    description: "Open the methodology-profile picker, or set one by id (huginn, sdd, odd, rdd, strict-tdd)",
    category: "config",
    takesArgs: true,
  },
  {
    id: "/mcp",
    aliases: ["/mcp"],
    argHint: "[id]",
    description: "Inspect connected MCP servers and their tools",
    category: "view",
    takesArgs: true,
  },
  {
    id: "/skills",
    aliases: ["/skills", "/skill"],
    argHint: "[name]",
    description: "Browse project skills or run one by name",
    category: "workflow",
    takesArgs: true,
  },
  {
    id: "/status",
    aliases: ["/status"],
    description: "Show system diagnostics (branch, sandbox, runtime, models, memory)",
    category: "view",
    takesArgs: false,
  },
  {
    id: "/clear",
    aliases: ["/clear"],
    description: "Clear the conversation and stream viewports",
    category: "view",
    takesArgs: false,
  },
  {
    id: "/draft",
    aliases: ["/draft", "/go"],
    description: "Draft the plan from the refined scope",
    category: "workflow",
    takesArgs: false,
  },
  {
    id: "/quit",
    aliases: ["/quit", "/abort"],
    description: "Exit the live session (asks for confirmation twice)",
    category: "session",
    takesArgs: false,
  },
];

/**
 * Extract the leading token of `raw` (arguments dropped) and lower-case it.
 * Only meaningful for input that already looks like a command; see `findCommand`,
 * which additionally requires the leading `/`.
 */
export function normalizeCommandToken(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  return (first.startsWith("/") ? first : `/${first}`).toLowerCase();
}

/**
 * Resolve a leading token (with or without arguments) to its registry entry.
 *
 * Requires a leading `/`: plain chat input must never be dispatched as a command
 * merely because its first word happens to match an alias (e.g. "clear the cache"
 * is a prompt, not `/clear`).
 */
export function findCommand(token: string): SlashCommand | undefined {
  if (!token.trim().startsWith("/")) return undefined;
  const normalized = normalizeCommandToken(token);
  if (!normalized) return undefined;
  return SLASH_COMMANDS.find((command) =>
    command.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}

/** `0` exact alias, `1` alias starts with the query, `2` alias contains it, `-1` no match. */
function scoreToken(token: string, query: string): number {
  if (!query) return 0;
  if (token === query) return 0;
  if (token.startsWith(query)) return 1;
  if (token.includes(query)) return 2;
  return -1;
}

/**
 * Substring match over ids and aliases, ranked: exact alias, then alias prefix,
 * then alias substring; ties keep registry order. An empty/`"/"` prefix lists
 * every command.
 */
export function matchCommands(prefix: string): SlashCommand[] {
  const query = prefix.trim().replace(/^\/+/, "").toLowerCase();
  const ranked: Array<{ command: SlashCommand; score: number; order: number }> = [];
  SLASH_COMMANDS.forEach((command, order) => {
    let best = -1;
    for (const alias of command.aliases) {
      best = Math.max(best, scoreToken(alias.replace(/^\//, "").toLowerCase(), query));
    }
    if (best >= 0) ranked.push({ command, score: best, order });
  });
  ranked.sort((a, b) => a.score - b.score || a.order - b.order);
  return ranked.map((entry) => entry.command);
}

/** Canonical command line for display: `"/model <thinker> [executor]"`. */
export function commandUsage(command: SlashCommand): string {
  return command.argHint ? `${command.id} ${command.argHint}` : command.id;
}

/** Non-canonical aliases, e.g. `["/models"]`, for `"/model"`. */
export function commandAliases(command: SlashCommand): string[] {
  return command.aliases.filter((alias) => alias !== command.id);
}

/** Description with its aliases spelled out, used by the help cheat sheet. */
export function describeCommand(command: SlashCommand): string {
  const aliases = commandAliases(command);
  if (aliases.length === 0) return command.description;
  return `${command.description} (alias: ${aliases.join(", ")})`;
}
