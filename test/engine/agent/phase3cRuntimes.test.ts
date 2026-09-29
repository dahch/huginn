import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentRuntime, SUBPROCESS_PERMISSION_ARGS } from "../../../src/engine/agent/registry.js";
import {
  KIMI_MAX_PROMPT_ARG_LENGTH,
  KIMI_PERMISSION_ARGS,
  PI_PERMISSION_ARGS,
  CODEX_PERMISSION_ARGS,
} from "../../../src/engine/agent/adapters/index.js";
import { events } from "../../../src/engine/engineEvents.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Installs a fake CLI that records the **argv it was spawned with** (one token
 * per line) and the **stdin it received**, so a failure proves the argv/stdio
 * huginn really built — not just an internal field.
 *
 * When the CLI's listing argv is given (`listingArgs` + `listingFixture`), that
 * one invocation answers with the captured fixture and the prompt path is
 * untouched; the argv record is shared, because a test uses one or the other.
 */
function installFakeCli(
  name: string,
  listing?: { args: string; fixture: string },
): { path: string; cleanup: () => void; argvPath: string; stdinPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `huginn-phase3c-${name}-`));
  tempDirs.push(dir);
  const argvPath = join(dir, "argv.txt");
  const stdinPath = join(dir, "stdin.txt");
  const bin = join(dir, name);

  const listingCase = listing
    ? `case "$*" in\n  "${listing.args}") printf '%s\\n' "$@" > "$HUGINN_ARGV"; cat '${join(FIXTURES, listing.fixture)}'; exit 0 ;;\nesac\n`
    : "";

  writeFileSync(
    bin,
    "#!/bin/sh\n" + listingCase + 'printf \'%s\\n\' "$@" > "$HUGINN_ARGV"\ncat > "$HUGINN_STDIN"\nprintf \'done\\n\'\n',
  );
  chmodSync(bin, 0o755);

  return {
    // The real PATH stays behind the temp dir so the script can still call `cat`.
    path: `${dir}:${process.env.PATH ?? ""}`,
    argvPath,
    stdinPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface Spawned {
  argv: string[];
  stdin: string;
}

function recorded(cli: { argvPath: string; stdinPath: string }): Spawned {
  const argv = readFileSync(cli.argvPath, "utf8").split("\n").filter((line) => line.length > 0);
  const stdin = readFileSync(cli.stdinPath, "utf8");
  return { argv, stdin };
}

/** Runs one prompt through a real registry-built runtime and reports what the CLI saw. */
async function spawnPrompt(
  target: "kimi" | "pi" | "codex",
  cli: { path: string; argvPath: string; stdinPath: string },
  prompt: string,
  options?: { model?: string },
): Promise<Spawned> {
  const runtime = getAgentRuntime(target, {
    env: { PATH: cli.path, HUGINN_ARGV: cli.argvPath, HUGINN_STDIN: cli.stdinPath },
  });
  const session = await runtime.createSession({ title: target });
  await session.prompt(prompt, options);
  return recorded(cli);
}

describe("Phase 3C · kimi runs non-interactively through `--prompt=<prompt>`", () => {
  it("passes the prompt inline (`--prompt=<text>`) and never wires `--auto`/`-y` (the CLI rejects them in prompt mode)", async () => {
    const cli = installFakeCli("kimi");
    const { argv, stdin } = await spawnPrompt("kimi", cli, "do the thing");
    // SEC-304: the inline `=` form is a single unambiguous token, unlike the
    // separate `-p <text>` that node:util parseArgs calls ambiguous for a value
    // beginning with `-`.
    expect(argv).toEqual(["--prompt=do the thing"]);
    // `kimi --prompt=<text>` is the only channel — no prompt file, no stdin read
    // — so huginn closes stdin straight away instead of writing the prompt to it.
    expect(stdin).toBe("");
    for (const flag of ["--auto", "-y", "--yolo", "--plan"]) {
      expect(argv, flag).not.toContain(flag);
    }
  });

  it("carries a prompt that begins with `-` unambiguously (SEC-304)", async () => {
    const cli = installFakeCli("kimi");
    const { argv } = await spawnPrompt("kimi", cli, "- fix the failing test --verbose");
    expect(argv).toEqual(["--prompt=- fix the failing test --verbose"]);
  });

  it("puts the model's `-m` flag before the prompt token", async () => {
    const cli = installFakeCli("kimi");
    const { argv } = await spawnPrompt("kimi", cli, "do the thing", { model: "moonshot/kimi-k2.5" });
    expect(argv).toEqual(["-m", "moonshot/kimi-k2.5", "--prompt=do the thing"]);
  });

  it("accepts a spec-sized prompt (well past the 4096 positional default) as the flag value", async () => {
    const cli = installFakeCli("kimi");
    const prompt = "S".repeat(20_000);
    const { argv } = await spawnPrompt("kimi", cli, prompt);
    expect(argv).toEqual([`--prompt=${prompt}`]);
  });

  it("fails closed when the prompt exceeds the flag-value cap (MAX_ARG_STRLEN)", async () => {
    const cli = installFakeCli("kimi");
    const runtime = getAgentRuntime("kimi", {
      env: { PATH: cli.path, HUGINN_ARGV: cli.argvPath, HUGINN_STDIN: cli.stdinPath },
    });
    const session = await runtime.createSession({ title: "kimi oversized" });
    await expect(session.prompt("x".repeat(KIMI_MAX_PROMPT_ARG_LENGTH + 1))).rejects.toThrow(
      /exceeds maximum command line argument limit \(120000\)/,
    );
  });

  it("measures the cap in UTF-8 bytes, not UTF-16 code units (SEC-302)", async () => {
    const cli = installFakeCli("kimi");
    const runtime = getAgentRuntime("kimi", {
      env: { PATH: cli.path, HUGINN_ARGV: cli.argvPath, HUGINN_STDIN: cli.stdinPath },
    });
    const session = await runtime.createSession({ title: "kimi non-ascii oversized" });

    // Each emoji is 4 UTF-8 bytes but only 2 UTF-16 code units: 30_001 of them is
    // 120_004 bytes (over the cap) yet `length === 60_002` (well under it). A
    // `text.length` check would wrongly let it through.
    const prompt = "🎉".repeat(30_001);
    expect(prompt.length).toBeLessThan(KIMI_MAX_PROMPT_ARG_LENGTH);
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(KIMI_MAX_PROMPT_ARG_LENGTH);

    await expect(session.prompt(prompt)).rejects.toThrow(
      /exceeds maximum command line argument limit \(120000\)/,
    );
  });

  it("accepts a non-ASCII prompt that stays under the byte cap (SEC-302)", async () => {
    const cli = installFakeCli("kimi");
    // 10_000 CJK glyphs = 30_000 UTF-8 bytes (under the 120_000 cap) while
    // `length` is 10_000 — it must reach the CLI intact.
    const prompt = "漢字".repeat(5_000);
    expect(Buffer.byteLength(prompt, "utf8")).toBe(30_000);
    const { argv } = await spawnPrompt("kimi", cli, prompt);
    expect(argv).toEqual([`--prompt=${prompt}`]);
  });

  it("stays silent about permissions — there is no flag to announce", async () => {
    const cli = installFakeCli("kimi");
    const logs: Array<{ level: string; message: string }> = [];
    const off = events.on("log", (e) => logs.push({ level: e.level, message: e.message }));
    try {
      await spawnPrompt("kimi", cli, "do the thing");
      expect(logs.filter((l) => l.message.includes("auto-approved permissions"))).toHaveLength(0);
      expect(logs.filter((l) => l.message.includes("assuming"))).toHaveLength(0);
    } finally {
      off();
    }
  });

  it("discovers its catalog through `kimi provider list --json`", async () => {
    const cli = installFakeCli("kimi", { args: "provider list --json", fixture: "kimi-provider-list.json" });
    const runtime = getAgentRuntime("kimi", { env: { PATH: cli.path, HUGINN_ARGV: cli.argvPath } });

    expect(await runtime.getAvailableModels()).toEqual([
      { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" },
      { id: "deepseek-reasoner", name: "deepseek-reasoner", provider: "deepseek" },
      { id: "kimi-k2.5-high", name: "Kimi K2.5 (High)", provider: "moonshot" },
      { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "openrouter" },
    ]);
    // …against the exact argv, so the wiring (not just the parser) is asserted.
    expect(readFileSync(cli.argvPath, "utf8").trim().split("\n")).toEqual(["provider", "list", "--json"]);
  });
});

describe("Phase 3C · pi streams the prompt over stdin", () => {
  it("spawns `pi -p` and sends the prompt on stdin, never on the argv (SEC-002)", async () => {
    const cli = installFakeCli("pi");
    const { argv, stdin } = await spawnPrompt("pi", cli, "summarise the diff");
    expect(argv).toEqual(["-p", "--approve"]);
    expect(stdin).toBe("summarise the diff");
    // The prompt is nowhere in the argv (nor in `ps`).
    expect(argv).not.toContain("summarise the diff");
  });

  it("forwards the model through `--model`, never the unsupported `-m`", async () => {
    const cli = installFakeCli("pi");
    const { argv, stdin } = await spawnPrompt("pi", cli, "hello", { model: "deepseek/deepseek-v4-pro" });
    expect(argv).toEqual(["-p", "--model", "deepseek/deepseek-v4-pro", "--approve"]);
    expect(argv).not.toContain("-m");
    expect(stdin).toBe("hello");
  });

  it("discovers its catalog through `pi --list-models`", async () => {
    const cli = installFakeCli("pi", { args: "--list-models", fixture: "pi-models.txt" });
    const runtime = getAgentRuntime("pi", { env: { PATH: cli.path, HUGINN_ARGV: cli.argvPath } });

    expect(await runtime.getAvailableModels()).toEqual([
      {
        id: "deepseek/deepseek-flash",
        name: "deepseek-flash",
        provider: "deepseek",
        description: "context 1M · max-out 384K · thinking yes · images yes",
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "deepseek-v4-pro",
        provider: "deepseek",
        description: "context 1M · max-out 384K · thinking yes · images no",
      },
    ]);
    expect(readFileSync(cli.argvPath, "utf8").trim().split("\n")).toEqual(["--list-models"]);
  });
});

describe("Phase 3C · codex exec streams the prompt over stdin", () => {
  it("spawns `codex exec` with the bypass flag and sends the prompt on stdin, never on the argv", async () => {
    const cli = installFakeCli("codex");
    const { argv, stdin } = await spawnPrompt("codex", cli, "summarise the diff");
    expect(argv).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
    expect(stdin).toBe("summarise the diff");
    expect(argv).not.toContain("summarise the diff");
    // No positional `-` placeholder is needed: a bare `codex exec` reads stdin.
    expect(argv).not.toContain("-");
  });

  it("forwards the model through `-m` after the `exec` subcommand", async () => {
    const cli = installFakeCli("codex");
    const { argv } = await spawnPrompt("codex", cli, "hello", { model: "gpt-6-luna" });
    expect(argv).toEqual(["exec", "-m", "gpt-6-luna", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("enumerates its MCP servers through `codex mcp list --json`", async () => {
    const cli = installFakeCli("codex", { args: "mcp list --json", fixture: "codex-mcp-list.json" });
    const runtime = getAgentRuntime("codex", { env: { PATH: cli.path, HUGINN_ARGV: cli.argvPath } });

    expect(await runtime.listMcpServers()).toEqual([
      {
        name: "muninn",
        transport: "stdio",
        status: "enabled",
        detail: "huginn mcp run --project /home/dev/projects/huginn",
      },
    ]);
    expect(readFileSync(cli.argvPath, "utf8").trim().split("\n")).toEqual(["mcp", "list", "--json"]);
  });

  it("keeps model discovery honestly absent (`codex` exposes no listing command)", async () => {
    const cli = installFakeCli("codex");
    const catalog = await getAgentRuntime("codex", { env: { PATH: cli.path } }).getModelCatalog?.();
    expect(catalog).toEqual({ models: [], reason: "no model-listing command for this runtime" });
  });
});

describe("Phase 3C · no listing is fabricated where the CLI exposes none", () => {
  it("resolves [] for kimi/pi MCP enumeration (neither CLI has an `mcp` command)", async () => {
    const kimiCli = installFakeCli("kimi");
    const piCli = installFakeCli("pi");
    for (const [target, path] of [
      ["kimi", kimiCli.path],
      ["pi", piCli.path],
    ] as const) {
      const runtime = getAgentRuntime(target, { env: { PATH: path } });
      expect(await runtime.listMcpServers?.(), target).toEqual([]);
    }
  });
});

describe("Phase 3C · the permission table and the adapters cannot drift", () => {
  it("kimi wires an empty, verified flag list (prompt mode is already Never Ask)", () => {
    expect(SUBPROCESS_PERMISSION_ARGS.kimi).toBe(KIMI_PERMISSION_ARGS);
    expect(SUBPROCESS_PERMISSION_ARGS.kimi).toEqual([]);
  });

  it("pi keeps its assumed project-trust flag", () => {
    expect(SUBPROCESS_PERMISSION_ARGS.pi).toBe(PI_PERMISSION_ARGS);
    expect(SUBPROCESS_PERMISSION_ARGS.pi).toEqual(["--approve"]);
  });

  it("codex keeps its verified bypass flag", () => {
    expect(SUBPROCESS_PERMISSION_ARGS.codex).toEqual(CODEX_PERMISSION_ARGS);
    expect(SUBPROCESS_PERMISSION_ARGS.codex).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
  });
});
