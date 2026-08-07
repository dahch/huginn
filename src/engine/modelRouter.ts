import type { ModelRef } from "./types";

export interface Models {
  thinker: ModelRef;
  executor: ModelRef;
}

export function formatModel(m: ModelRef): string {
  return `${m.providerID}/${m.modelID}`;
}

export function resolveModel(s: string): ModelRef {
  const idx = s.indexOf("/");
  if (idx <= 0 || idx === s.length - 1) {
    throw new Error(`Invalid model "${s}". Expected "provider/model" (e.g. opencode/gpt-5.1-codex).`);
  }
  return { providerID: s.slice(0, idx), modelID: s.slice(idx + 1) };
}

export function resolveModels(thinker: string, executor: string): Models {
  return { thinker: resolveModel(thinker), executor: resolveModel(executor) };
}
