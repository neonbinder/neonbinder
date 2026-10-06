/**
 * NEO-276 / NEO-224 — bring one row of a scrolling list into its fold by
 * writing the LIST's own `scrollTop`, and nothing else.
 *
 * ## Never `scrollIntoView`
 *
 * `scrollIntoView` walks every scrollable ancestor. In the Set Builder that
 * would drag the `[data-set-selector-scroll]` column row sideways, whose
 * position EntityColumn owns (it scrolls each newly revealed column into view,
 * and a browser scroll here would pull it straight back), and it would move
 * the page vertically under maestro-web, whose only scroll primitive is
 * `window.scroll`: a flow that has just scrolled a control to a known y would
 * find it somewhere else. A `scrollTop` write touches nothing outside the list.
 *
 * Nor does it freeze a column: EntityColumn's freeze-on-interaction listener
 * deliberately ignores the generic `scroll` event (it listens for wheel and
 * touchstart), for exactly this class of programmatic scroll.
 *
 * ## The two modes
 *
 * - `centre` — the row sits in the middle of the fold. Used when a list is
 *   OPENED at its selection, because the neighbours on both sides are what a
 *   "change" decision is made against (NEO-276).
 * - `nearest` — the smallest move that puts the whole row inside the fold, and
 *   no write at all when it is already there. Used when the keyboard
 *   highlight moves, so arrowing within the visible rows never shifts the
 *   list under the operator's eye.
 *
 * ## The arithmetic
 *
 * The row's top in the list's SCROLL coordinates is its viewport top minus the
 * list's viewport top, plus how far the list is already scrolled. Both modes
 * clamp at 0: a browser clamps anyway, happy-dom does not, and a test that
 * models layout should see the value a browser would settle on.
 */

export type ListScrollMode = "centre" | "nearest";

/** Where `row`'s top edge sits in `list`'s scroll coordinates. */
function rowTopInList(list: HTMLElement, row: HTMLElement): number {
  return (
    row.getBoundingClientRect().top -
    list.getBoundingClientRect().top +
    list.scrollTop
  );
}

/**
 * Scroll `list` so `row` (a descendant of it) is inside its fold, per `mode`.
 * Returns true when it wrote `scrollTop`, false when the row was already where
 * the mode wants it (or the list has no layout to reason about).
 */
export function scrollRowIntoList(
  list: HTMLElement,
  row: HTMLElement,
  mode: ListScrollMode,
): boolean {
  const top = rowTopInList(list, row);
  const fold = list.clientHeight;
  const height = row.offsetHeight;

  if (mode === "centre") {
    const next = Math.max(0, top - (fold - height) / 2);
    if (next === list.scrollTop) return false;
    list.scrollTop = next;
    return true;
  }

  // `nearest` with no fold is a list that has not been laid out (display:none,
  // or a test environment without a layout model). Every row would look
  // "below the fold", and writing on that basis would be noise.
  if (fold <= 0) return false;
  const viewTop = list.scrollTop;
  const viewBottom = viewTop + fold;
  let next: number | null = null;
  if (top < viewTop) {
    next = top;
  } else if (top + height > viewBottom) {
    // A row taller than the fold aligns its top, not its bottom: the name is
    // on the first line and is the part the operator needs to read.
    next = height > fold ? top : top + height - fold;
  }
  if (next === null) return false;
  next = Math.max(0, next);
  if (next === list.scrollTop) return false;
  list.scrollTop = next;
  return true;
}
