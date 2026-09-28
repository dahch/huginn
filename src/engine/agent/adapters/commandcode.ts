import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/** Line that opens the trailing help/docs block of `commandcode --list-models`. */
const COMMANDCODE_FOOTER_PREFIXES = ["Pass the full id", "cmd ", "Docs:", "Decision models"];

/** `id` + 2-or-more spaces + description, e.g. `deepseek/deepseek-v4-pro   long-context …`. */
const COMMANDCODE_MODEL_ROW = /^\s*(\S+)\s{2,}(.+)$/;

/**
 * Section heading shape (REV-006): unindented, single-spaced and never a
 * `provider/model` id. Without the last two conditions a *malformed* single-space
 * model row (`deepseek/deepseek-v4-pro hybrid-attention …`) would be mistaken for
 * a heading and silently mis-attribute every bare id that follows it. Real
 * headings (`Open Source`, `Anthropic`, `Sakana`, `xAI`, …) all satisfy this.
 */
const COMMANDCODE_GROUP_HEADING = /^(?!.*\/)\S+(?: \S+)*$/;

function isCommandCodeFooter(line: string): boolean {
  const trimmed = line.trim();
  return COMMANDCODE_FOOTER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Pure parser for `commandcode --list-models` output (REQ-27 / AC-27.3).
 *
 * Verified format: an `Available models  ·  N models` header, blank lines,
 * provider group headings on their own (unindented) line, then `id` +
 * description rows with a 2-space gap, followed by a help/docs footer that
 * must be ignored. The id column is preserved verbatim, so bare ids such as
 * `claude-sonnet-5` stay bare; the provider is the id's prefix before the first
 * `/` when present, otherwise the current group heading. Exported for fixture
 * tests.
 */
export function parseCommandCodeModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let group = "";

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = sanitizeTerminalText(rawLine);
    if (!line.trim()) continue;
    if (isCommandCodeFooter(line)) break;

    const trimmed = line.trim();
    // Header: `Available models  ·  N models`
    if (/^Available models\b/.test(trimmed)) continue;

    const row = COMMANDCODE_MODEL_ROW.exec(line);
    if (row) {
      const id = row[1];
      const description = row[2].trim();
      if (seen.has(id)) continue;
      seen.add(id);
      const slashIdx = id.indexOf("/");
      const provider = slashIdx > 0 ? id.slice(0, slashIdx) : group || id;
      const modelPath = slashIdx > 0 ? id.slice(slashIdx + 1) : id;
      const name = modelPath.slice(modelPath.lastIndexOf("/") + 1) || modelPath;
      models.push({ id, name, provider, description: description || undefined });
      continue;
    }

    // No leading whitespace, single-spaced, no `/` → provider group heading
    // (REV-006: a malformed single-space model row must not be swallowed here).
    if (line === trimmed && COMMANDCODE_GROUP_HEADING.test(trimmed)) {
      group = trimmed;
    }
  }

  return models;
}

/**
 * `commandcode --list-models` fetches its catalog over the network (≈3.5 s
 * measured on the reference machine), so it gets a more generous bound than the
 * local `opencode models` fallback while staying under the NFR-6 ceiling.
 */
const COMMANDCODE_LIST_TIMEOUT_MS = 10000;

export class CommandCodeRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "commandcode",
      name: "Command Code",
      command: options.command ?? "commandcode",
      // Verified non-interactive form: `-p`/`--print` (there is no `exec`
      // subcommand) and the prompt is read from stdin.
      args: options.args ?? ["-p"],
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
      modelListCommand: options.modelListCommand ?? {
        command: "commandcode",
        args: ["--list-models"],
        parse: parseCommandCodeModels,
        timeoutMs: COMMANDCODE_LIST_TIMEOUT_MS,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }

  override async isAvailable(): Promise<boolean> {
    if (await super.isAvailable()) return true;
    const fallback = new GenericSubprocessRuntimeAdapter({
      ...this.options,
      command: "command-code",
    });
    return fallback.isAvailable();
  }
}
