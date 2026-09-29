import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";

/**
 * Codex's auto-approval switch (Phase 2C): bypasses both the approval prompts
 * and the sandbox, which is what a non-interactive `codex exec` needs —
 * `codex exec` closes stdin after the prompt, so an approval request can never
 * be answered. It is Codex's own flag (re-verify with `codex exec --help`) and
 * is overridable through `permissionArgs`.
 */
export const CODEX_PERMISSION_ARGS = ["--dangerously-bypass-approvals-and-sandbox"];

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
      permissionArgs: options.permissionArgs ?? CODEX_PERMISSION_ARGS,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
