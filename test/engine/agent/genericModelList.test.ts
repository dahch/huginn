import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericSubprocessRuntimeAdapter } from "../../../src/engine/agent/adapters/generic.js";
import { CommandCodeRuntimeAdapter } from "../../../src/engine/agent/adapters/commandcode.js";
import type { ModelInfo } from "../../../src/engine/agent/types.js";

const tempDirs: string[] = [];

function makeScript(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "huginn-modellist-"));
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
    .map((l) => l.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id.split("/")[1] ?? id, provider: id.split("/")[0] }));
}

describe("REQ-27 · GenericSubprocessRuntimeAdapter model discovery (AC-27.4)", () => {
  it("prefers the declarative modelListCommand over a static models array", async () => {
    const script = makeScript("list-models.sh", `printf 'cli-only/model-x\\ncli-only/model-y\\n'`);

    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini",
      models: [{ id: "static/model-z", name: "Static", provider: "static" }],
      modelListCommand: { command: script, args: ["--list-models"], parse: parseIdLines },
    });

    const models = await adapter.getAvailableModels();
    expect(models.map((m) => m.id)).toEqual(["cli-only/model-x", "cli-only/model-y"]);
  });

  it("passes the configured argv to the listing command", async () => {
    const script = makeScript("echo-args.sh", `printf '%s\\n' "$@"`);

    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini",
      modelListCommand: { command: script, args: ["--list-models", "--json"], parse: parseIdLines },
    });

    // The parser receives the raw stdout, so asserting on the returned ids is
    // equivalent to asserting the argv that was actually spawned.
    const models = await adapter.getAvailableModels();
    expect(models.map((m) => m.id)).toEqual(["--list-models", "--json"]);
  });

  it("returns [] on listing failure — never the static array, never a fake", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini",
      models: [{ id: "static/model-z", name: "Static", provider: "static" }],
      modelListCommand: {
        command: "__huginn_missing_listing_cli__",
        args: ["--list-models"],
        parse: parseIdLines,
      },
    });

    expect(await adapter.getAvailableModels()).toEqual([]);
  });

  it("returns [] when the parser itself throws", async () => {
    const script = makeScript("garbage.sh", `printf 'not json\\n'`);
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "gemini",
      name: "Gemini CLI",
      command: "gemini",
      modelListCommand: {
        command: script,
        args: [],
        parse: () => {
          throw new Error("parse failure");
        },
      },
    });

    expect(await adapter.getAvailableModels()).toEqual([]);
  });

  it("returns [] when neither models nor modelListCommand is configured", async () => {
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "cursor",
      name: "Cursor",
      command: "cursor",
    });
    expect(await adapter.getAvailableModels()).toEqual([]);
  });

  it("still honours an explicitly injected static models array", async () => {
    const injected: ModelInfo[] = [{ id: "static/model-z", name: "Static", provider: "static" }];
    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "cursor",
      name: "Cursor",
      command: "cursor",
      models: injected,
    });
    expect(await adapter.getAvailableModels()).toEqual(injected);
  });

  it("returns [] when the Command Code listing CLI exits non-zero", async () => {
    const script = makeScript("failing-commandcode.sh", "exit 3");
    const adapter = new CommandCodeRuntimeAdapter({
      command: script,
      modelListCommand: { command: script, args: ["--list-models"], parse: parseIdLines },
    });
    expect(await adapter.getAvailableModels()).toEqual([]);
  });
});

describe("REQ-27 · native model forwarding (AC-27.5)", () => {
  it("appends modelArgs to argv and keeps HUGINN_MODEL as an extra hint", async () => {
    const script = makeScript(
      "argv-and-env.sh",
      `printf '%s\\n' "$@"\nprintf 'HUGINN_MODEL=%s\\n' "$HUGINN_MODEL"`,
    );

    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "claude",
      name: "Claude Code",
      command: script,
      args: ["-p"],
      modelArgs: (model) => ["--model", model],
    });

    const session = await adapter.createSession({ title: "Model forwarding" });
    const result = await session.prompt("hello", { model: "anthropic/claude-sonnet-5" });

    expect(result.text).toContain("--model");
    expect(result.text).toContain("anthropic/claude-sonnet-5");
    expect(result.text).toContain("HUGINN_MODEL=anthropic/claude-sonnet-5");
  });

  it("uses the runtime's short flag for Command Code", async () => {
    const script = makeScript("argv.sh", `printf '%s\\n' "$@"`);

    const adapter = new CommandCodeRuntimeAdapter({ command: script });
    const session = await adapter.createSession({ title: "Command Code model" });
    const result = await session.prompt("hello", { model: "claude-sonnet-5" });

    const args = result.text.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(args).toEqual(["-p", "-m", "claude-sonnet-5"]);
  });

  it("replaces the model the base argv already carries instead of dropping the selection (REV-005)", async () => {
    const script = makeScript("argv.sh", `printf '%s\\n' "$@"`);

    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "claude",
      name: "Claude Code",
      command: script,
      args: ["-p", "--model", "preset-model"],
      modelArgs: (model) => ["--model", model],
    });

    const session = await adapter.createSession({ title: "Replace existing flag" });
    const result = await session.prompt("hello", { model: "anthropic/claude-sonnet-5" });

    const args = result.text.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(args).toEqual(["-p", "--model", "anthropic/claude-sonnet-5"]);
    expect(args.filter((a) => a === "--model")).toHaveLength(1);
    expect(args).not.toContain("preset-model");
  });

  it("replaces an inline `--flag=value` model argument (REV-005)", async () => {
    const script = makeScript("argv.sh", `printf '%s\\n' "$@"`);

    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "claude",
      name: "Claude Code",
      command: script,
      args: ["-p", "--model=preset-model"],
      modelArgs: (model) => ["--model", model],
    });

    const session = await adapter.createSession({ title: "Replace inline flag" });
    const result = await session.prompt("hello", { model: "anthropic/claude-sonnet-5" });

    expect(result.text.split("\n").map((l) => l.trim()).filter(Boolean)).toEqual([
      "-p",
      "--model=anthropic/claude-sonnet-5",
    ]);
  });

  it("inserts the value when the base argv carries a bare trailing flag (REV-005)", async () => {
    const script = makeScript("argv.sh", `printf '%s\\n' "$@"`);

    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "gemini",
      name: "Gemini CLI",
      command: script,
      args: ["-m"],
      modelArgs: (model) => ["-m", model],
    });

    const session = await adapter.createSession({ title: "Bare flag" });
    const result = await session.prompt("hello", { model: "gemini-3.8-flash" });

    expect(result.text.split("\n").map((l) => l.trim()).filter(Boolean)).toEqual(["-m", "gemini-3.8-flash"]);
  });

  it("omits the model flag entirely when no model is selected", async () => {
    const script = makeScript("argv.sh", `printf '%s\\n' "$@"`);

    const adapter = new GenericSubprocessRuntimeAdapter({
      id: "qwen",
      name: "Qwen Code",
      command: script,
      args: ["prompt"],
      modelArgs: (model) => ["-m", model],
    });

    const session = await adapter.createSession({ title: "No model" });
    const result = await session.prompt("hello");

    const args = result.text.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(args).toEqual(["prompt"]);
  });
});
