import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
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
