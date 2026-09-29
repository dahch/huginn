import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import { inferListingTransport } from "./mcpList.js";
import type { McpServerListing } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/**
 * Codex's auto-approval switch (Phase 2C): bypasses both the approval prompts
 * and the sandbox, which is what a non-interactive `codex exec` needs —
 * `codex exec` closes stdin after the prompt, so an approval request can never
 * be answered. It is Codex's own flag (re-verify with `codex exec --help`) and
 * is overridable through `permissionArgs`.
 *
 * Verified live (Phase 3C, codex-cli 0.158.0): a stdin-piped
 * `codex exec --dangerously-bypass-approvals-and-sandbox` run reports
 * `approval: never` and `sandbox: danger-full-access` in its own banner.
 */
export const CODEX_PERMISSION_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];

/** `codex mcp list --json` reads the merged local config (measured < 1 s). */
export const CODEX_MCP_LIST_TIMEOUT_MS = 5000;

/** Detail line for one `codex mcp list --json` transport object. */
function describeCodexTransport(transport: Record<string, unknown> | undefined): string | undefined {
  if (!transport) return undefined;

  const url = typeof transport.url === "string" ? sanitizeTerminalText(transport.url).trim() : "";
  if (url) return url;

  const command = typeof transport.command === "string" ? sanitizeTerminalText(transport.command).trim() : "";
  if (!command) return undefined;

  const args = Array.isArray(transport.args)
    ? transport.args
        .filter((arg): arg is string => typeof arg === "string")
        .map((arg) => sanitizeTerminalText(arg))
    : [];
  return [command, ...args].join(" ");
}

/**
 * Pure parser for `codex mcp list --json` output (REQ-32 / AC-32.1).
 *
 * Verified format (`codex-cli` 0.158.0): a JSON array of configured servers,
 * each `{ name, enabled, disabled_reason, transport, auth_status, … }`, where
 * `transport` is either `{ type: "stdio", command, args, env, env_vars, cwd }`
 * or `{ type: "streamable_http", url, bearer_token_env_var, … }` — see
 * `test/fixtures/codex-mcp-list.json` and `test/fixtures/README.md` for the
 * provenance of both shapes.
 *
 * Honesty rules (AC-32.2): `enabled` is Codex's own *configuration* word, never
 * a probe result, so it maps to `enabled`/`disabled` (an absent/non-boolean
 * `enabled` is `unknown` — never upgraded to live); the transport is reported
 * verbatim (`stdio`, `streamable_http`); the detail is the server's command line
 * or URL, plus the CLI's own `disabled_reason` when it reports one. Only
 * `config.toml`-level entries are enumerated — nothing is inferred from
 * `auth_status` and no server is ever claimed `connected`. Exported for fixture
 * tests.
 *
 * A payload that is not a JSON array throws (the caller then reports
 * "could not parse" instead of an indistinguishable empty listing); malformed
 * entries inside a valid array are skipped.
 */
export function parseCodexMcpList(stdout: string): McpServerListing[] {
  const trimmed = sanitizeTerminalText(stdout).trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("`codex mcp list --json` did not print a JSON array");
  }

  const listings: McpServerListing[] = [];
  const seen = new Set<string>();

  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;

    const name = typeof row.name === "string" ? sanitizeTerminalText(row.name).trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const transport =
      row.transport !== null && typeof row.transport === "object" && !Array.isArray(row.transport)
        ? (row.transport as Record<string, unknown>)
        : undefined;
    const type = typeof transport?.type === "string" ? sanitizeTerminalText(transport.type).trim() : "";
    const detail = describeCodexTransport(transport);
    const reason = typeof row.disabled_reason === "string" ? sanitizeTerminalText(row.disabled_reason).trim() : "";

    listings.push({
      name,
      transport: type || inferListingTransport(detail),
      status: row.enabled === true ? "enabled" : row.enabled === false ? "disabled" : "unknown",
      detail:
        reason && row.enabled === false ? `${detail ? `${detail} · ` : ""}${reason}` : detail,
    });
  }

  return listings;
}

/**
 * OpenAI Codex CLI (`codex-cli` 0.158.0). Phase 3C adds MCP discovery; the
 * non-interactive form and the model/permission flags were already right.
 *
 * Non-interactive form: `codex exec [PROMPT]`. The prompt is optional —
 * `codex exec --help`: "If not provided as an argument (or if `-` is used),
 * instructions are read from stdin" — so the session streams it over stdin
 * (`promptViaStdin: true`, stated explicitly here rather than relying on the
 * generic adapter's default) and it never reaches the argv. Verified live:
 * `echo "Reply with exactly: OK" | codex exec --dangerously-bypass-approvals-and-sandbox`
 * prints `Reading prompt from stdin...` and answers. No positional `-` and no
 * prompt file are needed.
 *
 * Model: `-m, --model <MODEL>` (verified with `codex exec --help`), fed with the
 * catalog's `provider/model`-style ids.
 *
 * Listings (REQ-32 / AC-32.1):
 * - **MCP**: `codex mcp list --json` enumerates the configured servers as a JSON
 *   array (verified live, including a `streamable_http` server and a disabled
 *   one) — the table form is the same data with a `Status` column that is always
 *   a configuration word, so the `--json` document is what the parser consumes.
 *   `discovered`/`auth_status` are deliberately not turned into liveness.
 * - **models**: Codex exposes no model-listing command (`codex --help` has none,
 *   and `codex exec --help` only names the local/OSS provider selection), so the
 *   adapter deliberately wires **no** `modelListCommand`: `getModelCatalog()`
 *   returns an empty catalog with a reason and the picker offers free-text ids.
 */
export class CodexRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "codex";
    super({
      id: "codex",
      name: "OpenAI Codex CLI",
      command,
      args: options.args ?? ["exec"],
      // `codex exec` reads the prompt from stdin when no positional is given.
      promptViaStdin: options.promptViaStdin ?? true,
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
      permissionArgs: options.permissionArgs ?? CODEX_PERMISSION_ARGS,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand,
      mcpListCommand: options.mcpListCommand ?? {
        command,
        args: ["mcp", "list", "--json"],
        parse: parseCodexMcpList,
        timeoutMs: CODEX_MCP_LIST_TIMEOUT_MS,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
