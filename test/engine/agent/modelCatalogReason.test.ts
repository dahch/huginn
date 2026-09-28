import { afterAll, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { GenericSubprocessRuntimeAdapter } from "../../../src/engine/agent/adapters/generic.js";
import { OpencodeRuntimeAdapter } from "../../../src/engine/agent/adapters/opencode.js";
import type { ModelInfo } from "../../../src/engine/agent/types.js";

const tempDirs: string[] = [];

function makeScript(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "huginn-catalog-reason-"));
  tempDirs.push(dir);
  const script = join(dir, name);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  return script;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function parseIdLines(stdout: string): ModelInfo[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id.split("/")[1] ?? id, provider: id.split("/")[0] }));
}

describe("REQ-27 · getModelCatalog never lets empty and failure look alike (AC-27.4, REV-002/REV-010)", () => {
  it("returns [] with a reason when the listing command exits non-zero", async () => {
    const script = makeScript("failing.sh", "echo 'catalog service unavailable' >&2\nexit 3");
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "omp",
      name: "Oh My Pi",
      command: "omp",
      modelListCommand: { command: script, args: ["models"], parse: parseIdLines },
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toContain("exited with code 3");
    expect(catalog.reason).toContain("catalog service unavailable");

    // getAvailableModels stays the thin projection of the catalog.
    expect(await adapter.getAvailableModels()).toEqual([]);
  });

  it("returns [] with a sanitized reason when the binary is missing", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "agy",
      name: "Antigravity CLI (agy)",
      command: "agy",
      modelListCommand: {
        command: "__huginn_missing_listing_cli__",
        args: ["models"],
        parse: parseIdLines,
      },
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toMatch(/could not run/);
    expect(catalog.reason).not.toContain("\u001b");
  });

  it("returns [] with a timeout reason when the listing command hangs", async () => {
    const script = makeScript("hang.sh", "sleep 5");
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "omp",
      name: "Oh My Pi",
      command: "omp",
      modelListCommand: { command: script, args: ["models"], parse: parseIdLines, timeoutMs: 60 },
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toContain("timed out after 60ms");
  });

  it("returns [] with a reason when the listing command prints nothing", async () => {
    const script = makeScript("silent.sh", "exit 0");
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "omp",
      name: "Oh My Pi",
      command: "omp",
      modelListCommand: { command: script, args: ["models"], parse: parseIdLines },
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toContain("printed no output");
  });

  it("bounds and sanitizes the stderr excerpt carried as the reason", async () => {
    const script = makeScript(
      "noisy.sh",
      `printf '\\033[31mboom\\033[0m\\007 %s\\n' "$(printf 'x%.0s' $(seq 1 400))" >&2\nexit 2`,
    );
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "omp",
      name: "Oh My Pi",
      command: "omp",
      modelListCommand: { command: script, args: ["models"], parse: parseIdLines, timeoutMs: 5000 },
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([]);
    // ANSI/control sequences are stripped and the excerpt is bounded.
    expect(catalog.reason).not.toContain("\u001b");
    expect(catalog.reason).not.toContain("\u0007");
    expect(catalog.reason).toContain("boom");
    expect(catalog.reason?.length ?? 0).toBeLessThan(400);
  });

  it("distinguishes 'no listing mechanism' from a CLI failure", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "cursor",
      name: "Cursor",
      command: "cursor",
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog).toEqual({
      models: [],
      reason: "no model-listing command for this runtime",
    });
  });

  it("reports a reason when the parser throws or finds nothing", async () => {
    const throwing = new GenericSubprocessRuntimeAdapter({
      id: "omp",
      name: "Oh My Pi",
      command: "omp",
      modelListCommand: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('not-a-catalog')"],
        parse: () => {
          throw new Error("boom \u001b[31m");
        },
      },
    });
    const thrown = await throwing.getModelCatalog();
    expect(thrown.models).toEqual([]);
    expect(thrown.reason).toContain("could not parse model listing: boom");
    expect(thrown.reason).not.toContain("\u001b");

    const empty = new GenericSubprocessRuntimeAdapter({
      id: "omp",
      name: "Oh My Pi",
      command: "omp",
      modelListCommand: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('no models here\\n')"],
        parse: () => [],
      },
    });
    const parsedEmpty = await empty.getModelCatalog();
    expect(parsedEmpty.models).toEqual([]);
    expect(parsedEmpty.reason).toContain("listed no models");
  });

  it("carries no reason when discovery succeeds", async () => {
    const script = makeScript("ok.sh", `printf 'omp/live-model\\n'`);
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "omp",
      name: "Oh My Pi",
      command: "omp",
      modelListCommand: { command: script, args: ["models"], parse: parseIdLines },
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([{ id: "omp/live-model", name: "live-model", provider: "omp" }]);
    expect(catalog.reason).toBeUndefined();
  });
});

describe("REQ-27 · opencode catalog reason (AC-27.1, AC-27.2)", () => {
  it("sets a reason when the SDK throws and the CLI fallback fails too", async () => {
    const mockClient = {
      provider: {
        list: vi.fn().mockRejectedValue(new Error("daemon down")),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({
      client: mockClient,
      modelsCommand: "__huginn_missing_opencode__",
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toBeDefined();
    expect(catalog.reason).toMatch(/could not run|failed|daemon down/);
    // Both failed paths are named, so the user learns why opencode is empty.
    expect(catalog.reason).toContain("opencode SDK provider discovery failed: daemon down");
    expect(catalog.reason).toContain("could not run");
    expect(await adapter.getAvailableModels()).toEqual([]);
  });

  it("sets a reason when the CLI exits non-zero after an SDK failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "huginn-opencode-reason-"));
    tempDirs.push(dir);
    const failing = join(dir, "opencode");
    writeFileSync(failing, "#!/bin/sh\necho 'no such command: models' >&2\nexit 1\n");
    chmodSync(failing, 0o755);

    const mockClient = {
      provider: { list: vi.fn().mockRejectedValue(new Error("daemon down")) },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient, modelsCommand: failing });
    const catalog = await adapter.getModelCatalog();

    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toContain("exited with code 1");
    expect(catalog.reason).toContain("no such command: models");
  });

  it("carries no reason when the SDK reports a connected catalog", async () => {
    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          all: [{ id: "anthropic", name: "Anthropic", models: { "claude-sonnet-5": { name: "Claude Sonnet 5" } } }],
          default: {},
          connected: ["anthropic"],
        }),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({ client: mockClient });
    const catalog = await adapter.getModelCatalog();

    expect(catalog.models).toEqual([
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", description: undefined },
    ]);
    expect(catalog.reason).toBeUndefined();
  });

  it("names the CLI reason when the connected set is empty and the CLI fails", async () => {
    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({ all: [], default: {}, connected: [] }),
      },
    } as unknown as OpencodeClient;

    const adapter = new OpencodeRuntimeAdapter({
      client: mockClient,
      modelsCommand: "__huginn_missing_opencode__",
    });

    const catalog = await adapter.getModelCatalog();
    expect(catalog.models).toEqual([]);
    expect(catalog.reason).toContain("could not run");
  });
});
