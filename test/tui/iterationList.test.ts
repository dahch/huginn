import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "./inkRender";
import { Dashboard } from "../../src/tui/Dashboard";
import { IterationListModal } from "../../src/tui/IterationListModal";
import {
  ITERATION_LIST_CHROME,
  iterationListWindow,
  iterationRowLabel,
} from "../../src/tui/iterationList";
import { events } from "../../src/engine/engineEvents";
import type { CycleEngine } from "../../src/engine/cycle";
import type { RunConfig } from "../../src/config";

const TITLES = Array.from({ length: 9 }, (_, i) => `Iteration ${i + 1} title`);

function mockStdin() {
  const stdin = new PassThrough() as any;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

const engineOf = (requestAbort = () => {}) =>
  ({
    getState: () => ({ currentIteration: 4, currentPhase: "EXECUTE" }),
    runtime: {
      id: "commandcode",
      getMcpStatus: async () => ({ servers: [], totalTools: 0, healthy: true }),
    },
    resolveDecision: () => {},
    pause: () => {},
    resume: () => {},
    requestAbort,
  }) as unknown as CycleEngine;

const configOf = () =>
  ({
    projectPath: "/tmp/p",
    planPath: "/tmp/p/plan.md",
    specPath: "/tmp/p/spec.md",
    adrPath: "/tmp/p/adr.md",
    thinker: "a/b",
    executor: "c/d",
    mode: "auto",
    permissions: "auto",
    maxRetries: 0,
    tui: false,
    port: 0,
    serverTimeoutMs: 1000,
    phaseTimeoutMs: 0,
    ignorePlanChanges: false,
    sandbox: false,
  }) as unknown as RunConfig;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("iteration list", () => {
  it("pays the modal chrome and centres the window on the focused iteration", () => {
    const window = iterationListWindow(TITLES.length, 4, 10);
    expect(window.budget).toBe(10 - ITERATION_LIST_CHROME);
    // The budget must pay the title, the subtitle and the footer, or the frame
    // overflows and Ink squeezes the title out of its own border.
    expect(window.length + ITERATION_LIST_CHROME).toBeLessThanOrEqual(10);
    expect(window.length).toBe(window.budget);
    // Focused iteration is inside the window, and the window clamps at the end.
    expect(window.offset).toBeLessThanOrEqual(4);
    expect(window.end).toBeGreaterThan(4);
    expect(window.end).toBeLessThanOrEqual(TITLES.length);
  });

  it("marks only the running iteration, and says nothing about the others", () => {
    expect(iterationRowLabel(0, "First", 1).startsWith(">")).toBe(true);
    expect(iterationRowLabel(1, "Second", 1).startsWith(" ")).toBe(true);
    expect(iterationRowLabel(0, "First", 1)).toContain("1. First");
  });

  it("renders every title the budget allows and names what is hidden", () => {
    const stdout = new PassThrough() as any;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const instance = render(
      React.createElement(IterationListModal, {
        titles: Array.from({ length: 20 }, (_, i) => `Task ${i + 1}`),
        current: 3,
        focus: 2,
        maxRows: 10,
      }),
      { stdout, patchConsole: false },
    );
    instance.unmount();
    expect(output).toContain("ITERATIONS");
    expect(output).toContain("Task 1");
    expect(output).toContain("of 20");
    expect(output).toContain("below");
    expect(output).not.toContain("Task 20");
  });
});

describe("the run dashboard's iteration list", () => {
  async function mount(requestAbort = () => {}) {
    const stdout = new PassThrough() as any;
    stdout.columns = 110;
    stdout.rows = 30;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const stdin = mockStdin();
    const instance = render(
      React.createElement(Dashboard, {
        engine: engineOf(requestAbort),
        cfg: configOf(),
        autoExit: false,
        iterations: TITLES,
      }),
      { stdout, stdin, patchConsole: false },
    );
    await sleep(80);
    return { instance, stdin, output: () => output };
  }

  it("is closed by default", async () => {
    const { instance, output } = await mount();
    instance.unmount();
    await sleep(50);
    expect(output()).not.toContain("ITERATIONS");
  });

  it("opens with i and shows the plan's titles", async () => {
    const { instance, stdin, output } = await mount();
    stdin.write("i");
    await sleep(120);
    instance.unmount();
    await sleep(50);
    expect(output()).toContain("ITERATIONS");
    expect(output()).toContain("Iteration 4 title");
  });

  it("closes with Esc instead of aborting the run", async () => {
    const requestAbort = vi.fn();
    const { instance, stdin } = await mount(requestAbort);
    stdin.write("i");
    await sleep(120);
    stdin.write("\u001b"); // Esc: closes the list
    await sleep(120);
    instance.unmount();
    await sleep(50);
    expect(requestAbort).not.toHaveBeenCalled();
  });

  it("does nothing on i when the plan has no titles", async () => {
    const stdout = new PassThrough() as any;
    stdout.columns = 110;
    stdout.rows = 30;
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const instance = render(
      React.createElement(Dashboard, { engine: engineOf(), cfg: configOf(), autoExit: false }),
      { stdout, stdin: mockStdin(), patchConsole: false },
    );
    await sleep(80);
    instance.unmount();
    await sleep(50);
    expect(output).not.toContain("ITERATIONS");
  });
});
