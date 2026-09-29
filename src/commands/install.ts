/**
 * `huginn install` — compatibility no-op.
 *
 * Huginn's opencode agents and step prompts are built in (`src/engine/steps`),
 * so there is nothing to copy into `~/.config/opencode` anymore. The subcommand
 * is kept as a handler rather than deleted because `install` is a known command
 * in `src/cli.ts`: without it the literal "install" positional would fall through
 * to the run/plan/live path, which exits 1 when the project has no
 * plan.md/spec.md/adr.md.
 */

/** The exact notice `huginn install` prints (exit 0). */
export const INSTALL_NOOP_MESSAGE =
  "[huginn] agents and step prompts are built in; there is nothing to install.";

export interface InstallIo {
  log?: (message: string) => void;
}

/** Print the built-in notice and return: a successful no-op (exit 0). */
export function handleInstallCommand(io: InstallIo = {}): void {
  (io.log ?? console.log)(INSTALL_NOOP_MESSAGE);
}
