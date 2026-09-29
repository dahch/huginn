import { describe, it, expect } from "bun:test";
import { promptLine, promptYesNo } from "./prompt";

describe("promptLine", () => {
  it("returns the fallback when non-interactive (CI)", async () => {
    const prevCi = process.env.CI;
    process.env.CI = "true";
    try {
      await expect(promptLine("Name?", "default")).resolves.toBe("default");
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
    }
  });

  it("returns the fallback when the stdin stream is not a TTY", async () => {
    const io = {
      env: {},
      stdin: { isTTY: false } as unknown as NodeJS.ReadableStream & { isTTY?: boolean },
      stdout: { isTTY: true } as unknown as NodeJS.WritableStream & { isTTY?: boolean },
    };
    await expect(promptLine("Name?", "default", io)).resolves.toBe("default");
  });
});

describe("promptYesNo", () => {
  it("returns the fallback when non-interactive (CI)", async () => {
    const prevCi = process.env.CI;
    process.env.CI = "true";
    try {
      await expect(promptYesNo("Install?", true)).resolves.toBe(true);
      await expect(promptYesNo("Install?")).resolves.toBe(false);
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
    }
  });
});
