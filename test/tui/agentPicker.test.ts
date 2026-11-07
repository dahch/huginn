import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "./inkRender";
import {
  AgentPickerModal,
  agentPickerHint,
  agentPickerNote,
  buildAgentRows,
  hasDetectedRows,
  resolveAgentScopes,
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
  scopes?: Array<"session" | "project" | "global">;
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
      scopes: props.scopes,
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
    expect(output).toContain("Enter saves it for this project");
    expect(output).toContain("Muninn memory is project-scoped");
  });

  it("says so when nothing is detected instead of showing an empty box", async () => {
    const picker = await renderPicker({ currentAgentId: "opencode", available: [] });
    const output = picker.finish();
    expect(output).toContain("No agent CLI detected on PATH");
    expect(output).toContain("not installed");
  });

  it("saves for the project on Enter, for the session on s, and globally on g", async () => {
    const onSelect = vi.fn();
    const picker = await renderPicker({
      // Not in the detected list, so the highlight stays on the first row
      // (claude) instead of preselection moving it to the active runtime.
      currentAgentId: "opencode",
      available: ["claude", "pi"],
      onSelect,
    });

    picker.stdin.write("s");
    await tick();
    expect(onSelect).toHaveBeenLastCalledWith("claude", "session");

    picker.stdin.write("g");
    await tick();
    expect(onSelect).toHaveBeenLastCalledWith("claude", "global");

    picker.stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenLastCalledWith("claude", "project");
    picker.finish();
  });

  it("prints every scope key and what each one does", async () => {
    const picker = await renderPicker({ currentAgentId: "opencode", available: ["claude"] });
    const output = picker.finish();
    // No action is left for the user to guess: the keys and their consequence
    // are on screen, not in the docs.
    expect(output).toContain("Enter project");
    expect(output).toContain("s session");
    expect(output).toContain("g global");
    expect(output).toContain("Enter saves it for this project");
    expect(output).toContain("s only until you quit");
    expect(output).toContain("g for every project");
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
    expect(onSelect.mock.calls[0][1]).toBe("project");
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

/**
 * `huginn init` always writes `<project>/.huginn/config.json`, so it mounts the
 * picker with a single scope. Offering `s`/`g` there would promise a write the
 * wizard never performs — these tests pin the narrowed keyboard, not just the
 * narrowed hint.
 */
describe("AgentPickerModal scoped host (init)", () => {
  it("defaults to every scope and keeps the console hint untouched", () => {
    expect(resolveAgentScopes(undefined)).toEqual(["session", "project", "global"]);
    expect(agentPickerHint(resolveAgentScopes(undefined))).toBe(
      "↑/↓ or k/j move · Enter project · s session · g global · Esc cancel",
    );
    expect(agentPickerNote(resolveAgentScopes(undefined))).toEqual([
      "Enter saves it for this project · s only until you quit · g for every project.",
      "Muninn memory is project-scoped and unaffected.",
    ]);
  });

  it("drops unknown scopes and de-duplicates instead of rendering an empty picker", () => {
    expect(resolveAgentScopes(["project", "project"] as any)).toEqual(["project"]);
    expect(resolveAgentScopes(["nonsense"] as any)).toEqual(["session", "project", "global"]);
  });

  it("narrows the footer and the note to the scope the host can persist", () => {
    const scopes = resolveAgentScopes(["project"]);
    expect(agentPickerHint(scopes)).toBe("↑/↓ or k/j move · Enter project · Esc cancel");
    expect(agentPickerHint(scopes)).not.toContain("s session");
    expect(agentPickerHint(scopes)).not.toContain("g global");
    expect(agentPickerNote(scopes)).toEqual([
      "Enter saves it for this project.",
      "Muninn memory is project-scoped and unaffected.",
    ]);
  });

  it("saves for the project on Enter and ignores the scope keys it does not offer", async () => {
    const onSelect = vi.fn();
    const picker = await renderPicker({
      currentAgentId: "opencode",
      available: ["claude", "pi"],
      onSelect,
      scopes: ["project"],
    });

    picker.stdin.write("s");
    await tick(30);
    picker.stdin.write("g");
    await tick(30);
    expect(onSelect).not.toHaveBeenCalled();

    picker.stdin.write("\r");
    await tick(30);
    expect(onSelect).toHaveBeenLastCalledWith("claude", "project");
    picker.finish();
  });

  it("advertises only the keys it honours", async () => {
    const picker = await renderPicker({
      currentAgentId: "opencode",
      available: ["claude"],
      scopes: ["project"],
    });
    const output = picker.finish();
    expect(output).toContain("Enter project");
    expect(output).toContain("Esc cancel");
    expect(output).not.toContain("s session");
    expect(output).not.toContain("g global");
    expect(output).toContain("Enter saves it for this project.");
    expect(output).not.toContain("only until you quit");
  });

  it("still cancels on Esc when only one scope is offered", async () => {
    const onCancel = vi.fn();
    const picker = await renderPicker({
      currentAgentId: "opencode",
      available: ["claude"],
      onCancel,
      scopes: ["project"],
    });
    picker.stdin.write("\u001B");
    await tick(30);
    expect(onCancel).toHaveBeenCalledTimes(1);
    picker.finish();
  });
});
