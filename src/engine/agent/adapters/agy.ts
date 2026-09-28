import type { ModelInfo } from "../types.js";
import { sanitizeTerminalText } from "../../../util/text.js";

/**
 * Fallback provider for `agy` model ids that carry no `provider/` prefix. `agy`
 * lists bare model ids, so the runtime label doubles as their provider badge
 * (stable regardless of which provider the id happens to route to).
 */
export const AGY_DEFAULT_PROVIDER = "agy";

/**
 * Pure parser for `agy models` output (REQ-27 / AC-27.4).
 *
 * Verified format: one `<id>\t<name>` line per model. A non-TSV preamble (e.g.
 * `Fetching available models...`) and any other non-TSV noise are ignored, as
 * are blank lines and duplicate ids. The provider is the id's prefix before the
 * first `/` when present, otherwise {@link AGY_DEFAULT_PROVIDER}. Exported for
 * fixture tests.
 */
export function parseAgyModels(
  stdout: string,
  fallbackProvider: string = AGY_DEFAULT_PROVIDER,
): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = sanitizeTerminalText(rawLine);
    // Preamble/status noise is never tab-separated — it must not become a model.
    if (!line.includes("\t")) continue;

    const [rawId, ...rest] = line.split("\t");
    const id = rawId.trim();
    // Ids are single tokens (`gemini-3.8-flash-high`); anything else is noise.
    if (!id || /\s/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const name = (rest[0] ?? "").trim();
    const slashIdx = id.indexOf("/");
    const provider = slashIdx > 0 ? id.slice(0, slashIdx) : fallbackProvider;
    models.push({ id, name: name || id, provider });
  }

  return models;
}
