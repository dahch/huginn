import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";

/**
 * OpenAI Codex CLI. Discovery returns `[]` instead of a fabricated catalog
 * (AC-27.4); a selected model is forwarded via `-m` (AC-27.5).
 */
export class CodexRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "codex",
      name: "OpenAI Codex CLI",
      command: options.command ?? "codex",
      args: options.args ?? ["exec"],
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
      modelListCommand: options.modelListCommand,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
