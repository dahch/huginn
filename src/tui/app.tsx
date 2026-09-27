import type { CycleEngine } from "../engine/cycle";
import type { LiveEngine } from "../engine/liveMode";
import type { RunConfig } from "../config";

export async function runTui(engine: CycleEngine, cfg: RunConfig): Promise<void> {
  const { renderTui } = await import("./render");
  await renderTui(engine, cfg);
}

export async function runLiveTui(live: LiveEngine, cfg: RunConfig): Promise<void> {
  const { renderLiveTui } = await import("./render");
  await renderLiveTui(live, cfg);
}
