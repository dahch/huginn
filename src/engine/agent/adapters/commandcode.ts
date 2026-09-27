import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";

const COMMANDCODE_MODELS: ModelInfo[] = [
  {
    id: "commandcode/default",
    name: "Command Code Default",
    provider: "Command Code",
    description: "Default Command Code model",
  },
];

export class CommandCodeRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "commandcode",
      name: "Command Code",
      command: options.command ?? "commandcode",
      args: options.args ?? ["exec"],
      models: options.models ?? COMMANDCODE_MODELS,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }

  override async isAvailable(): Promise<boolean> {
    if (await super.isAvailable()) return true;
    const fallback = new GenericSubprocessRuntimeAdapter({
      ...this.options,
      command: "command-code",
    });
    return fallback.isAvailable();
  }
}
