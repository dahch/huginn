import { render } from "ink";
import { format } from "node:util";
import type { CycleEngine } from "../engine/cycle";
import type { LiveEngine } from "../engine/liveMode";
import type { RunConfig } from "../config";
import { events } from "../engine/engineEvents";
import { Dashboard } from "./Dashboard";
import { LiveApp } from "./LiveDashboard";

export const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
export const EXIT_ALT_SCREEN = "\x1b[?1049l\x1b[?25h";

let originalConsole: {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
} | null = null;

let isEmittingLog = false;

export function patchConsole(): void {
  if (originalConsole) return;

  originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  const createInterceptor = (level: "info" | "warn" | "error") => {
    return (...args: unknown[]) => {
      if (isEmittingLog) {
        originalConsole?.[level === "info" ? "log" : level](...args);
        return;
      }
      isEmittingLog = true;
      try {
        const message = format(...args);
        events.emit("log", {
          level,
          message,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        originalConsole?.error(err);
      } finally {
        isEmittingLog = false;
      }
    };
  };

  console.log = createInterceptor("info");
  console.warn = createInterceptor("warn");
  console.error = createInterceptor("error");
}

export function unpatchConsole(): void {
  if (!originalConsole) return;
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  originalConsole = null;
}

export function setupTuiEnvironment(): () => void {
  patchConsole();
  process.stdout.write(ENTER_ALT_SCREEN);

  let cleanedUp = false;
  const restore = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      process.stdout.write(EXIT_ALT_SCREEN);
    } finally {
      unpatchConsole();
    }
  };

  const sigHandler = () => {
    restore();
  };

  const exitHandler = () => {
    restore();
  };

  const uncaughtHandler = () => {
    restore();
  };

  process.once("SIGINT", sigHandler);
  process.once("SIGTERM", sigHandler);
  process.once("uncaughtException", uncaughtHandler);
  process.on("exit", exitHandler);

  return () => {
    process.removeListener("SIGINT", sigHandler);
    process.removeListener("SIGTERM", sigHandler);
    process.removeListener("uncaughtException", uncaughtHandler);
    process.removeListener("exit", exitHandler);
    restore();
  };
}

export async function renderTui(engine: CycleEngine, cfg: RunConfig): Promise<void> {
  const cleanup = setupTuiEnvironment();
  try {
    const { waitUntilExit } = render(<Dashboard engine={engine} cfg={cfg} />);
    engine.run().catch((err) => {
      // persist() inside engine.run() can throw; surface it and let the Dashboard
      // react to the done event instead of hanging with an unhandled rejection.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[huginn] fatal: ${msg}`);
      events.emit("done", { reason: "error", error: msg });
    });
    await waitUntilExit();
  } finally {
    cleanup();
  }
}

export async function renderLiveTui(live: LiveEngine, cfg: RunConfig): Promise<void> {
  const cleanup = setupTuiEnvironment();
  try {
    const { waitUntilExit } = render(<LiveApp live={live} cfg={cfg} />);
    await waitUntilExit();
  } finally {
    cleanup();
  }
}
