import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { render } from "ink";
import { ProfilePickerModal, buildProfileRows } from "../../src/tui/ProfilePickerModal.js";
import { SLASH_COMMANDS, findCommand } from "../../src/tui/commandRegistry.js";
import { PROFILE_NAMES } from "../../src/engine/profiles.js";

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

function createMockStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

interface Harness {
  output: () => string;
  stdin: PassThrough;
  unmount: () => void;
}

async function mount(
  currentProfileId: string,
  onSelect: (id: string, scope: string) => void,
  onCancel: () => void,
): Promise<Harness> {
  const stdout = new PassThrough() as any;
  stdout.columns = 120;
  stdout.rows = 40;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const stdin = createMockStdin();
  const instance = render(
    React.createElement(ProfilePickerModal, { currentProfileId, onSelect, onCancel } as any),
    { stdout, stdin, patchConsole: false },
  );
  // Ink flushes its first frame on a timer; give it a beat before reading.
  await tick(120);
  return { output: () => output, stdin, unmount: () => instance.unmount() };
}

/**
 * REQ-54 / ADR-53 — the methodology profile is selectable in-session, not only
 * fixable before the run.
 */
describe("ProfilePickerModal (REQ-54)", () => {
  it("lists every profile and marks the active one (AC-54.1)", async () => {
    const view = await mount("sdd", () => {}, () => {});
    // Ink flushes a non-TTY frame on unmount.
    view.unmount();
    const output = view.output();
    for (const id of PROFILE_NAMES) {
      expect(output).toContain(id);
    }
    expect(output).toContain("● active");
    expect(output).toContain("Huginn Cycle");
    // The one rule a user must know is stated (AC-54.4).
    expect(output).toContain("applies to the next cycle");
  });

  it("applies for the session on Enter, the project on p, globally on g (AC-54.3)", async () => {
    const calls: Array<[string, string]> = [];
    const view = await mount("huginn", (id, scope) => calls.push([id, scope]), () => {});
    try {
      // Move off the active profile so Enter is not a no-op.
      view.stdin.write("j");
      await tick();
      view.stdin.write("\r");
      await tick();
      expect(calls).toEqual([["sdd", "session"]]);

      view.stdin.write("p");
      await tick();
      expect(calls).toEqual([
        ["sdd", "session"],
        ["sdd", "project"],
      ]);

      view.stdin.write("g");
      await tick();
      expect(calls).toEqual([
        ["sdd", "session"],
        ["sdd", "project"],
        ["sdd", "global"],
      ]);
    } finally {
      view.unmount();
    }
  });

  it("cancels on Esc", async () => {
    let cancelled = 0;
    const view = await mount("huginn", () => {}, () => {
      cancelled++;
    });
    try {
      view.stdin.write("\u001b");
      await tick();
      expect(cancelled).toBe(1);
    } finally {
      view.unmount();
    }
  });

  it("is registered so the palette and the cheat sheet can reach it (AC-54.5)", () => {
    const row = buildProfileRows();
    expect(row.map((r) => r.id)).toEqual([...PROFILE_NAMES]);
    expect(SLASH_COMMANDS.map((c) => c.id)).toContain("/profile");
    expect(findCommand("/profile")?.id).toBe("/profile");
    expect(findCommand("/profile sdd")?.id).toBe("/profile");
  });
});
