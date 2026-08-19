import { render } from "ink";
import type { CycleEngine } from "../engine/cycle";
import type { LiveEngine } from "../engine/liveMode";
import type { RunConfig } from "../config";
import { events } from "../engine/engineEvents";
import { Dashboard } from "./Dashboard";
import { LiveApp } from "./LiveDashboard";

export async function renderTui(engine: CycleEngine, cfg: RunConfig): Promise<void> {
  const { waitUntilExit } = render(<Dashboard engine={engine} cfg={cfg} />);
  engine.run().catch((err) => {
    // persist() inside engine.run() can throw; surface it and let the Dashboard
    // react to the done event instead of hanging with an unhandled rejection.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[huginn] fatal: ${msg}`);
    events.emit("done", { reason: "error", error: msg });
  });
  await waitUntilExit();
}

export async function renderLiveTui(live: LiveEngine, cfg: RunConfig): Promise<void> {
  const { waitUntilExit } = render(<LiveApp live={live} cfg={cfg} />);
  await waitUntilExit();
}
