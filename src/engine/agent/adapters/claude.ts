import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";

/**
 * Claude Code CLI. Its CLI exposes no model-listing command (verified), so
 * discovery is honestly empty (AC-27.4) and a model chosen in the picker is
 * forwarded through `--model` (AC-27.5).
 */
export class ClaudeRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "claude",
      name: "Claude Code",
      command: options.command ?? "claude",
      args: options.args ?? ["-p"],
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
      modelListCommand: options.modelListCommand,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
