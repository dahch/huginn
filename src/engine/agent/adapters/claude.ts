import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";
import { CLAUDE_MCP_LIST_TIMEOUT_MS, parseClaudeMcpList } from "./mcpList.js";

/**
 * Claude Code's auto-approval switch (Phase 2C). `claude -p` closes stdin after
 * the prompt, so it can never be asked for a permission huginn would grant:
 * without this flag any tool call the CLI considers sensitive stalls until the
 * phase timeout. It is Claude Code's own flag (re-verify with
 * `claude --help`) and is overridable through `permissionArgs`.
 */
export const CLAUDE_PERMISSION_ARGS = ["--dangerously-skip-permissions"];

/**
 * Claude Code CLI. Its CLI exposes no model-listing command (verified), so
 * discovery is honestly empty (AC-27.4) and a model chosen in the picker is
 * forwarded through `--model` (AC-27.5).
 *
 * It *can* enumerate its own MCP servers (`claude mcp list`, REQ-32 / AC-32.1),
 * which is the only way to see the servers its per-agent config declares. That
 * command health-checks every server, so it runs under a generous but bounded
 * deadline (NFR-9).
 */
export class ClaudeRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "claude";
    super({
      id: "claude",
      name: "Claude Code",
      command,
      args: options.args ?? ["-p"],
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
      permissionArgs: options.permissionArgs ?? CLAUDE_PERMISSION_ARGS,
      permissions: options.permissions,
      modelListCommand: options.modelListCommand,
      mcpListCommand: options.mcpListCommand ?? {
        command,
        args: ["mcp", "list"],
        parse: parseClaudeMcpList,
        timeoutMs: CLAUDE_MCP_LIST_TIMEOUT_MS,
      },
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
