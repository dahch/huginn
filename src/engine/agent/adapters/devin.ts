import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import { DEVIN_MCP_LIST_TIMEOUT_MS, parseDevinMcpList } from "./mcpList.js";
import type { ModelInfo } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/**
 * Provider badge for a `devin models list` row. Variant rows are attributed to
 * their family label; this constant is the fallback for an orphan row that
 * appears before any family header, so a noisy/truncated listing can never
 * fabricate a family.
 */
export const DEVIN_DEFAULT_PROVIDER = "devin";

/**
 * Family section header, e.g. `SWE-1.7 Lightning (swe-1.7-lightning)`.
 *
 * The uid must be a single non-space token, which is what keeps the free-text
 * footer (`… (e.g. \`--model opus\`)`) and the `Available models (54 families)`
 * preamble from being mistaken for a section: their parenthesised part contains
 * spaces, so they never match.
 */
const DEVIN_FAMILY_HEADER = /^(\S.*?)\s+\(([^\s()]+)\)$/;

/** `  aliases: swe` / `  aliases: a, b` — family metadata, never a model. */
const DEVIN_ALIASES = /^aliases:\s*(.*)$/;

/** Variant row: `<model_uid>` + 2+ spaces + `<label>` (`  swe-2-high   SWE-2 High`). */
const DEVIN_MODEL_ROW = /^(\S+)\s{2,}(.+)$/;

/** Trailing `  [cost / context / …]` annotation some variant rows carry. */
const DEVIN_ROW_ANNOTATION = /^(.*?)\s{2,}\[([^\]]*)\]$/;

/**
 * Pure parser for `devin models list` output (REQ-27 / AC-27.4).
 *
 * Verified format: an `Available models (N families)` preamble, blank lines,
 * one `<Family Label> (<family-uid>)` section per family (optionally followed by
 * an indented `aliases: …` line), then indented variant rows
 * `<model_uid>` + 2-or-more spaces + `<label>` with an optional trailing
 * `  [annotation]`, and finally a free-text footer. Only indented, non-alias
 * rows can ever become models, so the preamble, the family headings, the alias
 * notes and the footer are all inert. The `id` is the `model_uid` (what
 * `--model` accepts), the `name` is the label, the `provider` is the family
 * label (or {@link DEVIN_DEFAULT_PROVIDER} for an orphan row) and the trailing
 * annotation — cost / context — becomes the `description`. Ids are deduped.
 * Exported for fixture tests.
 */
export function parseDevinModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let family = "";

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = sanitizeTerminalText(rawLine);
    if (line.trim().length === 0) continue;

    // Indented lines hold either a family's `aliases:` note or a variant row.
    if (/^\s/.test(line)) {
      const body = line.trim();
      if (DEVIN_ALIASES.test(body)) continue;

      const row = DEVIN_MODEL_ROW.exec(body);
      if (!row) continue;
      const id = row[1];
      if (seen.has(id)) continue;

      const annotation = DEVIN_ROW_ANNOTATION.exec(row[2]);
      const name = (annotation ? annotation[1] : row[2]).trim();
      if (!name) continue;
      seen.add(id);

      const description = annotation ? annotation[2].trim() : "";
      models.push({
        id,
        name,
        provider: family || DEVIN_DEFAULT_PROVIDER,
        description: description || undefined,
      });
      continue;
    }

    // A column-0 line is the preamble, a family header or the footer. Only a
    // `<label> (<single-token-uid>)` line starts a family.
    const header = DEVIN_FAMILY_HEADER.exec(line);
    if (header) family = header[1].trim();
  }

  return models;
}

/**
 * Devin's auto-approval switch (Phase 2C): `devin --print` closes stdin after
 * the prompt, so an approval request can never be answered and would stall the
 * cycle. `--permission-mode dangerous` auto-approves every tool — the CLI's own
 * mode (`devin --help`) — and is verified, so the adapter announces it as
 * auto-approved rather than assumed. Overridable through `permissionArgs`.
 */
export const DEVIN_PERMISSION_ARGS = ["--permission-mode", "dangerous"];

/**
 * `devin models list` fetches its account catalog over the network (≈ 3.7 s
 * measured on the reference machine), so it gets a generous — but still bounded
 * and under the NFR-6 ceiling — deadline.
 */
const DEVIN_LIST_TIMEOUT_MS = 15000;

/**
 * Devin CLI (Phase 3A rename of the old `windsurf` target).
 *
 * Non-interactive form: `devin -p/--print` runs a single turn and **requires**
 * the prompt as an argument; a piped stdin is rejected with "Print mode … needs
 * a prompt", so `promptViaStdin` is `false`. A real huginn prompt embeds the
 * spec/ADR/plan and is far larger than `ARG_MAX`, so the prompt is never passed
 * positionally: it is written to a private temp file and handed over through
 * Devin's own `--prompt-file` flag (REV-3A-001, verified in print mode:
 * `devin --print --prompt-file <f>`). Print mode cannot show the
 * workspace-trust prompt and fails in an untrusted directory, so
 * `--respect-workspace-trust false` is always passed. A selected model is
 * forwarded via `--model` (AC-27.5), and `devin mcp list`/`devin models list`
 * feed MCP and model discovery (REQ-32 / REQ-27).
 */
export class DevinRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "devin";
    super({
      id: "devin",
      name: "Devin",
      command,
      // Verified argv shape: `-p` (non-interactive) + workspace-trust opt-out.
      // The prompt is supplied via `--prompt-file` by the session, since print
      // mode does not read it from stdin and rejects prompts larger than ARG_MAX
      // as a positional argument.
      args: options.args ?? ["-p", "--respect-workspace-trust", "false"],
      promptViaStdin: options.promptViaStdin ?? false,
      promptFileFlag: options.promptFileFlag ?? "--prompt-file",
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
      permissionArgs: options.permissionArgs ?? DEVIN_PERMISSION_ARGS,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand ?? {
        command,
        args: ["models", "list"],
        parse: parseDevinModels,
        timeoutMs: DEVIN_LIST_TIMEOUT_MS,
      },
      mcpListCommand: options.mcpListCommand ?? {
        command,
        args: ["mcp", "list"],
        parse: parseDevinMcpList,
        timeoutMs: DEVIN_MCP_LIST_TIMEOUT_MS,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
