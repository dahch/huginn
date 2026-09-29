import { describe, it, expect, afterAll } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getOpencodeConfigDir } from "./opencodeConfig";

const prevConfig = process.env.HUGINN_OPENCODE_CONFIG_DIR;

afterAll(() => {
  if (prevConfig === undefined) delete process.env.HUGINN_OPENCODE_CONFIG_DIR;
  else process.env.HUGINN_OPENCODE_CONFIG_DIR = prevConfig;
});

describe("getOpencodeConfigDir", () => {
  it("respects HUGINN_OPENCODE_CONFIG_DIR", () => {
    const dir = join(tmpdir(), "huginn-opencode-config");
    process.env.HUGINN_OPENCODE_CONFIG_DIR = dir;
    expect(getOpencodeConfigDir()).toBe(dir);
  });

  it("defaults to <home>/.config/opencode", () => {
    delete process.env.HUGINN_OPENCODE_CONFIG_DIR;
    expect(getOpencodeConfigDir()).toBe(join(homedir(), ".config", "opencode"));
  });
});
