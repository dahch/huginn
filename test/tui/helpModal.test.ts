import React from "react";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "./inkRender";
import { HelpModal, SLASH_COMMANDS, NAVIGATION_SHORTCUTS } from "../../src/tui/HelpModal";

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

describe("HelpModal Component", () => {
  it("renders active config banner and all slash commands", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const stdin = createMockStdin();
    const onClose = vi.fn();

    const instance = render(
      React.createElement(HelpModal, {
        runtimeName: "OpenCode CLI",
        thinker: "anthropic/claude-opus-4-5",
        executor: "opencode/gpt-5.1-codex",
        projectPath: "/path/to/project",
        onClose,
      }),
      { stdout, stdin, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 50));
    instance.unmount();

    expect(output).toContain("HUGINN LIVE CHEAT SHEET");
    expect(output).toContain("OpenCode CLI");
    expect(output).toContain("anthropic/claude-opus-4-5");
    expect(output).toContain("opencode/gpt-5.1-codex");
    expect(output).toContain("/path/to/project");

    for (const cmd of SLASH_COMMANDS) {
      expect(output).toContain(cmd.command);
    }

    for (const s of NAVIGATION_SHORTCUTS) {
      expect(output).toContain(s.key);
    }
  });

  it("stays open on any other key, so a scroll key cannot dismiss the sheet", async () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const stdin = createMockStdin();
    const onClose = vi.fn();
    const instance = render(
      React.createElement(HelpModal, {
        runtimeName: "Claude",
        thinker: "t",
        executor: "e",
        projectPath: "/p",
        onClose,
      }),
      { stdout, stdin, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 50));
    for (const key of ["x", "\u001B[B", "\u001B[A", "\t"]) {
      stdin.write(key);
      await new Promise((r) => setTimeout(r, 20));
    }
    instance.unmount();
    expect(onClose).not.toHaveBeenCalled();
    expect(output).toContain("HUGINN LIVE CHEAT SHEET");
  });

  it("calls onClose when escape, q, or enter is pressed", async () => {
    const stdin1 = createMockStdin();
    const onClose1 = vi.fn();
    const instance1 = render(
      React.createElement(HelpModal, {
        runtimeName: "Claude",
        thinker: "t",
        executor: "e",
        projectPath: "/p",
        onClose: onClose1,
      }),
      { stdout: new PassThrough(), stdin: stdin1, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin1.write("q");
    await new Promise((r) => setTimeout(r, 30));
    instance1.unmount();
    expect(onClose1).toHaveBeenCalledTimes(1);

    const stdin2 = createMockStdin();
    const onClose2 = vi.fn();
    const instance2 = render(
      React.createElement(HelpModal, {
        runtimeName: "Claude",
        thinker: "t",
        executor: "e",
        projectPath: "/p",
        onClose: onClose2,
      }),
      { stdout: new PassThrough(), stdin: stdin2, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin2.write("\u001B");
    await new Promise((r) => setTimeout(r, 30));
    instance2.unmount();
    expect(onClose2).toHaveBeenCalledTimes(1);

    const stdin3 = createMockStdin();
    const onClose3 = vi.fn();
    const instance3 = render(
      React.createElement(HelpModal, {
        runtimeName: "Claude",
        thinker: "t",
        executor: "e",
        projectPath: "/p",
        onClose: onClose3,
      }),
      { stdout: new PassThrough(), stdin: stdin3, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin3.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    instance3.unmount();
    expect(onClose3).toHaveBeenCalledTimes(1);
  });
});

// ── REQ-72 drift guard ───────────────────────────────────────────────────────
// The transcript-navigation keys are only discoverable if they are advertised:
// the cheat sheet is what `/help` paints, and the README table is what a reader
// who never opens `/help` reads. Both must name the same three keys and promise
// the same behaviour, or a key that works becomes a key nobody knows about.

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/** The README's keyboard-shortcut table, from its bold heading to the flag list. */
function shortcutsTable(readme: string): string {
  const start = readme.indexOf("**Live console keyboard shortcuts**");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = readme.indexOf("\n\nFlags:", start);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end);
}

describe("transcript navigation shortcuts are documented (REQ-72 / AC-72.6)", () => {
  const byKey = new Map(NAVIGATION_SHORTCUTS.map((s) => [s.key, s.description]));
  const rowCells = shortcutsTable(README)
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  /** The README row whose key cell is exactly `key` (cell 0 is the leading `|`). */
  const rowFor = (key: string): string[] | undefined => rowCells.find((cells) => cells[1] === key);

  it("lists g / G, Ctrl+F and y in the cheat sheet", () => {
    expect([...byKey.keys()]).toEqual(
      expect.arrayContaining(["g / G (card)", "Ctrl+F", "y (chat)"]),
    );
  });

  it("describes each new key's behaviour instead of only naming it", () => {
    expect(byKey.get("g / G (card)")).toContain("start / end");
    expect(byKey.get("g / G (card)")).toContain("composer");
    expect(byKey.get("Ctrl+F")).toContain("Search the conversation");
    expect(byKey.get("Ctrl+F")).toContain("Esc restores your draft");
    expect(byKey.get("y (chat)")).toContain("OSC 52");
    expect(byKey.get("y (chat)")).toContain("some terminals ignore it");
  });

  it("has a README row for g / G, Ctrl+F and y", () => {
    expect(rowFor("`g` / `G`")?.[2]).toBe("conversation / stream");
    expect(rowFor("`Ctrl+F`")?.[2]).toBe("any");
    expect(rowFor("`y`")?.[2]).toBe("conversation");
  });

  it("keeps the README rows promising what the keys actually do", () => {
    expect(rowFor("`g` / `G`")?.[3]).toContain("start / end");
    expect(rowFor("`g` / `G`")?.[3]).toContain("plain letters");
    expect(rowFor("`Ctrl+F`")?.[3]).toContain("find ❯ ");
    expect(rowFor("`Ctrl+F`")?.[3]).toContain("warning border");
    expect(rowFor("`Ctrl+F`")?.[3]).toContain("restores your draft");
    expect(rowFor("`y`")?.[3]).toContain("OSC 52");
    expect(rowFor("`y`")?.[3]).toContain("ignore");
  });
});
