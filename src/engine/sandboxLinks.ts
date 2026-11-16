/**
 * The entries huginn links from the primary project into every iteration
 * sandbox (see `WorktreeManager.linkSharedDeps`).
 *
 * They are **environment plumbing, never part of an increment**. A link is not
 * source code: committing one makes an iteration's diff depend on how the
 * machine happens to be configured, and `.pi`/ `.agents` were the live
 * failure — `git add -A` committed `.pi -> <project>/.pi`, so the next
 * promotion died on a file-vs-directory collision with the user's real `.pi/`
 * directory and the increment never landed.
 *
 * Two rules follow from that, and every call site here enforces one of them:
 * huginn never *stages* a link, and a preserved branch that already carries one
 * (committed by an older huginn) gets it scrubbed deterministically before an
 * integration is attempted.
 */
export const SANDBOX_LINKS = ["node_modules", ".env", ".pi", ".agents"] as const;

/**
 * True when `rel` is one of the injected links or lives under it
 * (`node_modules/x`, `.pi/`, `.pi`): the trailing slash a collapsed
 * `git status` row carries is dropped first.
 */
export function isSandboxLinkPath(rel: string): boolean {
  const clean = rel.replace(/^\/+/, "").replace(/\/+$/, "").replace(/^\.\//, "");
  if (!clean) return false;
  return SANDBOX_LINKS.some((name) => clean === name || clean.startsWith(`${name}/`));
}

/** Drop the injected links from a list of changed paths. */
export function withoutSandboxLinks(paths: string[]): string[] {
  return paths.filter((rel) => !isSandboxLinkPath(rel));
}
