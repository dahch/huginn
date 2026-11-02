import React from "react";
import { PassThrough } from "node:stream";
import { Text } from "ink";
import { describe, expect, it, vi } from "vitest";
import { render } from "./inkRender";

/**
 * `inkRender` is the test/render boundary: Ink's options are typed against
 * full Node terminals, while the TUI suite injects plain `PassThrough`
 * doubles. These tests pin the runtime side of that loosened contract — the
 * output goes to the injected stream, a minimal stdin is enough, and the
 * returned instance is a real Ink instance.
 */

function createStdout(columns: number, rows: number): PassThrough & {
  columns: number;
  rows: number;
} {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = columns;
  stdout.rows = rows;
  return stdout;
}

function createStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: () => PassThrough;
  ref: () => PassThrough;
  unref: () => PassThrough;
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => PassThrough;
    ref: () => PassThrough;
    unref: () => PassThrough;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

function capture(stdout: PassThrough): () => string {
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => output;
}

describe("inkRender test seam", () => {
  it("writes the frame to the injected stdout, not process.stdout", async () => {
    const stdout = createStdout(40, 8);
    const read = capture(stdout);
    const processWrite = vi.spyOn(process.stdout, "write");

    const instance = render(React.createElement(Text, null, "hello seam"), {
      stdout,
      stdin: createStdin(),
      patchConsole: false,
    });
    instance.unmount();
    await new Promise((resolve) => setImmediate(resolve));

    processWrite.mockRestore();
    expect(read()).toContain("hello seam");
    expect(processWrite).not.toHaveBeenCalled();
  });

  it("accepts a plain PassThrough as stdin at the test boundary", async () => {
    const stdout = createStdout(40, 8);
    const read = capture(stdout);
    // No isTTY, no setRawMode: exactly the kind of double the suite passes.
    const stdin = new PassThrough();

    const instance = render(React.createElement(Text, null, "no tty required"), {
      stdout,
      stdin,
      patchConsole: false,
    });
    instance.unmount();
    await new Promise((resolve) => setImmediate(resolve));

    expect(read()).toContain("no tty required");
  });

  it("returns an Ink instance whose unmount can be called more than once", async () => {
    const stdout = createStdout(40, 8);

    const instance = render(React.createElement(Text, null, "idempotent"), {
      stdout,
      stdin: createStdin(),
      patchConsole: false,
    });
    expect(typeof instance.unmount).toBe("function");
    expect(() => {
      instance.unmount();
      instance.unmount();
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
