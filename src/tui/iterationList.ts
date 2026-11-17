import { visibleWindow, type PickerWindow } from "./pickerWindow.js";

/**
 * Rows the shared modal frame spends on the iteration list: two border rows,
 * the title, the one-line subtitle and the key footer. The subtitle is part of
 * the cost on purpose — a budget that forgets it makes the frame overflow, and
 * Ink then squeezes the title out of the border (which is how this modal first
 * lost its own heading). The list gets whatever is left.
 */
export const ITERATION_LIST_CHROME = 5;

export interface IterationListWindow extends PickerWindow {
  /** Body rows the caller's budget could pay for. */
  budget: number;
}

/**
 * The window the modal shows. It is centred on the focused iteration so the one
 * that is running is visible wherever it sits in the plan, and both edges clamp
 * to the list (`visibleWindow` owns that arithmetic — this is a thin reading of
 * the budget, not a second implementation).
 */
export function iterationListWindow(
  total: number,
  focus: number,
  maxRows: number,
): IterationListWindow {
  const budget = Math.max(0, Math.floor(maxRows) - ITERATION_LIST_CHROME);
  const window = visibleWindow(total, focus, Math.max(1, budget), "center");
  return { ...window, budget };
}

/**
 * One row per iteration: `>` marks the one that is running, `›` the one the
 * list is browsing, and nothing else is claimed. An earlier iteration is not
 * marked done — a resumed run may have skipped it, and the title is the only
 * fact the plan gives us.
 *
 * The two markers are separate columns so they can disagree: browsing iteration
 * 2 while iteration 4 runs is a perfectly normal thing to do, and one mark
 * overwriting the other would silently lie about which is which.
 */
export function iterationRowLabel(
  index: number,
  title: string,
  current: number,
  focused = false,
): string {
  const running = index === current - 1 ? ">" : " ";
  const selected = focused ? "›" : " ";
  return `${running}${selected} ${String(index + 1).padStart(2, " ")}. ${title}`;
}
