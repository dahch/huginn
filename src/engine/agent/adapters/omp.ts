import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/** Line that frames the `omp models` table, e.g. `┌───┬───┐` / `├───┼───┤` / `└───┴───┘`. */
const OMP_TABLE_BORDER = /^[\s─│┌┬┐├┼┤└┴┘]+$/u;

/** Provider group heading, e.g. `deepseek (4)` / `opencode-zen (109)`. */
const OMP_GROUP_HEADING = /^(\S+(?: \S+)*)\s+\((\d+)\)$/;

/** Cell separator of the box-drawing table (`│`). */
const OMP_CELL_SEPARATOR = "│";

/** Header cell of the model column, skipped so it never becomes a model id. */
const OMP_MODEL_COLUMN_HEADER = "model";

/**
 * Builds a compact, human-readable description from the trailing table cells
 * (`context`, `max-out`, `thinking`, `images`) — real data from the CLI, never
 * invented. Empty / `-` ("not applicable") values are dropped.
 */
function describeOmpRow(labels: string[], cells: string[]): string | undefined {
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
 * Pure parser for `omp models` output (REQ-27 / AC-27.4).
 *
 * Verified format: blank-line-separated provider sections. Each section starts
 * with a heading of the form `<provider> (<count>)`, followed by a box-drawing
 * table whose header row is `│ model │ context │ … │`, whose data rows start
 * with `│` and whose first cell is the model name, and whose borders are made
 * of `┌ ├ └ ─ ┬ ┼ ┴ ┐ ┘`. Headings, the header row and all border lines are
 * skipped so they can never become model ids; the group heading is the model's
 * provider and the id is `<provider>/<model>` (unique across sections, since the
 * same model name may appear under several providers). Exported for fixture
 * tests.
 */
export function parseOmpModels(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let provider = "";
  let headerLabels: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = sanitizeTerminalText(rawLine);
    if (!line.trim()) continue;
    if (OMP_TABLE_BORDER.test(line)) continue;

    const trimmed = line.trim();

    if (trimmed.startsWith(OMP_CELL_SEPARATOR)) {
      const cells = trimmed.split(OMP_CELL_SEPARATOR).map((cell) => cell.trim());
      // `│ a │ b │`.split("│") → ["", "a", "b", ""] — the first cell is the model.
      const name = cells[1] ?? "";
      if (name.toLowerCase() === OMP_MODEL_COLUMN_HEADER) {
        headerLabels = cells;
        continue;
      }
      if (!name) continue;

      const id = provider ? `${provider}/${name}` : name;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        name,
        provider: provider || id,
        description: describeOmpRow(headerLabels, cells),
      });
      continue;
    }

    // Unindented, non-table line → provider group heading (`<provider> (<count>)`).
    const heading = OMP_GROUP_HEADING.exec(trimmed);
    if (heading) provider = heading[1].trim();
  }

  return models;
}

/**
 * Oh My Pi's auto-approval switch (Phase 2C): `omp prompt` closes stdin after
 * the prompt, so an approval request can never be answered. It is omp's own flag
 * (re-verify with `omp --help`) and is overridable through `permissionArgs`.
 */
export const OMP_PERMISSION_ARGS = ["--auto-approve"];

/**
 * Oh My Pi CLI. `omp models` prints its catalog as provider sections with a
 * box-drawing table (AC-27.4); a selected model is forwarded via `--model`
 * (AC-27.5).
 *
 * `omp` exposes no MCP listing command (verified), so `listMcpServers()`
 * honestly resolves `[]` (the base adapter's behaviour) and the MCP panel falls
 * back to config-file discovery, labelled `unknown` (REQ-32 / AC-32.1).
 */
export class OmpRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "omp",
      name: "Oh My Pi",
      command: options.command ?? "omp",
      args: options.args ?? ["prompt"],
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
      permissionArgs: options.permissionArgs ?? OMP_PERMISSION_ARGS,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand ?? {
        command: "omp",
        args: ["models"],
        parse: parseOmpModels,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
