import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";

/**
 * Qwen Code CLI. No model-listing command is exposed (verified), so discovery
 * returns `[]` rather than a fabricated catalog (AC-27.4); a selected model is
 * forwarded via `-m` (AC-27.5).
 */
export class QwenRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "qwen",
      name: "Qwen Code",
      command: options.command ?? "qwen",
      args: options.args ?? ["prompt"],
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
      modelListCommand: options.modelListCommand,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }

  override async isAvailable(): Promise<boolean> {
    if (await super.isAvailable()) return true;
    const fallback = new GenericSubprocessRuntimeAdapter({
      ...this.options,
      command: "qwen-code",
    });
    return fallback.isAvailable();
  }
}
