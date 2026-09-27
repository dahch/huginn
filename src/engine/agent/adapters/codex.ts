import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";

const CODEX_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    provider: "OpenAI",
    description: "OpenAI Codex flagship model",
  },
  {
    id: "o3-mini",
    name: "o3-mini",
    provider: "OpenAI",
    description: "Fast reasoning model for math and coding",
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "OpenAI",
    description: "Omni model for code and text",
  },
];

export class CodexRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "codex",
      name: "OpenAI Codex CLI",
      command: options.command ?? "codex",
      args: options.args ?? ["exec"],
      models: options.models ?? CODEX_MODELS,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
