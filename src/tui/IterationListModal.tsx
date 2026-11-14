import React from "react";
import { Text } from "ink";
import { Modal } from "./Modal.js";
import { MODAL_TITLE_GLYPHS } from "./glyphs.js";
import { iterationListWindow, iterationRowLabel } from "./iterationList.js";

/**
 * The plan's iteration titles, as a read-only checklist.
 *
 * Informative by design: it shows what the plan says and which iteration is
 * running, never a verdict it cannot know. Long plans are windowed with the
 * shared `visibleWindow`, and the subtitle names what is hidden so the window
 * does not look like the whole list.
 */
export function IterationListModal({
  titles,
  current,
  focus,
  maxRows,
  height,
  width,
}: {
  titles: readonly string[];
  /** 1-based iteration that is running (from the engine state). */
  current: number;
  /** 0-based iteration the window is centred on. */
  focus: number;
  /** The caller's row budget, chrome included. */
  maxRows: number;
  height?: number;
  width?: number | string;
}) {
  const window = iterationListWindow(titles.length, focus, maxRows);
  const rows = titles.slice(window.offset, window.end);
  const hiddenAbove = window.offset;
  const hiddenBelow = Math.max(0, titles.length - window.end);
  const hidden =
    hiddenAbove > 0 || hiddenBelow > 0
      ? ` · ▲ ${hiddenAbove} above · ▼ ${hiddenBelow} below`
      : "";

  return (
    <Modal
      title={`${MODAL_TITLE_GLYPHS.iterations} ITERATIONS`}
      subtitle={`decision ${current} of ${titles.length}${hidden}`}
      hint="[i/Esc] Close · [↑/↓] Scroll"
      height={height}
      width={width}
    >
      {rows.map((title, i) => (
        <Text key={`${window.offset + i}-${title}`} wrap="truncate">
          {iterationRowLabel(window.offset + i, title, current)}
        </Text>
      ))}
    </Modal>
  );
}
