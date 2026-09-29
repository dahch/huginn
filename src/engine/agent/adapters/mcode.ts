import { GenericSubprocessRuntimeAdapter, type GenericSubprocessOptions } from "./generic.js";

/**
 * MiniMax Code's auto-approval switch (Phase 3B): `mcode exec` closes stdin
 * right after the prompt, so an approval request can never be answered and would
 * stall the cycle until the phase timeout. `--permission full` is the CLI's own
 * non-interactive policy (`mcode exec --help`: "permission policy: smart, full,
 * or off (ask requires TUI/ACP)") — `full` auto-approves every tool, whereas the
 * default `smart` still decides per action. Verified live: `mcode exec --input -
 * --permission full …` is accepted and reaches the run. Overridable through
 * `permissionArgs`.
 */
export const MCODE_PERMISSION_ARGS = ["--permission", "full"];

/**
 * MiniMax Code CLI (Phase 3B), `@minimax-ai/code` (`mcode` 0.5.8).
 *
 * Non-interactive form: `mcode exec [prompt]` (`mcode exec --help`). The prompt
 * is **not** read from a bare stdin pipe — with no argument the CLI fails with
 * "A prompt, --input -, or at least one --file is required" — but
 * `--input -` makes it read the prompt from stdin, which is verified live
 * (`echo … | mcode exec --input -` reaches the run; an empty stdin is rejected
 * with the same "required" error). `promptViaStdin` is therefore `true` with
 * `--input -` in the base argv, so a real huginn prompt never travels on the
 * argv (SEC-002) and no temp prompt file is needed. A selected model is
 * forwarded via `--model` (AC-27.5).
 *
 * No listings are wired, and none are invented (REQ-27 / REQ-32):
 *
 * - **models**: `mcode` exposes no model-listing command. Its only catalog
 *   surface is `mcode provider list`, which enumerates *providers* and reports
 *   an empty `models` array per provider (`{"providers":[{"providerId":
 *   "minimax_oauth", …, "models":[]}]}`) — so `getModelCatalog()` honestly
 *   returns `[]` with a reason instead of a fabricated `provider/model` list.
 * - **MCP**: the CLI has no `mcp` command at all (`mcode --help`: init, exec,
 *   acp, login, logout, update, provider, plugin), so `listMcpServers()`
 *   resolves `[]` and the panel falls back to config-file discovery. Its MCP
 *   servers are declared in the project's `.mcp.json` (see
 *   `AGENT_REGISTRY.mcode.mcpPaths`).
 */
export class McodeRuntimeAdapter extends GenericSubprocessRuntimeAdapter {
  constructor(options: Partial<GenericSubprocessOptions> = {}) {
    const command = options.command ?? "mcode";
    super({
      id: "mcode",
      name: "MiniMax Code",
      command,
      // Verified argv shape: `exec` with `--input -` (stdin is the only channel
      // that can carry a huginn-sized prompt), plus the auto-approval policy the
      // session appends.
      args: options.args ?? ["exec", "--input", "-"],
      promptViaStdin: options.promptViaStdin ?? true,
      models: options.models,
      modelArgs: options.modelArgs ?? ((model) => ["--model", model]),
      permissionArgs: options.permissionArgs ?? MCODE_PERMISSION_ARGS,
      permissions: options.permissions,
      projectPath: options.projectPath,
      homeDir: options.homeDir,
      env: options.env,
    });
  }
}
