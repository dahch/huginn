import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import { parseQwenMcpList } from "./mcpList.js";

/**
 * Qwen Code CLI. No model-listing command is exposed (verified), so discovery
 * returns `[]` rather than a fabricated catalog (AC-27.4); a selected model is
 * forwarded via `-m` (AC-27.5).
 *
 * `qwen mcp list` *can* enumerate the servers its own config declares, including
 * the transport and a health-checked status (REQ-32 / AC-32.1), so the panel
 * shows qwen's own answer instead of a guess.
 */
export class QwenRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "qwen";
    super({
      id: "qwen",
      name: "Qwen Code",
      command,
      args: options.args ?? ["prompt"],
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["-m", model]),
      modelListCommand: options.modelListCommand,
      mcpListCommand: options.mcpListCommand ?? {
        command,
        args: ["mcp", "list"],
        parse: parseQwenMcpList,
      },
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
