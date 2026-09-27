import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  patchConsole,
  unpatchConsole,
  setupTuiEnvironment,
} from "../../src/tui/render";
import { events } from "../../src/engine/engineEvents";

describe("TUI Render Engine, Alternate Screen Buffer & Exit Safety", () => {
  let stdoutWrites: string[] = [];
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    stdoutWrites = [];
    process.stdout.write = ((chunk: any) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as any;
  });

  afterEach(() => {
    unpatchConsole();
    process.stdout.write = originalWrite;
    events.clear();
  });

  it("exports correct ANSI escape sequences for alternate buffer and cursor restoration", () => {
    expect(ENTER_ALT_SCREEN).toBe("\x1b[?1049h\x1b[H");
    expect(EXIT_ALT_SCREEN).toBe("\x1b[?1049l\x1b[?25h");
  });

  it("patches console.log, console.warn, and console.error into engineEvents log", () => {
    patchConsole();

    const captured: Array<{ level: string; message: string }> = [];
    const off = events.on("log", (e) => {
      captured.push({ level: e.level, message: e.message });
    });

    console.log("info message", { a: 1 });
    console.warn("warning message %s", "danger");
    console.error("error message occurred");

    off();
    unpatchConsole();

    expect(captured.length).toBe(3);
    expect(captured[0].level).toBe("info");
    expect(captured[0].message).toContain("info message");
    expect(captured[0].message).toContain("{ a: 1 }");

    expect(captured[1].level).toBe("warn");
    expect(captured[1].message).toBe("warning message danger");

    expect(captured[2].level).toBe("error");
    expect(captured[2].message).toBe("error message occurred");
  });

  it("restores original console methods upon unpatchConsole", () => {
    const origLog = console.log;
    patchConsole();
    expect(console.log).not.toBe(origLog);

    let emitted = false;
    const off = events.on("log", () => {
      emitted = true;
    });

    unpatchConsole();
    expect(console.log).toBe(origLog);

    console.log("after unpatch");
    off();
    expect(emitted).toBe(false);
  });

  it("prevents re-entrant infinite loops when event listeners log during console intercept", () => {
    patchConsole();

    let recursionAttempts = 0;
    const off = events.on("log", (e) => {
      if (recursionAttempts < 3) {
        recursionAttempts++;
        // Logging inside listener must not recursively trigger infinite emit
        console.log(`nested-log-${recursionAttempts}`);
      }
    });

    expect(() => {
      console.log("trigger");
    }).not.toThrow();

    off();
    unpatchConsole();
  });

  it("setupTuiEnvironment enters alternate buffer, patches console, and restores on cleanup", () => {
    const origLog = console.log;
    const cleanup = setupTuiEnvironment();

    expect(stdoutWrites).toContain(ENTER_ALT_SCREEN);
    expect(console.log).not.toBe(origLog);

    cleanup();

    expect(stdoutWrites).toContain(EXIT_ALT_SCREEN);
    expect(console.log).toBe(origLog);

    // Idempotent cleanup should not duplicate exit write
    const countBefore = stdoutWrites.filter((w) => w === EXIT_ALT_SCREEN).length;
    cleanup();
    const countAfter = stdoutWrites.filter((w) => w === EXIT_ALT_SCREEN).length;
    expect(countBefore).toBe(countAfter);
  });

  it("triggers exit alternate buffer write via process exit listener", () => {
    const cleanup = setupTuiEnvironment();
    expect(stdoutWrites).toContain(ENTER_ALT_SCREEN);

    // Simulate node/bun process 'exit' event
    process.emit("exit", 0);

    expect(stdoutWrites).toContain(EXIT_ALT_SCREEN);
    cleanup();
  });

  it("triggers exit alternate buffer write via SIGINT signal listener", () => {
    const cleanup = setupTuiEnvironment();
    expect(stdoutWrites).toContain(ENTER_ALT_SCREEN);

    // Simulate SIGINT
    process.emit("SIGINT", "SIGINT");

    expect(stdoutWrites).toContain(EXIT_ALT_SCREEN);
    cleanup();
  });

  it("triggers exit alternate buffer write via SIGTERM signal listener", () => {
    const cleanup = setupTuiEnvironment();
    expect(stdoutWrites).toContain(ENTER_ALT_SCREEN);

    // Simulate SIGTERM
    process.emit("SIGTERM", "SIGTERM");

    expect(stdoutWrites).toContain(EXIT_ALT_SCREEN);
    cleanup();
  });

  it("triggers exit alternate buffer write via uncaughtException listener", () => {
    const cleanup = setupTuiEnvironment();
    expect(stdoutWrites).toContain(ENTER_ALT_SCREEN);

    // Simulate uncaughtException
    process.emit("uncaughtException", new Error("simulated crash"));

    expect(stdoutWrites).toContain(EXIT_ALT_SCREEN);
    cleanup();
  });
});
