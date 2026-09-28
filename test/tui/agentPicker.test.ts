import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { AgentPickerModal, buildAgentRows } from "../../src/tui/AgentPickerModal";
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
  onSelect?: (id: string) => void;
  onCancel?: () => void;
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
      detect: async () =>
        AGENT_TARGETS.map((id) => ({
          id,
          available: available.includes(id),
          path: available.includes(id) ? `/usr/local/bin/${id}` : undefined,
        })),
    }),
    { stdout, stdin, patchConsole: false },
  );
  await tick(120);
  return { stdin, finish: () => (instance.unmount(), output) };
}

describe("AgentPickerModal (REQ-33 / ADR-32)", () => {
  it("builds one row per supported target, keeping the registry order", () => {
    const rows = buildAgentRows([{ id: "agy", available: true, path: "/usr/local/bin/agy" }]);
    expect(rows.map((r) => r.id)).toEqual([...AGENT_TARGETS]);
    const agy = rows.find((r) => r.id === "agy")!;
    expect(agy.available).toBe(true);
    expect(agy.path).toBe("/usr/local/bin/agy");
    expect(agy.label).toBe(AGENT_REGISTRY.agy?.label ?? "agy");
    // Everything not detected is honestly unavailable, never assumed present.
    expect(rows.filter((r) => r.id !== "agy").every((r) => !r.available)).toBe(true);
  });

  it("marks availability per entry, the active runtime, and the highlighted path (AC-33.1)", async () => {
    // Anchor on the first target so the window starts at the top deterministically.
    const picker = await renderPicker({
      currentAgentId: AGENT_TARGETS[0]!,
      available: [AGENT_TARGETS[0]!, AGENT_TARGETS[1]!],
    });
    const output = picker.finish();

    expect(output).toContain("SELECT AGENT RUNTIME");
    for (const id of AGENT_TARGETS.slice(0, 4)) {
      expect(output).toContain(`(${id})`);
    }
    // Availability is explicit both ways, and the list says it is bounded.
    expect(output).toContain("✔");
    expect(output).toContain("not installed");
    expect(output).toContain("more below");
    // The active runtime is called out, its resolved path is shown, and switching
    // is safe for the shared brain.
    expect(output).toContain("● active");
    expect(output).toContain(`/usr/local/bin/${AGENT_TARGETS[0]}`);
    expect(output).toContain("Muninn memory is project-scoped");
  });

  it("switches on Enter and cancels on Esc", async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = await renderPicker({ currentAgentId: "opencode", onSelect, onCancel });

    picker.stdin.write("\r");
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(AGENT_TARGETS).toContain(onSelect.mock.calls[0][0]);

    picker.stdin.write("\u001B");
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    picker.finish();
  });

  it("clamps navigation at the top instead of selecting out of bounds", async () => {
    const onSelect = vi.fn();
    const picker = await renderPicker({ currentAgentId: "opencode", onSelect });

    for (let i = 0; i < AGENT_TARGETS.length + 3; i += 1) {
      picker.stdin.write("\u001B[A");
      await tick(15);
    }
    picker.stdin.write("\r");
    await tick(80);
    picker.finish();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(AGENT_TARGETS[0]);
  });
});
