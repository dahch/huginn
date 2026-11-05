import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "./inkRender";
import {
  AgentPickerModal,
  buildAgentRows,
  hasDetectedRows,
} from "../../src/tui/AgentPickerModal";
import { AGENT_REGISTRY, AGENT_TARGETS, type AgentTarget } from "../../src/agents/integrator.js";

function createMockStdin(): any {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Renders the picker with an **injected** availability probe (REV-304), so the
 * assertions never depend on the host's real PATH, and returns a `finish()` that
 * unmounts *before* reading — this harness flushes Ink's frame on unmount.
 */
async function renderPicker(props: {
  currentAgentId: string;
  available?: AgentTarget[];
  onSelect?: (id: string, scope: string) => void;
  onCancel?: () => void;
  detectThrows?: boolean;
}): Promise<{ stdin: any; finish: () => string }> {
  const stdout = new PassThrough() as any;
  stdout.columns = 100;
  stdout.rows = 30;
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const available = props.available ?? [];
  const stdin = createMockStdin();
  const instance = render(
    React.createElement(AgentPickerModal, {
      currentAgentId: props.currentAgentId,
      onSelect: (props.onSelect ?? vi.fn()) as any,
      onCancel: props.onCancel ?? vi.fn(),
      detect: async () => {
        if (props.detectThrows) throw new Error("PATH probe failed");
        return AGENT_TARGETS.map((id) => ({
          id,
          available: available.includes(id),
          path: available.includes(id) ? `/usr/local/bin/${id}` : undefined,
        }));
      },
    }),
    { stdout, stdin, patchConsole: false },
  );
  await tick(120);
  return { stdin, finish: () => (instance.unmount(), output) };
}

describe("AgentPickerModal (REQ-33 / ADR-32)", () => {
  it("lists only the detected runtimes, sorted alphabetically", () => {
    const rows = buildAgentRows([
      { id: "pi", available: true, path: "/usr/local/bin/pi" },
      { id: "claude", available: true, path: "/usr/local/bin/claude" },
      { id: "opencode", available: false },
      { id: "codex", available: true, path: "/usr/local/bin/codex" },
    ]);

    // Alphabetical, never registry order: the registry is a historical list and
    // reading it as a preference is what pinned every launch to claude.
    expect(rows.map((row) => row.id)).toEqual(["claude", "codex", "pi"]);
    expect(rows.every((row) => row.available)).toBe(true);
    expect(rows.find((row) => row.id === "pi")?.label).toBe(AGENT_REGISTRY.pi?.label ?? "pi");
    expect(rows.find((row) => row.id === "pi")?.path).toBe("/usr/local/bin/pi");
  });

  it("is case-insensitive about nothing and stable for equal ids", () => {
    const rows = buildAgentRows([
      { id: "qwen", available: true },
      { id: "agy", available: true },
      { id: "codex", available: true },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["agy", "codex", "qwen"]);
  });

  it("falls back to every known target when detection finds nothing", () => {
    const rows = buildAgentRows([]);
    expect(rows.map((row) => row.id)).toEqual([...AGENT_TARGETS].sort());
    expect(rows.every((row) => !row.available)).toBe(true);
    expect(hasDetectedRows(rows)).toBe(false);
  });

  it("renders only what the machine has, alphabetically, and marks the active one", async () => {
    const picker = await renderPicker({
      currentAgentId: "claude",
      available: ["pi", "claude"],
    });
    const output = picker.finish();

    expect(output).toContain("SELECT AGENT RUNTIME");
    expect(output.indexOf("(claude)")).toBeLessThan(output.indexOf("(pi)"));
    // Nothing invented: a runtime that is not installed is not in the list.
    expect(output).not.toContain("(codex)");
    expect(output).not.toContain("not installed");
    // The active runtime, its resolved path and the persistence keys are visible.
    expect(output).toContain("● active");
    expect(output).toContain("/usr/local/bin/claude");
    expect(output).toContain("p and g keep the runtime for the next launch");
    expect(output).toContain("Muninn memory is project-scoped");
  });

  it("says so when nothing is detected instead of showing an empty box", async () => {
    const picker = await renderPicker({ currentAgentId: "opencode", available: [] });
    const output = picker.finish();
    expect(output).toContain("No agent CLI detected on PATH");
    expect(output).toContain("not installed");
  });

  it("persists with p (project) and g (global), and switches for the session on Enter", async () => {
    const onSelect = vi.fn();
    const picker = await renderPicker({
      // Not in the detected list, so the highlight stays on the first row
      // (claude) instead of preselection moving it to the active runtime.
      currentAgentId: "opencode",
      available: ["claude", "pi"],
      onSelect,
    });

    picker.stdin.write("p");
    await tick();
    expect(onSelect).toHaveBeenLastCalledWith("claude", "project");

    picker.stdin.write("g");
    await tick();
    expect(onSelect).toHaveBeenLastCalledWith("claude", "global");

    picker.stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenLastCalledWith("claude", "session");
    picker.finish();
  });

  it("fails closed when the availability probe rejects: the full list reads unavailable", async () => {
    const onSelect = vi.fn();
    const picker = await renderPicker({
      currentAgentId: "opencode",
      onSelect,
      detectThrows: true,
    });

    // Detection failure is not fatal: the list still renders, and no entry is
    // claimed available. Enter selects the first row rather than exploding.
    picker.stdin.write("\r");
    await tick(30);
    const output = picker.finish();
    expect(output).toContain("SELECT AGENT RUNTIME");
    expect(output).toContain("not installed");
    expect(output).not.toContain("Detecting installed agent CLIs");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][1]).toBe("session");
  });

  it("cancels on Esc", async () => {
    const onCancel = vi.fn();
    const picker = await renderPicker({ currentAgentId: "opencode", onCancel });

    picker.stdin.write("\u001B");
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    picker.finish();
  });

  it("clamps navigation at the top instead of selecting out of bounds", async () => {
    const onSelect = vi.fn();
    const picker = await renderPicker({
      currentAgentId: "opencode",
      available: ["claude", "pi"],
      onSelect,
    });

    for (let i = 0; i < 6; i += 1) {
      picker.stdin.write("\u001B[A");
      await tick(15);
    }
    picker.stdin.write("\r");
    await tick(80);
    picker.finish();

    expect(onSelect).toHaveBeenCalledTimes(1);
    // First row of the alphabetical list, not of the registry.
    expect(onSelect.mock.calls[0][0]).toBe("claude");
  });
});
