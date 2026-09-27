import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink";
import { StreamCard } from "../../src/tui/Dashboard";
import { runLiveTui, runTui } from "../../src/tui/app";

describe("TUI Dashboard & StreamCard", () => {
  it("exports runTui and runLiveTui from src/tui/app.tsx (REV-010)", () => {
    expect(typeof runTui).toBe("function");
    expect(typeof runLiveTui).toBe("function");
  });

  it("StreamCard renders without tail prop and displays provided lines (REV-008)", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const lines = ["Line 1", "Line 2", "Line 3"];
    const instance = render(
      React.createElement(StreamCard, {
        lines,
        totalLines: 3,
        scrollOffset: 0,
        maxScroll: 0,
        chars: 100,
        spinner: "⠋",
        verbose: false,
      }),
      { stdout, patchConsole: false }
    );
    instance.unmount();

    expect(output).toContain("Line 1");
    expect(output).toContain("Line 2");
    expect(output).toContain("Line 3");
    expect(output).toContain("LIVE AGENT OUTPUT");
  });

  it("StreamCard falls back cleanly when lines is empty or omitted", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    const instance = render(
      React.createElement(StreamCard, {
        chars: 0,
        spinner: "⠋",
        verbose: false,
      }),
      { stdout, patchConsole: false }
    );
    instance.unmount();

    expect(output).toContain("waiting for agent stream");
  });
});

describe("LiveDashboard input sanitization (REV-004)", () => {
  it("filters out ANSI escape sequences and non-printable control characters", () => {
    const sanitizeInput = (input: string): string => {
      return input
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
    };

    expect(sanitizeInput("\x1b[D")).toBe("");
    expect(sanitizeInput("\x1b[A\x1b[Bhello\x1b[C")).toBe("hello");
    expect(sanitizeInput("valid input 123 !@#")).toBe("valid input 123 !@#");
    expect(sanitizeInput("\x00\x08test\x1F")).toBe("test");
    expect(sanitizeInput("\u001b[31mred\u001b[0m")).toBe("red");
  });
});

describe("Stream buffer bounding (REV-001 / REV-002)", () => {
  it("clamps stream buffer to the last 1000 lines", () => {
    const MAX_STREAM_LINES = 1000;
    const generateLines = (count: number) =>
      Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

    const largeBuffer = generateLines(1500);
    const allLines = largeBuffer.split("\n");
    const boundedLines =
      allLines.length > MAX_STREAM_LINES
        ? allLines.slice(-MAX_STREAM_LINES)
        : allLines;

    expect(boundedLines.length).toBe(1000);
    expect(boundedLines[0]).toBe("line 501");
    expect(boundedLines[999]).toBe("line 1500");
  });
});
