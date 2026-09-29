import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import { parseOpencodeMcpList } from "./mcpList.js";
import type { ModelInfo } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/**
 * One `mimo models` row: `<provider>/<model> — <description>`.
 *
 * Verified against the captured `test/fixtures/mimo-models.txt` (MiMo Code
 * 0.1.15): `deepseek/deepseek-flash — window 1M, compacts at 900K`. The id is
 * `<provider>/<model>` (what `--model` accepts verbatim), the separator is a
 * U+2014 EM DASH padded with single spaces, and the tail is the CLI's own
 * context-window note.
 *
 * The EM DASH is what keeps the parser inert on every other line: `mimo models
 * --verbose` interleaves a multi-line JSON document per model, and no JSON line
 * contains ` — ` (verified against the full 550-line verbose output), while an
 * id column can never contain whitespace or a dash.
 */
const MIMO_MODEL_ROW = /^([^\s/—]+)\/([^\s—]+)\s+—\s+(\S.*)$/u;

/**
 * Pure parser for `mimo models` output (REQ-27 / AC-27.4).
 *
 * Verified format: one unindented `<provider>/<model> — <description>` line per
 * model, in the CLI's default (non-verbose) mode. The `id` is the full
 * `provider/model` reference the CLI itself prints, the `name` is its last path
 * segment and the `provider` is the part before the first `/` — so a model whose
 * id carries slashes of its own (`fireworks-ai/accounts/…`) still yields the
 * same short name the `opencode models` fallback produces. Every other line
 * (blank, preamble, footer, or any of the INERT JSON blocks `--verbose` adds) is
 * ignored rather than guessed at, and ids are deduped. Exported for fixture
 * tests.
 */
export function parseMimoModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = sanitizeTerminalText(rawLine);
    const row = MIMO_MODEL_ROW.exec(line);
    if (!row) continue;

    const provider = row[1];
    const modelPath = row[2];
    const id = `${provider}/${modelPath}`;
    if (seen.has(id)) continue;

    const description = row[3].trim();
    if (!description) continue;
    seen.add(id);

    const shortName = modelPath.slice(modelPath.lastIndexOf("/") + 1);
    models.push({ id, name: shortName || modelPath, provider, description });
  }

  return models;
}

/**
 * MiMo Code's auto-approval switch (Phase 3B): `mimo run` closes stdin right
 * after the prompt, so an approval request can never be answered and would stall
 * the cycle until the phase timeout. `--yolo` is the CLI's own documented alias
 * of `--dangerously-skip-permissions` ("auto-approve permissions that are not
 * explicitly denied") and is accepted by the `run` subcommand — verified with
 * `mimo run --yolo` (whereas the *global* `--trust`/`--never-ask` are rejected
 * by `run`, so they are deliberately not wired). Overridable through
 * `permissionArgs`.
 */
export const MIMO_PERMISSION_ARGS = ["--yolo"];

/** `mimo mcp list` reads its merged local configs (measured ≈ 1.9 s). */
export const MIMO_MCP_LIST_TIMEOUT_MS = 5000;

/**
 * MiMo Code CLI (Phase 3B) — an opencode-derived MiMo/Xiaomi coding agent.
 *
 * Non-interactive form: `mimo run [message..]` runs a single turn. The prompt is
 * **not** required positionally: `mimo run` reads it from stdin when no message
 * argument is given (verified end to end — `echo … | mimo run -m
 * deepseek/deepseek-flash` answered the piped prompt, while `mimo run <
 * /dev/null` fails with "You must provide a message or a command"), so
 * `promptViaStdin` is `true` and a real huginn prompt never travels on the argv
 * (SEC-002). A selected model is forwarded via `--model` (AC-27.5).
 *
 * Listings: `mimo models` feeds model discovery (AC-27.4) and `mimo mcp list`
 * answers in opencode's own box-list format verbatim (verified against
 * `test/fixtures/mimo-mcp-list.txt`), so the shared `parseOpencodeMcpList`
 * parser is reused — one parser per format, not per CLI.
 *
 * The CLI is `--permissions`-gated like every other subprocess runtime: `run`
 * cannot ask huginn mid-turn, so it is always launched with `--yolo`.
 */
export class MimoRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "mimo";
    super({
      id: "mimo",
      name: "MiMo Code",
      command,
      // Verified argv shape: `run` with no positional message, so the prompt is
      // streamed over stdin; `--yolo` is appended by the session.
      args: options.args ?? ["run"],
      promptViaStdin: options.promptViaStdin ?? true,
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
      permissionArgs: options.permissionArgs ?? MIMO_PERMISSION_ARGS,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand ?? {
        command,
        args: ["models"],
        parse: parseMimoModels,
      },
      mcpListCommand: options.mcpListCommand ?? {
        command,
        args: ["mcp", "list"],
        parse: parseOpencodeMcpList,
        timeoutMs: MIMO_MCP_LIST_TIMEOUT_MS,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
