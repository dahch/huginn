import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import type { ModelInfo } from "../types.js";

const OMP_MODELS: ModelInfo[] = [
  {
    id: "omp/default",
    name: "Oh My Pi Default",
    provider: "Oh My Pi",
    description: "Default Oh My Pi agent model",
  },
  {
    id: "omp/coder",
    name: "Oh My Pi Coder",
    provider: "Oh My Pi",
    description: "Code generation specialized model",
  },
];

export class OmpRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    super({
      id: "omp",
      name: "Oh My Pi",
      command: options.command ?? "omp",
      args: options.args ?? ["prompt"],
      models: options.models ?? OMP_MODELS,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
