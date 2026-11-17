import React from "react";
import { Text } from "ink";
import { Modal } from "./Modal.js";
import { MODAL_TITLE_GLYPHS } from "./glyphs.js";
import { iterationListWindow, iterationRowLabel } from "./iterationList.js";

/**
 * The plan's iteration titles, as a read-only list you can browse.
 *
 * Informative by design: it shows what the plan says and which iteration is
 * running, never a verdict it cannot know. Long plans are windowed with the
 * shared `visibleWindow`, and the subtitle names what is hidden so the window
 * does not look like the whole list.
 *
 * The arrows move a **cursor**, not a scroll. With fewer iterations than rows the
 * window never moves, so a scroll-only reading made `↑`/`↓` look dead (there was
 * no marker either); the focused row now carries `›` and the subtitle names that
 * iteration's goal, so browsing is visible whether or not the list overflows.
 * The list stays read-only: no reordering, no verdicts — the plan is the plan.
 */
export function IterationListModal({
  titles,
  goals = [],
  current,
  focus,
  maxRows,
  height,
  width,
}: {
  titles: readonly string[];
  /** One goal per title, when the plan declares it (empty string otherwise). */
  goals?: readonly string[];
  /** 1-based iteration that is running (from the engine state). */
  current: number;
  /** 0-based iteration the window is centred on. */
  focus: number;
  /** The caller's row budget, chrome included. */
  maxRows: number;
  height?: number;
  width?: number | string;
}) {
  // A stored focus can outlive the list (a re-planned project), and a subtitle
  // reading "undefined" is worse than a clamped cursor.
  const focusIndex = Math.min(Math.max(0, focus), Math.max(0, titles.length - 1));
  const window = iterationListWindow(titles.length, focusIndex, maxRows);
  const rows = titles.slice(window.offset, window.end);
  const hiddenAbove = window.offset;
  const hiddenBelow = Math.max(0, titles.length - window.end);
  const hidden =
    hiddenAbove > 0 || hiddenBelow > 0
      ? ` · ▲ ${hiddenAbove} above · ▼ ${hiddenBelow} below`
      : "";
  // What the cursor is on. The plan's own goal is the only useful fact the list
  // can offer — never a status it would have to invent.
  const goal = (goals[focusIndex] ?? "").trim();
  const browsing = goal.length > 0 ? goal : (titles[focusIndex] ?? "");

  return (
    <Modal
      title={`${MODAL_TITLE_GLYPHS.iterations} ITERATIONS`}
      subtitle={`iteration ${current} of ${titles.length}${hidden}${browsing ? ` › ${browsing}` : ""}`}
      hint="[i/Esc] Close · [↑/↓] Browse"
      height={height}
      width={width}
    >
      {rows.map((title, i) => (
        <Text key={`${window.offset + i}-${title}`} wrap="truncate">
          {iterationRowLabel(window.offset + i, title, current, window.offset + i === focusIndex)}
        </Text>
      ))}
    </Modal>
  );
}
