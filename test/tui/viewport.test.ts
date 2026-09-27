import React from "react";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { render, Text } from "ink";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  getTerminalSize,
  useTerminalSize,
} from "../../src/tui/useTerminalSize";

describe("useTerminalSize & getTerminalSize", () => {
  const origRows = process.stdout.rows;
  const origColumns = process.stdout.columns;

  beforeEach(() => {
    Object.defineProperty(process.stdout, "rows", {
      value: 30,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: 100,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "rows", {
      value: origRows,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: origColumns,
      configurable: true,
      writable: true,
    });
  });

  it("reads process.stdout rows and columns when available", () => {
    const size = getTerminalSize();
    expect(size.rows).toBe(30);
    expect(size.columns).toBe(100);
  });

  it("falls back to DEFAULT_ROWS and DEFAULT_COLUMNS when values are missing or zero", () => {
    Object.defineProperty(process.stdout, "rows", {
      value: 0,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: 0,
      configurable: true,
      writable: true,
    });

    const size = getTerminalSize();
    expect(size.rows).toBe(DEFAULT_ROWS);
    expect(size.columns).toBe(DEFAULT_COLUMNS);
    expect(size.rows).toBe(24);
    expect(size.columns).toBe(80);
  });

  it("falls back to defaults when process.stdout rows/columns are undefined", () => {
    Object.defineProperty(process.stdout, "rows", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const size = getTerminalSize();
    expect(size.rows).toBe(24);
    expect(size.columns).toBe(80);
  });

  it("updates terminal size when resize event is triggered and cleans up on unmount", async () => {
    let capturedSize = { rows: 0, columns: 0 };
    function TestComponent() {
      const size = useTerminalSize();
      capturedSize = size;
      return React.createElement(Text, null, `${size.columns}x${size.rows}`);
    }

    const beforeRender = process.stdout.listenerCount("resize");

    const instance = render(React.createElement(TestComponent, null), {
      patchConsole: false,
      interactive: true,
    });
    // Ink + useTerminalSize each attach a resize listener (+2)
    expect(process.stdout.listenerCount("resize")).toBe(beforeRender + 2);
    expect(capturedSize.rows).toBe(30);
    expect(capturedSize.columns).toBe(100);

    // Simulate terminal window resize
    Object.defineProperty(process.stdout, "rows", {
      value: 45,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: 120,
      configurable: true,
      writable: true,
    });

    process.stdout.emit("resize");

    // Wait a tick for React state update
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedSize.rows).toBe(45);
    expect(capturedSize.columns).toBe(120);

    // Unmount and verify listener cleanup
    instance.unmount();
    expect(process.stdout.listenerCount("resize")).toBe(beforeRender);
  });
});
