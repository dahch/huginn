import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/**
 * Pi's project-trust override (Phase 2C), kept deliberately unverified as a
 * blanket auto-approval. `pi --help` documents `-a, --approve` as "Trust
 * project-local files for this run" and the CLI's own parser confirms it
 * (`@earendil-works/pi-coding-agent` 0.87.1 `dist/cli/args.js`:
 * `--approve`/`-a` → `projectTrustOverride = true`). That is *project resource
 * trust*, not tool-call auto-approval: pi's built-in `read`/`bash`/`edit`/
 * `write` tools do not ask per call, so the flag is what keeps a
 * project-local extension/skill/`AGENTS.md` from being silently skipped when a
 * project is untrusted. It stays wired (a subprocess CLI cannot answer a trust
 * prompt), and the adapter keeps announcing it as *assumed* rather than
 * auto-approved (REV-2C-002, `permissionArgsVerified: false`).
 */
export const PI_PERMISSION_ARGS = ["--approve"];

/** `pi --list-models` reads the local model store (measured ≈ 0.2 s). */
export const PI_MODEL_LIST_TIMEOUT_MS = 8000;

/** Cell separator of the aligned `pi --list-models` table (2+ spaces or tabs). */
const PI_CELL_SEPARATOR = /(?:\t+| {2,})/;

/** First two column labels — what identifies the table header. */
const PI_HEADER_FIRST_COLUMN = "provider";
const PI_HEADER_SECOND_COLUMN = "model";

/**
 * Builds a compact description from the trailing table cells (`context`,
 * `max-out`, `thinking`, `images`) using the **header's own labels** — real data
 * from the CLI, never invented. Empty and `-` ("not applicable") cells are
 * dropped.
 */
function describePiRow(labels: string[], cells: string[]): string | undefined {
  const parts: string[] = [];
  for (let i = 2; i < cells.length; i++) {
    const value = cells[i]?.trim() ?? "";
    if (!value || value === "-") continue;
    const label = labels[i]?.trim();
    parts.push(label ? `${label} ${value}` : value);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Pure parser for `pi --list-models` output (REQ-27 / AC-27.4, amended for
 * Phase 3C).
 *
 * Verified format: one aligned table — a header row
 * `provider  model  context  max-out  thinking  images` followed by one row per
 * available model (`deepseek  deepseek-v4-pro  1M  384K  yes  no`), columns
 * padded with `padEnd` and joined by two spaces, so each populated cell is
 * separated by a 2+-space run (see `test/fixtures/pi-models.txt`).
 *
 * The header is what makes the parse safe: its cell labels are captured and a
 * data row is only accepted when it splits into **exactly** as many cells as the
 * header has columns, with non-empty, whitespace-free `provider` and `model`
 * cells. Free-text output the same command prints instead of a table (`No models
 * available. …`, `No models matching "x"`, and the multi-line login help below
 * it) can therefore never become a model, and a row whose columns collapsed
 * (e.g. from an empty cell) is skipped rather than misread — an honest
 * under-report instead of a wrong `provider/model` id. The `id` is
 * `<provider>/<model>` (what `--model` accepts, and what the opencode fallback
 * prints), the `name` is the model column and the `description` is the trailing
 * columns with their own header labels. Ids are deduped. Exported for fixture
 * tests.
 */
export function parsePiModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let labels: string[] | undefined;

  for (const rawLine of sanitizeTerminalText(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const cells = line.split(PI_CELL_SEPARATOR).map((cell) => cell.trim());

    if (cells[0] === PI_HEADER_FIRST_COLUMN && cells[1] === PI_HEADER_SECOND_COLUMN) {
      labels = cells;
      continue;
    }

    // Only a row shaped exactly like the header's own table can be a model.
    if (!labels || cells.length !== labels.length) continue;

    const provider = cells[0];
    const model = cells[1];
    if (!provider || !model || /\s/.test(provider) || /\s/.test(model)) continue;

    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);

    models.push({
      id,
      name: model,
      provider,
      description: describePiRow(labels, cells),
    });
  }

  return models;
}

/**
 * Pi coding agent (`@earendil-works/pi-coding-agent` 0.87.1), Phase 3C.
 *
 * Non-interactive form: `pi -p/--print` ("Non-interactive mode: process prompt
 * and exit"). The prompt is **not** required positionally — pi reads piped
 * stdin and prepends it to the first prompt (verified live:
 * `echo "Reply with exactly: OK" | pi -p` answers `OK`, and the CLI's own
 * `dist/main.js` `readPipedStdin()`/`buildInitialMessage()` pair implements it,
 * with the official docs stating "Piped stdin | Prepend its contents to the
 * first prompt"). Huginn spawns the session with a pipe on stdin and closes it
 * right after writing (SEC-002), so `args: ["-p"]` with `promptViaStdin: true`
 * is the correct wiring and the prompt never reaches the argv. Pi also switches
 * to print mode on its own whenever stdin or stdout is not a TTY.
 *
 * Model selection is forwarded through `--model <pattern>` (AC-27.5): the CLI
 * accepts `provider/id` — the exact shape of this runtime's catalog ids — and
 * `-m` is **not** an alias (`dist/cli/args.js` only recognises `--model`, so the
 * previous `["-m", model]` was parsed as *messages*: a real Phase 3C bug).
 * Verified live with `pi -p --model deepseek/deepseek-v4-pro`.
 *
 * Listings: `pi --list-models` feeds model discovery (AC-27.4). Pi exposes no
 * `mcp` command (`pi --help`: install, remove/uninstall, update, list, config,
 * auth), so `listMcpServers()` honestly resolves `[]` and the panel falls back
 * to config-file discovery (`AGENT_REGISTRY.pi.mcpPaths`).
 *
 * Permissions: launched with `--approve` (project-resource trust) and announced
 * as *assumed* — see {@link PI_PERMISSION_ARGS}.
 */
export class PiRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "pi";
    super({
      id: "pi",
      name: "Pi coding agent",
      command,
      // Verified argv shape: print mode, prompt streamed over stdin.
      args: options.args ?? ["-p"],
      promptViaStdin: options.promptViaStdin ?? true,
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
      permissionArgs: options.permissionArgs ?? PI_PERMISSION_ARGS,
      // REV-2C-002: `--approve` is project trust, not tool auto-approval.
      permissionArgsVerified: options.permissionArgsVerified ?? false,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand ?? {
        command,
        args: ["--list-models"],
        parse: parsePiModels,
        timeoutMs: PI_MODEL_LIST_TIMEOUT_MS,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
