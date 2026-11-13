/**
 * `bun run scripts/probe-runtimes.ts [--prompt] [--model <id>]`
 *
 * One diagnostic for "is this runtime actually usable on this machine?".
 *
 * `huginn runtime list --check` answers availability; this goes one step further
 * and, with --prompt, opens a real session and asks for one word. It exists
 * because a capability table is a claim, and a claim should be reproducible by
 * the person running it.
 */
import { getRuntimePort } from "../src/engine/agent/registry.js";
import type { AgentTarget } from "../src/agents/integrator.js";

const TARGETS: AgentTarget[] = ["pi", "codex", "claude", "opencode"];
const argv = process.argv.slice(2);
const withPrompt = argv.includes("--prompt");
const modelArg = argv.indexOf("--model") >= 0 ? argv[argv.indexOf("--model") + 1] : undefined;

function fmt(caps: Record<string, unknown>): string {
  const on = (value: unknown) => (value === true ? "yes" : value === "none" ? "none" : value);
  return [
    "stream=" + on(caps.streaming),
    "events=" + on(caps.structuredEvents),
    "history=" + on(caps.sessionHistory),
    "resume=" + on(caps.sessionResume),
    "perm=" + on(caps.permissions),
    "catalog=" + on(caps.modelCatalog),
    "usage=" + on(caps.usageCost),
    "mcp=" + on(caps.mcpListing),
    "abort=" + on(caps.interrupt),
  ].join(" ");
}

for (const target of TARGETS) {
  console.log("\n=== " + target);
  let port;
  try {
    port = getRuntimePort(target, { projectPath: process.cwd() });
  } catch (error) {
    console.log("  port: FAILED TO BUILD — " + (error as Error).message);
    continue;
  }
  console.log("  caps: " + fmt(port.capabilities as unknown as Record<string, unknown>));

  try {
    const availability = await port.isAvailable();
    console.log(
      "  availability: " + (availability.ok ? "ok" : "UNAVAILABLE") +
        (availability.reason ? " — " + availability.reason : "") +
        (availability.note ? " (note: " + availability.note + ")" : ""),
    );
  } catch (error) {
    console.log("  availability: THREW — " + (error as Error).message);
  }

  try {
    const catalog = await port.listModels();
    console.log(
      "  models: " + catalog.models.length +
        (catalog.models.length > 0 ? " (" + catalog.models.slice(0, 3).map((m) => m.id).join(", ") + "…)" : "") +
        (catalog.reason ? " — " + catalog.reason : ""),
    );
  } catch (error) {
    console.log("  models: THREW — " + (error as Error).message);
  }

  if (!withPrompt) continue;
  const started = Date.now();
  try {
    // A daemon-backed driver (opencode) must start before a session can connect;
    // `isAvailable` deliberately never starts it.
    await port.start?.();
    const session = await port.createSession({ sink: () => {}, cwd: process.cwd() });
    const result = await session.prompt({ text: "Reply with exactly: pong", model: modelArg });
    await session.close();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log("  prompt: ok in " + elapsed + "s — " + JSON.stringify(result).slice(0, 160));
  } catch (error) {
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log("  prompt: FAILED in " + elapsed + "s — " + (error as Error).message);
  }
}

process.exit(0);
