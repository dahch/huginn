import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "../../src/cli.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function helpOutput(argv: string[]): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  });
  await main(argv);
  return lines.join("\n");
}

describe("per-subcommand --help", () => {
  it("prints setup's own usage instead of the global core", async () => {
    const out = await helpOutput(["setup", "--help"]);
    expect(out).toContain("huginn setup");
    expect(out).not.toContain("huginn memory —");
  });

  it("prints memory's own usage", async () => {
    const out = await helpOutput(["memory", "--help"]);
    expect(out).toContain("huginn memory — Persistent codebase memory");
    expect(out).toContain("decisions");
  });

  it("prints runtime's own usage", async () => {
    const out = await helpOutput(["runtime", "--help"]);
    expect(out).toContain("huginn runtime");
  });

  it("prints the run usage for `huginn run --help`", async () => {
    const out = await helpOutput(["run", "--help"]);
    expect(out).toContain("huginn run");
    expect(out).not.toContain("[huginn] fatal");
  });

  it("prints install's usage", async () => {
    const out = await helpOutput(["install", "--help"]);
    expect(out).toContain("huginn install");
  });

  it("still answers a bare --help with the command overview", async () => {
    const out = await helpOutput(["--help"]);
    expect(out).toContain("huginn");
  });
});
