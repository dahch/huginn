import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AGENT_TARGETS } from "../../src/agents/integrator.js";
import { pickAgentInteractively } from "../../src/tui/pickAgent";

/** Tick like the other Ink suites: Ink flushes on unmount. */
const tick = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createStdout(): any {
  const stdout = new PassThrough() as any;
  stdout.columns = 100;
  stdout.rows = 30;
  return stdout;
}

function createStdin(): any {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function detectRows(available: string[]) {
  return async () =>
    AGENT_TARGETS.map((id) => ({
      id,
      available: available.includes(id),
      path: available.includes(id) ? `/usr/bin/${id}` : undefined,
    }));
}

describe("pickAgentInteractively (init host)", () => {
  it("resolves the highlighted runtime and the scope the host allows", async () => {
    const stdin = createStdin();
    const promise = pickAgentInteractively({
      currentAgentId: "opencode",
      detect: detectRows(["claude", "opencode"]),
      scopes: ["project"],
      stdout: createStdout(),
      stdin,
    });
    await tick();
    stdin.write("\r");
    // currentAgentId is in the list, so the highlight opens on it.
    await expect(promise).resolves.toEqual({ id: "opencode", scope: "project" });
  });

  it("resolves undefined on Esc instead of rejecting", async () => {
    const stdin = createStdin();
    const promise = pickAgentInteractively({
      currentAgentId: "opencode",
      detect: detectRows(["claude"]),
      stdout: createStdout(),
      stdin,
    });
    await tick();
    stdin.write("\u001B");
    await expect(promise).resolves.toBeUndefined();
  });

  it("honours the narrow scope set: the unoffered keys never resolve a selection", async () => {
    const stdin = createStdin();
    const promise = pickAgentInteractively({
      currentAgentId: "opencode",
      detect: detectRows(["claude", "opencode"]),
      scopes: ["project"],
      stdout: createStdout(),
      stdin,
    });
    await tick();
    // The highlight opens on the active runtime (opencode); 'g' is not offered.
    stdin.write("g");
    await tick(40);
    stdin.write("\r");
    await expect(promise).resolves.toEqual({ id: "opencode", scope: "project" });
  });
});
