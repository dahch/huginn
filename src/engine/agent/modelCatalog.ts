/**
 * Shared model-catalog discovery (REV-503 / REV-504 / REV-508).
 *
 * Both the `huginn init` wizard and the TUI model picker need the same "ask the
 * runtime for its models" behavior, and both must be safe *by construction*: a
 * runtime that throws (synchronously or asynchronously), that only implements
 * the base `getAvailableModels()` accessor, or that returns a malformed catalog
 * must degrade to an empty, *reasoned* catalog instead of surfacing an
 * unhandled rejection with a raw error string.
 *
 * Keeping the precedence and the sanitization here — at the boundary — means a
 * new call site cannot reintroduce the drift (REV-503/REV-504) or the
 * terminal-injection hole (SEC-001) this helper closes.
 */
import { sanitizeTerminalText } from "../../util/text.js";
import type { IAgentRuntime, ModelCatalog } from "./types.js";

/**
 * Sanitize a catalog reason at the boundary. Returns `undefined` for a missing,
 * non-string or blank reason, so an empty string can never masquerade as "there
 * is a reason" — the call sites render their generic copy when it is absent.
 */
export function sanitizeCatalogReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  const clean = sanitizeTerminalText(reason).trim();
  return clean.length > 0 ? clean : undefined;
}

/**
 * Best-effort, sanitized reason for a discovery failure (REV-508). Never returns
 * an empty string, so a thrown error always carries an honest explanation.
 */
export function catalogReasonFromError(err: unknown): string {
  return (
    sanitizeCatalogReason(err instanceof Error ? err.message : String(err)) ??
    "model discovery failed"
  );
}

/**
 * Discover the model catalog of a runtime (REQ-27 / AC-27.4).
 *
 * Precedence mirrors the runtime contract: the richer
 * {@link IAgentRuntime.getModelCatalog} is preferred — an empty result can then
 * carry the *reason* it is empty — with the base `getAvailableModels()` as the
 * fallback for runtimes that predate the richer accessor. The runtime is only
 * ever asked to *list* models (no daemon is started and no session is opened),
 * and any throw is caught and degraded to an empty catalog whose `reason` is the
 * sanitized error message (REV-508). The `reason` is sanitized *here*, at the
 * boundary, so every call site is terminal-injection safe by construction.
 */
export async function discoverModelCatalog(runtime: IAgentRuntime): Promise<ModelCatalog> {
  try {
    const catalog: ModelCatalog =
      typeof runtime.getModelCatalog === "function"
        ? await runtime.getModelCatalog()
        : { models: await runtime.getAvailableModels() };
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const reason = sanitizeCatalogReason(catalog?.reason);
    return reason === undefined ? { models } : { models, reason };
  } catch (err) {
    return { models: [], reason: catalogReasonFromError(err) };
  }
}
