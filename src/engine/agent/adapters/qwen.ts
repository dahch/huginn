import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";

const QWEN_MODELS: ModelInfo[] = [
  {
    id: "qwen-2.5-coder-32b",
    name: "Qwen 2.5 Coder 32B",
    provider: "Qwen",
    description: "Open-source flagship code model",
  },
  {
    id: "qwen-2.5-coder-7b",
    name: "Qwen 2.5 Coder 7B",
    provider: "Qwen",
    description: "Lightweight efficient coding model",
  },
];

export class QwenRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "qwen",
      name: "Qwen Code",
      command: options.command ?? "qwen",
      args: options.args ?? ["prompt"],
      models: options.models ?? QWEN_MODELS,
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
