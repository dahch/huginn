import { render as inkRender } from "ink";
import type { RenderOptions } from "ink";

type InkTree = Parameters<typeof inkRender>[0];

/**
 * Ink's `render()` options are typed against full Node terminal streams, but
 * these tests only implement the small subset Ink actually touches
 * (`write`, `on`, terminal dimensions, raw-mode hooks). Loosen **only** the
 * stream fields here, at the test/render boundary, so every test double can
 * stay a plain `PassThrough` instead of claiming the whole `WriteStream` /
 * `ReadStream` surface it does not have.
 */
export type TestRenderOptions = Omit<RenderOptions, "stdout" | "stdin"> & {
  stdout?: unknown;
  stdin?: unknown;
};

export function render(
  tree: InkTree,
  options?: TestRenderOptions,
): ReturnType<typeof inkRender> {
  return inkRender(tree, options as unknown as RenderOptions | undefined);
}
