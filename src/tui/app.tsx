import type { CycleEngine } from "../engine/cycle";
import type { RunConfig } from "../config";

export async function runTui(engine: CycleEngine, cfg: RunConfig): Promise<void> {
  const { renderTui } = await import("./render");
  await renderTui(engine, cfg);
}
