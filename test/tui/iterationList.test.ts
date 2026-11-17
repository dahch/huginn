import React from "react";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const configOf = (planPath = "/tmp/p/plan.md") =>
  ({
    projectPath: "/tmp/p",
    planPath,
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

  it("marks the browsed iteration in its own column, never overwriting the running one", () => {
    expect(iterationRowLabel(3, "Fourth", 4)).toBe(">   4. Fourth");
    expect(iterationRowLabel(3, "Fourth", 4, true)).toBe(">›  4. Fourth");
    // Browsing iteration 2 while iteration 4 runs: both facts stay visible.
    expect(iterationRowLabel(1, "Second", 4, true)).toBe(" ›  2. Second");
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
  async function mount(
    requestAbort = () => {},
    options: { iterations?: readonly string[]; planPath?: string } = {},
  ) {
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
        cfg: configOf(options.planPath),
        autoExit: false,
        iterations: options.iterations ?? TITLES,
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

  it("falls back to the plan on disk when the caller carries no titles (live handoff)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "huginn-iter-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      "# Plan: demo\n\n## Iteration 1 — First stored title\n\nmodules: .\n\n## Iteration 2 — Second stored title\n\nmodules: .\n",
    );
    const { instance, stdin, output } = await mount(undefined, { iterations: [], planPath });
    stdin.write("i");
    await sleep(120);
    instance.unmount();
    await sleep(50);
    expect(output()).toContain("ITERATIONS");
    expect(output()).toContain("First stored title");
  });

  it("browses the focused iteration's goal with the arrows when every title fits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "huginn-iter-"));
    const planPath = join(dir, "plan.md");
    writeFileSync(
      planPath,
      [
        "# Plan: demo",
        "",
        "## Iteration 1 — First",
        "",
        "modules: .",
        "",
        "**Goal:** Build the scaffold",
        "",
        "## Iteration 2 — Second",
        "",
        "modules: .",
        "",
        "**Goal:** Add the editor",
        "",
      ].join("\n"),
    );
    const { instance, stdin, output } = await mount(undefined, { iterations: [], planPath });

    stdin.write("i");
    await sleep(120);
    // The arrows used to move an invisible window on a list that fit entirely.
    stdin.write("\u001b[A");
    await sleep(120);
    instance.unmount();
    await sleep(50);
    const rendered = output();

    // The last frame is the one Ink leaves on screen: the Up arrow browsed back to
    // iteration 1, so its goal owns the subtitle and its row carries the cursor.
    expect(rendered).toContain("Build the scaffold");
    expect(rendered).toContain("›  1. First");
    expect(rendered).not.toContain("Add the editor");
  });

  it("logs why i does nothing when there is no plan to read", async () => {
    const emit = vi.spyOn(events, "emit");
    const { instance, stdin } = await mount(undefined, {
      iterations: [],
      planPath: "/nonexistent/huginn/plan.md",
    });
    stdin.write("i");
    await sleep(120);
    instance.unmount();
    await sleep(50);
    const explained = emit.mock.calls.some(
      ([name, payload]) =>
        name === "log" && String((payload as { message?: string }).message ?? "").includes("no iteration titles"),
    );
    expect(explained).toBe(true);
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
