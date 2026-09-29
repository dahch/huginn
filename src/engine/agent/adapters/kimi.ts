import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/**
 * Provider badge for a `kimi provider list --json` model whose row carries no
 * `provider` field. The runtime label doubles as the fallback, so a partial
 * listing can never attribute a model to a provider the CLI did not name.
 */
export const KIMI_DEFAULT_PROVIDER = "kimi";

/**
 * Kimi Code's auto-approval wiring — **empty on purpose** (Phase 3C).
 *
 * Kimi's non-interactive form is prompt mode (`kimi --prompt=<text>`), and prompt
 * mode *rejects* every permission switch:
 *
 * ```
 * $ kimi -p "hi" --auto   # → error: Cannot combine --prompt with --auto.
 * $ kimi -p "hi" -y       # → error: Cannot combine --prompt with --yolo.
 * $ kimi -p "hi" --plan   # → error: Cannot combine --prompt with --plan.
 * ```
 *
 * (all three observed live against kimi 2.1.1; `-y/--yolo` is only "Ask When
 * Needed" — risky actions still ask — while `--auto` is "Never Ask".) No flag is
 * needed: prompt mode runs the prompt to completion without ever asking, and it
 * is the only channel the CLI documents for a one-shot run, so the session is
 * Never Ask by construction. Wiring `["--auto"]` here would therefore not merely
 * be redundant: it would make **every** prompt fail with `Cannot combine
 * --prompt with --auto`, which is the Phase 3C bug this replaces.
 *
 * The empty array keeps the table/adapter single-source-of-truth pattern
 * (REV-3A-004) while telling `GenericSubprocessRuntimeAdapter` that this runtime
 * has no auto-approval *flag*: no flag is added to argv and the flag-driven
 * "auto-approved permissions" notice stays silent (there is no flag to announce
 * — the CLI's own prompt mode is what makes it non-interactive).
 */
export const KIMI_PERMISSION_ARGS: string[] = [];

/**
 * Prompt-mode prompts travel as the **value** of the prompt flag, so they are
 * bounded by the kernel's per-argument limit `MAX_ARG_STRLEN` (~128 KB on Linux,
 * 256 KB on macOS).
 *
 * The budget is measured in **UTF-8 bytes** (SEC-302): the kernel limits by
 * bytes, so a multi-byte prompt hits 120 KB well before its UTF-16 `length`
 * reaches that number — the check in the generic adapter uses
 * `Buffer.byteLength`, not `String#length`. 120 KB sits comfortably under
 * Linux's 128 KB `MAX_ARG_STRLEN` while leaving room for the rest of the argv
 * and environment. Kimi offers no prompt-file flag and does not read the prompt
 * from stdin (see {@link KimiRuntimeAdapter}), so this cap — not the 4096
 * positional default — is what decides when a huginn prompt (spec + ADR + plan)
 * is too large for the runtime. The failure is an explicit error rather than a
 * truncated or E2BIG-silent prompt.
 */
export const KIMI_MAX_PROMPT_ARG_LENGTH = 120_000;

/** `kimi provider list --json` only reads the local config (measured ≈ 0.6 s). */
export const KIMI_MODEL_LIST_TIMEOUT_MS = 8000;

/**
 * Pure parser for `kimi provider list --json` (REQ-27 / AC-27.4, amended for
 * Phase 3C).
 *
 * Verified format: a two-key JSON document
 * `{ providers: { <id>: { type, baseUrl, apiKeyEnv, … } }, models: { <alias>: {
 * provider, model, maxContextSize, …, displayName } } }` (captured from kimi
 * 2.1.1; see `test/fixtures/README.md` for the provenance of
 * `kimi-provider-list.json`). The model **alias** is the key — it is what
 * `-m/--model` accepts — so `id` is the alias, `name` is the row's
 * `displayName` (falling back to the alias) and `provider` is the row's own
 * `provider` (falling back to {@link KIMI_DEFAULT_PROVIDER}).
 *
 * Nothing is invented: a row that is not an object, or a document without a
 * `models` object (e.g. the `{"providers":{},"models":{}}` a machine with no
 * providers configured prints), yields `[]`; a document that is not a JSON
 * object at all throws so the caller reports "could not parse" instead of an
 * indistinguishable empty catalog. Only `models` is read — the command also
 * echoes `providers`, which may carry an inline `apiKey` from the user's
 * `config.toml`, so its stdout is never surfaced by this parser or the caller.
 * Exported for fixture tests.
 */
export function parseKimiModels(
  stdout: string,
  fallbackProvider: string = KIMI_DEFAULT_PROVIDER,
): ModelInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("`kimi provider list --json` did not print a JSON object");
  }

  const modelsField = (parsed as { models?: unknown }).models;
  if (modelsField === null || typeof modelsField !== "object" || Array.isArray(modelsField)) {
    return [];
  }

  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const [rawAlias, value] of Object.entries(modelsField as Record<string, unknown>)) {
    const alias = sanitizeTerminalText(rawAlias).trim();
    if (!alias || seen.has(alias)) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;

    const row = value as Record<string, unknown>;
    const provider = typeof row.provider === "string" ? sanitizeTerminalText(row.provider).trim() : "";
    const displayName = typeof row.displayName === "string" ? sanitizeTerminalText(row.displayName).trim() : "";
    seen.add(alias);

    models.push({
      id: alias,
      name: displayName || alias,
      provider: provider || fallbackProvider,
    });
  }

  return models;
}

/**
 * Kimi Code CLI (`kimi-code` 2.1.1), Phase 3C.
 *
 * Non-interactive form: **prompt mode** `kimi -p/--prompt <prompt>` ("Run one
 * prompt non-interactively and print the response"). Verified against the
 * installed CLI — and it is the one channel that works:
 *
 * - the prompt is **required as the flag's value**: a bare `kimi -p` fails with
 *   `error: option '-p, --prompt <prompt>' argument missing` — so the previous
 *   wiring (`args: []`, no `promptViaStdin`, no flag) started the *interactive*
 *   TUI with the prompt on stdin and hung the cycle;
 * - there is **no stdin channel**: `echo … | kimi -p` never reads stdin (prompt
 *   mode consumes `opts.prompt` only), and `kimi -p -` sends the literal text
 *   `-` (no `-`-means-stdin handling exists);
 * - there is **no prompt-file flag** (`kimi --help`: no `--prompt-file`).
 *
 * Hence `promptViaStdin: false` + `promptValueFlag: "--prompt="` with a
 * realistic {@link KIMI_MAX_PROMPT_ARG_LENGTH} in **bytes** — the documented
 * last resort of the generic adapter (see its `promptValueFlag` docs for the
 * `ps`/`ARG_MAX` trade-off). The inline `--prompt=<text>` shape is preferred over
 * the separate `-p <text>`: the CLI's own parser (node:util `parseArgs`) reports
 * a separate value that begins with `-` as ambiguous ("Option '-p' argument is
 * ambiguous"), while `--prompt=<text>` resolves for any text (SEC-304). The base
 * argv is intentionally empty so the built argv is exactly
 * `["--prompt=<prompt>"]` (plus `-m <model>` when a model is selected).
 *
 * Permissions: kimi is launched with **no** flag — prompt mode is already Never
 * Ask and rejects `--auto`/`-y` (see {@link KIMI_PERMISSION_ARGS}).
 *
 * Discovery: `kimi provider list --json` feeds model discovery (AC-27.4). The
 * CLI exposes **no** `mcp` command (`kimi --help`: export, fork, provider,
 * session, acp, web, server, rc, login, doctor, vis, install-desktop, migrate,
 * upgrade), so `listMcpServers()` honestly resolves `[]` and the MCP panel falls
 * back to config-file discovery — which does see kimi's own
 * `~/.kimi-code/mcp.json` (`AGENT_REGISTRY.kimi.mcpPaths`).
 */
export class KimiRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "kimi";
    super({
      id: "kimi",
      name: "Kimi Code CLI",
      command,
      // Verified argv shape: the prompt *is* the prompt flag's value, so no flag
      // belongs in the base argv (the session appends `--prompt=<prompt>`) and no
      // positional separator is used. The trailing `=` selects the inline,
      // unambiguous shape — see `buildPromptValueArgs` (SEC-304).
      args: options.args ?? [],
      promptViaStdin: options.promptViaStdin ?? false,
      promptValueFlag: options.promptValueFlag ?? "--prompt=",
      maxPromptArgLength: options.maxPromptArgLength ?? KIMI_MAX_PROMPT_ARG_LENGTH,
      models: options.models,
      // `-m, --model <model>`: "LLM model alias to use for this invocation"
      // (kimi --help). The catalog's ids are exactly those aliases.
      modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
      permissionArgs: options.permissionArgs ?? KIMI_PERMISSION_ARGS,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand ?? {
        command,
        args: ["provider", "list", "--json"],
        parse: parseKimiModels,
        timeoutMs: KIMI_MODEL_LIST_TIMEOUT_MS,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
