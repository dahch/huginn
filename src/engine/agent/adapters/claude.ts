import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";

const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: "claude-3-7-sonnet-latest",
    name: "Claude 3.7 Sonnet",
    provider: "Anthropic",
    description: "Hybrid reasoning and code generation flagship",
  },
  {
    id: "claude-3-5-sonnet-latest",
    name: "Claude 3.5 Sonnet",
    provider: "Anthropic",
    description: "High capability coding model",
  },
  {
    id: "claude-3-5-haiku-latest",
    name: "Claude 3.5 Haiku",
    provider: "Anthropic",
    description: "Fast, lightweight model",
  },
  {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "Anthropic",
    description: "Advanced architectural reasoning",
  },
];

export class ClaudeRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "claude",
      name: "Claude Code",
      command: options.command ?? "claude",
      args: options.args ?? ["-p"],
      models: options.models ?? CLAUDE_MODELS,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
