import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery } from "convex/react";
import { Input } from "../primitives/Input";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import { FunctionReference } from "convex/server";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { useComboboxHighlight } from "@/src/hooks/useComboboxHighlight";
import { scrollRowIntoList } from "./list-scroll";

export type SelectorItem = { _id: string; [key: string]: unknown };

// Stable, module-level display accessor shared by every column wrapper
// (Sport / Year / Manufacturer / Set / SetVariant / Variant / Parallel all
// display `item.value`). Passing this ONE reference instead of a fresh inline
// arrow per render keeps `getDisplayName` referentially stable, so the
// `sortedItems` useMemo below actually memoizes across re-renders (NEO-85). An
// inline arrow would give the memo a new dep identity every render, silently
// defeating it.
export const displayByValue = (item: SelectorItem) => item.value as string;

/**
 * NEO-237 (D17) — an entry pinned to the top of a column that is a VIEW, not
 * a row: it is selected by a client sentinel `id` the caller owns, never a
 * document id, and it is there whether the column has zero rows or a hundred.
 *
 * Pinned entries are outside the data list on purpose: the search filter never
 * hides them and the sort never moves them — they sit first, always. They ARE
 * options in the listbox (the keyboard highlight reaches them, a filter that
 * matches their name lands on them, `aria-selected`), because to the operator
 * they are one of the column's choices.
 *
 * `description` is a second, muted line under the name, rendered exactly like
 * a row's `getDescription`. The name stays alone in its own text node so a
 * flow tapping the visible text finds one element.
 */
export type PinnedEntry = {
  id: string;
  name: string;
  /** The full accessible name; must contain `name` (WCAG 2.5.3). */
  ariaLabel: string;
  description?: string;
};

/**
 * A pinned entry as the row machinery sees it, tagged so the render path can
 * tell it from a data row. The tag is a symbol-free string key rather than a
 * class so the object stays a plain `SelectorItem`.
 */
type PinnedItem = SelectorItem & { __pinned: PinnedEntry };

const isPinnedItem = (item: SelectorItem): item is PinnedItem =>
  "__pinned" in item;

type EntitySelectorProps = {
  title: string;
  query: FunctionReference<"query">;
  queryArgs?: Record<string, unknown>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  getDisplayName: (item: SelectorItem) => string;
  getDescription?: (item: SelectorItem) => string | undefined;
  selectedColor: string;
  // Returns true if the item is a terminal node — i.e., selecting it
  // shows a card checklist. Only terminal items render SL/BSC pills,
  // since the platform mappings only become user-meaningful at the
  // checklist boundary. Defaults to false everywhere.
  isItemTerminal?: (item: SelectorItem) => boolean;
  /** NEO-237 — see {@link PinnedEntry}. Rendered first, in the given order. */
  pinnedEntries?: ReadonlyArray<PinnedEntry>;
  /**
   * NEO-237 — data rows this returns true for sort ahead of the rest, in
   * their usual order among themselves; the rest keep theirs (the sort is
   * stable). Unlike a pinned entry a lead row IS a data row: selectable by
   * its document id and filtered by the search box like any other. The caller
   * decides from the row's own fields (a flag NB wrote), never from its name.
   * Pass ONE stable reference — an inline arrow defeats the `sortedItems`
   * memo, as for `getDisplayName`.
   */
  leadRow?: (item: SelectorItem) => boolean;
};

function getPlatformData(item: SelectorItem): {
  sportlots?: string;
  bsc?: string | string[];
} | null {
  const pd = item.platformData;
  if (pd && typeof pd === "object") {
    return pd as { sportlots?: string; bsc?: string | string[] };
  }
  return null;
}

/**
 * NEO-224 — the order every column's rows are listed in, by display name.
 *
 * Names that are ALL digits come first, newest year at the top (2026 above
 * 1995): that is how a collector scans a Years column. Everything else follows
 * in plain alphabetical order. The two groups never interleave, which the old
 * comparator let them do: it compared two numeric names as numbers and any
 * other pair as strings, so the order of a mixed column ("1995-96", "1996",
 * "Unknown") depended on which pairs the sort happened to compare — not a
 * total order at all.
 *
 * `/^\d+$/` rather than `Number(name)`: `Number` accepts "", " ", "1e3" and
 * "0x10", none of which is a year a collector would recognise. A season label
 * such as "1995-96" is text here, so it sorts with the other text, ascending.
 * (Jason, 2026-10-04, D5.)
 *
 * Lead rows (`leadRow`) still go ahead of both groups; that tie-break lives in
 * the memo below because it is per-column, not per-name.
 */
const ALL_DIGITS = /^\d+$/;

export function compareOptionNames(nameA: string, nameB: string): number {
  const numericA = ALL_DIGITS.test(nameA);
  const numericB = ALL_DIGITS.test(nameB);
  if (numericA !== numericB) return numericA ? -1 : 1;
  if (numericA) {
    const byValue = Number(nameB) - Number(nameA);
    // "0995" and "995" are equal as numbers; fall through to the text order
    // so the result is still a total order.
    if (byValue !== 0) return byValue;
  }
  return nameA.localeCompare(nameB);
}

/**
 * NEO-224 — Left/Right across the cascade, from an EMPTY search box only
 * (Jason, D6: with text in the box the arrows move the caret, as in any
 * input).
 *
 * The columns are siblings inside the `[data-set-selector-scroll]` row that
 * `components/modules/SetSelector.tsx` owns, and each OPEN column renders
 * exactly one `role="combobox"` — the contract between that file and this one,
 * held even while a column is loading. So "the next column" is "the next
 * combobox in that row": no prop plumbing, and a collapsed column (which
 * renders its selection card instead) is skipped, which is right — there is
 * nothing to type into there.
 *
 * Deliberately NOT `preventScroll`: unlike a focus park, this is a navigation
 * the operator asked for, and the column they move into needs to be on screen.
 */
function focusAdjacentColumn(
  input: HTMLInputElement | null,
  delta: 1 | -1,
): boolean {
  if (!input) return false;
  const row = input.closest<HTMLElement>("[data-set-selector-scroll]");
  if (!row) return false;
  const boxes = Array.from(
    row.querySelectorAll<HTMLElement>('[role="combobox"]'),
  );
  const here = boxes.indexOf(input);
  if (here < 0) return false;
  const target = boxes[here + delta];
  if (!target) return false;
  target.focus();
  return true;
}

/**
 * NEO-224 — the keyboard highlight ("where Enter lands"), drawn so it reads
 * apart from the committed selection, and on top of it.
 *
 * The selection is a FILL: each column passes its own `selectedColor`
 * (pink sports, blue years, green brands, …). The highlight is therefore never
 * a fill on the selected row — a second background class would fight the
 * column's by stylesheet order, not by intent — but an inset neon stroke that
 * composes with whatever fill is under it. On a row that is not selected it
 * also takes the type-ahead pickers' `#00D558` tint (TeamPicker,
 * PlayerPicker), so the same signal means the same thing across the app.
 *
 * - `ring-inset`, not an outer ring: the listbox is `overflow-y-auto`, which
 *   clips an outer ring on every row's left and right edge (rows are w-full).
 * - Light: emerald-700, because `#00D558` is under 2:1 on white and on the
 *   -100 selection fills; emerald-700 clears 3:1 (WCAG 1.4.11) on all of them.
 *   Dark: the brand neon, which clears 3:1 on every -900 fill and gray-700.
 * - Dark only, a faint inner glow, so the row reads as a lit tube rather than
 *   a boxed one. Static, never animated (NEO-85: nothing moves under a
 *   coordinate-tap driver).
 * - A transparent outline, which Windows High Contrast paints in a system
 *   colour where it drops box-shadows (and so the ring) entirely.
 */
const HIGHLIGHT_STROKE =
  "ring-2 ring-inset ring-emerald-700 dark:ring-[#00D558] dark:shadow-[inset_0_0_14px_rgba(0,213,88,0.28)] outline-2 -outline-offset-2 outline-transparent";
const HIGHLIGHT_TINT =
  "bg-[#00D558]/20 border-emerald-700 dark:border-[#00D558]";
const ROW_IDLE =
  "bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600";

/**
 * NEO-224 — what each column's polite region says about its filter. The
 * listbox changes silently as the operator types; this is the only way a
 * screen-reader user learns that "199" left two rows, or none. Short, so a
 * new count interrupts nothing, and never a bare column heading Maestro could
 * confuse with one. DRAFT copy, awaiting Jason's sign-off.
 */
export const SHOWING_ALL = "Showing all";
export function filterMatchText(count: number): string {
  if (count === 0) return "No matches";
  return count === 1 ? "1 match" : `${count} matches`;
}
/** Long enough that a word typed at speed is counted once, at the end. */
export const FILTER_ANNOUNCE_DELAY_MS = 400;

function EntitySelector({
  title,
  query,
  queryArgs,
  selectedId,
  onSelect,
  expanded,
  setExpanded,
  getDisplayName,
  getDescription,
  selectedColor,
  isItemTerminal,
  pinnedEntries,
  leadRow,
}: EntitySelectorProps) {
  const items = useQuery(query, queryArgs);
  const [searchFilter, setSearchFilter] = useState("");

  // NEO-224 — the column is a COMBOBOX: one search box that keeps DOM focus,
  // and a listbox whose highlighted option is named by
  // `aria-activedescendant`. This replaces NEO-260's roving tabindex.
  //
  // NEO-260 chose roving tabindex because DOM focus on the ROW was the only
  // focus maestro-web's `pressKey` could re-find: it rebuilds an XPath for
  // `document.activeElement` from ancestor class names, and every column's
  // listbox container carries the same class string. That argument does not
  // apply to the search box: the Input primitive stamps a document-unique
  // marker class on it, and this component adds a per-column
  // `mb-search-<slug>` class as well, so an XPath to it resolves to exactly
  // one element. Focus in the box means the operator types to filter and
  // presses Enter to pick without ever leaving it — the keyboard-only drill
  // the cascade was missing (type "base", Enter; type "19", Enter).
  //
  // The highlight is owned by `useComboboxHighlight` (see its header for the
  // rules). Hover deliberately does NOT move it: a pointer resting over the
  // list would otherwise retarget Enter under the operator's typing.
  const baseId = useId();
  // The DOM id `aria-controls` points at. It sits on a wrapper around the
  // listbox, NOT the listbox itself: maestro-web reports an element's
  // resource-id as `node.id || node.ariaLabel`, so an id on the listbox would
  // hide its `aria-label` (the column title) from every `id: "<Title>"`
  // selector — the NEO-313 failure, where a `useId` on a listbox for exactly
  // this attribute turned two flows red.
  const popupId = `${baseId}-popup`;
  const optionDomId = (key: string) => `${popupId}-${key}`;
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const collapsedCardRef = useRef<HTMLButtonElement | null>(null);

  // NEO-237: pinned entries as rows, built once per `pinnedEntries` identity.
  const pinnedItems = useMemo<PinnedItem[]>(
    () =>
      (pinnedEntries ?? []).map((entry) => ({
        _id: entry.id,
        value: entry.name,
        __pinned: entry,
      })),
    [pinnedEntries],
  );
  // The display name of ANY row, pinned or data. Pinned entries carry their
  // own name rather than going through the caller's accessor, which was
  // written for the data rows' shape.
  const nameOf = (item: SelectorItem): string =>
    isPinnedItem(item) ? item.__pinned.name : getDisplayName(item);

  const selected =
    pinnedItems.find((item) => item._id === selectedId) ??
    items?.find((item: SelectorItem) => item._id === selectedId);

  // Sort items by their display names (see `compareOptionNames`). Memoized on
  // `items` (and the `getDisplayName` reader the comparator uses) so an
  // unrelated re-render — e.g. a Convex query invalidation from a sibling
  // column — reuses the same sorted array reference instead of rebuilding it.
  // Rebuilding a fresh array on every render churns the list and reflows the
  // column under Maestro's coordinate taps (NEO-85).
  const sortedItems = useMemo(() => {
    if (!items) return [];
    return [...items].sort((a, b) => {
      // Lead rows first (see `leadRow`); a tie falls through to the name
      // order, so two lead rows — or none — sort exactly as before.
      if (leadRow) {
        const leadA = leadRow(a) ? 0 : 1;
        const leadB = leadRow(b) ? 0 : 1;
        if (leadA !== leadB) return leadA - leadB;
      }
      return compareOptionNames(getDisplayName(a), getDisplayName(b));
    });
  }, [items, getDisplayName, leadRow]);

  const loading = items === undefined;
  const showsCollapsedCard = !!(selectedId && selected && !expanded);

  // Apply the search filter. Pinned entries are never filtered out (they are
  // views, always offered) but they ARE matched, so typing "all" in the
  // Manufacturers column lands the highlight on All Brands.
  const needle = searchFilter.toLowerCase();
  const matches = (item: SelectorItem) =>
    nameOf(item).toLowerCase().includes(needle);
  const filteredItems = searchFilter ? sortedItems.filter(matches) : sortedItems;

  // Every option in DOM order: pinned entries first (never filtered, never
  // sorted), then the data rows.
  const rows: SelectorItem[] =
    pinnedItems.length > 0 ? [...pinnedItems, ...filteredItems] : filteredItems;
  const rowKeys = rows.map((row) => row._id);

  // Re-seed the highlight every time the list is SHOWN (a chip re-expand, a
  // column re-opening), so an arrow move made the last time it was open does
  // not linger. Counted with the "adjust state while rendering" pattern rather
  // than an effect: the new seed then applies in the same render that shows
  // the list, with no frame of the stale highlight.
  const listVisible = !showsCollapsedCard;
  const [shownCount, setShownCount] = useState(0);
  const [wasListVisible, setWasListVisible] = useState(listVisible);
  if (wasListVisible !== listVisible) {
    setWasListVisible(listVisible);
    if (listVisible) setShownCount((n) => n + 1);
  }

  // Where the highlight rests before any arrow press:
  //  - an empty box: the committed selection if it is listed, else the first
  //    row — opening a column puts Enter on what is already chosen;
  //  - typed text: the first row that matches, pinned entries included;
  //  - nothing matches: null, and Enter does nothing (D2: "+ Custom" is one
  //    Tab away and is never opened for the operator).
  const seed: string | null = searchFilter
    ? (rows.find(matches)?._id ?? null)
    : rowKeys.includes(selectedId ?? "")
      ? selectedId
      : (rowKeys[0] ?? null);
  const { highlighted, move } = useComboboxHighlight({
    keys: rowKeys,
    seed,
    seedOn: `${shownCount}\u0000${searchFilter}`,
  });

  // NEO-224 — the filter's result, said in this column's own polite region
  // (rendered beside the search box below). Debounced, so typing "1999" is
  // one announcement and not four; Escape clearing the box says "Showing all"
  // at once (it sets `announced` itself). A filter emptied by Backspace says
  // the same after the pause. A pick says nothing here: the cascade's page
  // region names the column it opened, and this column collapses.
  //
  // The count is the rows that MATCH, pinned entries included: All Brands is
  // always listed, but it is only a match when its name is.
  const [filterCleared, setFilterCleared] = useState(false);
  const [announced, setAnnounced] = useState("");
  const pendingAnnouncement = searchFilter
    ? loading
      ? ""
      : filterMatchText(
          filteredItems.length + pinnedItems.filter(matches).length,
        )
    : filterCleared
      ? SHOWING_ALL
      : "";
  useEffect(() => {
    // Nothing new to say (a column that was never filtered, or Escape having
    // said it already): no timer at all.
    if (pendingAnnouncement === announced) return;
    const timer = setTimeout(
      () => setAnnounced(pendingAnnouncement),
      FILTER_ANNOUNCE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [pendingAnnouncement, announced]);

  // NEO-276 + NEO-224 — the listbox's scroll position, written as `scrollTop`
  // only (see `list-scroll.ts` for why never `scrollIntoView`).
  //
  // ## Open the list AT the selection (NEO-276, `centre`)
  //
  // Re-opening a collapsed column used to mount its listbox scrolled to the
  // top. On any column longer than the 400px fold (a synced Sets column runs to
  // ~40 rows) the selected row was below it, so an operator who opened the
  // list to change their set had to hunt for the row they had already chosen.
  // The selected row is centred, because the neighbours on BOTH sides are what
  // a "change" decision is made against.
  //
  // Exactly once per "list shown": armed when the list goes from not rendered
  // (the collapsed card, or the loading placeholder) to rendered, and consumed
  // the first time the selected row is in the DOM — normally that same commit,
  // else the one where a still-loading `items` lands. A later `items` re-emit
  // or a keystroke never re-arms it, so a list the operator has scrolled stays
  // where they left it. A filter hiding the selected row consumes the latch
  // WITHOUT scrolling: typing the row back into view must not yank the list.
  //
  // ## Keep the highlight in the fold (NEO-224, `nearest`)
  //
  // When the highlight MOVES (an arrow key, or a filter landing it on a new
  // first match) the smallest scroll that shows the whole row, and none when
  // it is already visible. Keyed on the highlighted key changing, so a reactive
  // re-emit or the operator's own wheel scroll is never undone. The centring
  // above counts as having shown the highlight (it IS the selected row then).
  //
  // A layout effect, so the list is already in place on its first paint rather
  // than flashing its top and jumping.
  const listShown = !loading && !showsCollapsedCard;
  const wasListShownRef = useRef(false);
  const centreSelectedRef = useRef(false);
  const scrolledToKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (listShown && !wasListShownRef.current) {
      centreSelectedRef.current = true;
      scrolledToKeyRef.current = null;
    }
    wasListShownRef.current = listShown;
    if (!listShown) {
      centreSelectedRef.current = false;
      return;
    }
    const list = listRef.current;

    if (centreSelectedRef.current) {
      if (!selectedId) {
        centreSelectedRef.current = false;
      } else {
        const row = list?.querySelector<HTMLElement>(
          '[role="option"][aria-selected="true"]',
        );
        if (list && row) {
          centreSelectedRef.current = false;
          scrollRowIntoList(list, row, "centre");
          scrolledToKeyRef.current = selectedId;
        } else if (selected) {
          // The selection IS in `items` but the search box is hiding it —
          // consume, typing must not scroll. Otherwise the id has not arrived
          // in `items` yet; stay armed for the commit it does.
          centreSelectedRef.current = false;
        }
      }
    }

    if (highlighted === scrolledToKeyRef.current) return;
    scrolledToKeyRef.current = highlighted;
    if (!list || highlighted === null) return;
    const domId = optionDomId(highlighted);
    const row = Array.from(list.children).find(
      (child): child is HTMLElement => child.id === domId,
    );
    if (row) scrollRowIntoList(list, row, "nearest");
  });

  // Focus moves this column makes for itself — two, both answering a key the
  // operator pressed IN this column. Where focus goes after a SELECTION is not
  // decided here: the cascade (`components/modules/SetSelector.tsx`) moves it
  // to the next open column's search box, which is why NEO-260's park onto the
  // collapsed card is gone.
  //
  //  1. The selection card was pressed (`expanded` false → true): the list
  //     re-opens, so focus goes into its search box with the selected row
  //     highlighted, ready to arrow or type. Without this it would fall to
  //     <body> when the card unmounted.
  //  2. Escape (or the Collapse control) closed the list: focus goes to the
  //     selection card that replaced it (Jason, D1), so the operator is left
  //     standing where they were rather than at the top of the document.
  //
  // `preventScroll` because EntityColumn owns the horizontal scroll position
  // of the column row and a browser scroll-into-view would pull it back. Both
  // targets sit where the control the operator just pressed was, so neither
  // needs scrolling to.
  const wasExpandedRef = useRef(expanded);
  const focusChipNextRef = useRef(false);
  useLayoutEffect(() => {
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = expanded;
    if (!wasExpanded && expanded && selectedId && !showsCollapsedCard) {
      inputRef.current?.focus({ preventScroll: true });
    }
    if (focusChipNextRef.current && showsCollapsedCard) {
      focusChipNextRef.current = false;
      collapsedCardRef.current?.focus({ preventScroll: true });
    }
  });

  const select = (id: string) => {
    // Re-picking the row that is already selected opens no new column, so the
    // cascade has nowhere to send focus and the row it was on unmounts. It
    // lands on this column's chip instead, as a collapse does. `onSelect`
    // still runs: re-picking Base re-arms its mapping prompt.
    const repick = id === selectedId;
    onSelect(id);
    if (repick) collapseToCard();
    else setExpanded(false);
    setSearchFilter("");
    setFilterCleared(false);
    setAnnounced("");
  };

  const collapseToCard = () => {
    focusChipNextRef.current = true;
    setExpanded(false);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      // No wrap-around (see `useComboboxHighlight`). Cancelled so the caret
      // does not also jump to the start/end of the text.
      case "ArrowDown":
        consume();
        move(1);
        return;
      case "ArrowUp":
        consume();
        move(-1);
        return;
      case "Enter":
        // D2: with nothing highlighted (no match) Enter is a no-op, and it is
        // left uncancelled so it means exactly what it would anywhere else.
        if (highlighted === null) return;
        consume();
        select(highlighted);
        return;
      case "Escape":
        // D1, in order: clear the typed filter (the highlight re-seeds with
        // it); else close a column that has a selection back to its card;
        // else nothing, and the key is left for whoever else wants it.
        if (searchFilter) {
          consume();
          setSearchFilter("");
          // Said at once, not after the typing debounce: the key was one
          // deliberate press, and the whole list is back.
          setFilterCleared(true);
          setAnnounced(SHOWING_ALL);
          return;
        }
        if (selectedId && selected && expanded) {
          consume();
          collapseToCard();
        }
        return;
      case "ArrowLeft":
      case "ArrowRight":
        // D6: only from an EMPTY box; with text in it the arrows move the
        // caret, as in any input.
        if (searchFilter) return;
        if (
          focusAdjacentColumn(
            inputRef.current,
            event.key === "ArrowRight" ? 1 : -1,
          )
        ) {
          consume();
        }
        return;
      default:
        return;
    }
  };

  if (showsCollapsedCard && selected) {
    // NEO-260 — a real <button>, not a clickable <div>.
    //
    // Once a column has a selection it collapses to this single card, and
    // re-opening it is the ONLY way to change that selection. As a <div> it was
    // unreachable by Tab, so a keyboard-only operator who picked the wrong
    // sport could not get back to the list — the cascade was one-way. It also
    // drops the column's <h2>, so the accessible name has to carry the column
    // ("Sports: Baseball — change"); the visible name is inside it, which is
    // what WCAG 2.5.3 asks and what keeps a voice-control "click Baseball"
    // working. `aria-expanded` states what pressing it does.
    return (
      <button
        ref={collapsedCardRef}
        type="button"
        className="w-full text-left bg-white dark:bg-gray-800 p-6 rounded-lg shadow flex items-center justify-between cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
        aria-label={`${title}: ${nameOf(selected)} — change`}
        aria-expanded={false}
        onClick={() => setExpanded(true)}
        onKeyDown={(e) => activateOnEnter(e, () => setExpanded(true))}
      >
        <div className="flex items-center gap-2">
          <div className="font-semibold">{nameOf(selected)}</div>
        </div>
        <ChevronDownIcon className="w-5 h-5 text-gray-500" />
      </button>
    );
  }

  // The empty-state line. With pinned entries the listbox still renders (the
  // view is always a choice), and this line sits UNDER it — outside the
  // listbox, so the listbox's children stay options and nothing else — where
  // a column with no data rows still says so. Same two strings as before:
  // the cold-drill utils wait on the second one.
  const emptyText = searchFilter
    ? "No matches found"
    : `No ${title.toLowerCase()} available. Sync from marketplaces to populate.`;

  // ONE return for the loading and the loaded column, so the search box is the
  // SAME element across the moment `items` lands. Focus the cascade put in it
  // while the read was in flight — and whatever the operator had typed — stays
  // put, and the filter simply applies once there are rows to filter.
  return (
    <div
      className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow"
      aria-busy={loading ? "true" : undefined}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        {selectedId && expanded && (
          <button
            type="button"
            onClick={collapseToCard}
            onKeyDown={(e) => activateOnEnter(e, collapseToCard)}
            // Named per column. Every open column with a selection renders one
            // of these, so a bare "Collapse" is neither distinguishable to a
            // screen-reader user moving across the cascade nor unambiguous as a
            // Maestro `resource-id` (matched as an UNANCHORED regex, so a bare
            // "Collapse" also finds "Collapse matched cards…" elsewhere).
            aria-label={`Collapse ${title.toLowerCase()}`}
            aria-expanded={true}
            // a11y (2.5.8): `p-2 -m-2` grows the 20px chevron's hit area to
            // 36px without moving it or the heading beside it.
            className="p-2 -m-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] rounded"
          >
            <ChevronUpIcon className="w-5 h-5 text-gray-500" />
          </button>
        )}
      </div>
      {/* NEO-224 — rendered in EVERY open column, loading included, and no
          longer only past eight rows: it is the column's single Tab stop and
          the thing the cascade focuses, and on a short column it is still how
          a keyboard operator picks ("bas", Enter). Exactly one combobox per
          open column is the contract `SetSelector.tsx` relies on.

          The aria-label and placeholder strings are byte-identical to the
          pre-NEO-224 box: ~40 flows target `id: "Search years"` and
          `text: ".*Search sets.*"`. The Input primitive never emits a DOM id,
          which keeps that aria-label the box's resource-id. */}
      <Input
        bare
        ref={inputRef}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!loading && rows.length > 0}
        aria-controls={loading ? undefined : popupId}
        aria-activedescendant={
          highlighted !== null && !loading ? optionDomId(highlighted) : undefined
        }
        autoComplete="off"
        spellCheck={false}
        value={searchFilter}
        onChange={(e) => {
          const next = e.target.value;
          setFilterCleared(next === "" && searchFilter !== "");
          setSearchFilter(next);
        }}
        onKeyDown={onSearchKeyDown}
        // Unique per-column class (mb-search-<slug>) so Maestro web's
        // inputText targets THIS column's box. When two columns are open,
        // every search box otherwise shares one className; Maestro's
        // createXPathFromElement builds a non-unique class XPath and types into
        // the FIRST box on the page instead of the tapped one (NEO-46:
        // pg-suggestions-0 was typed into Sports → "No matches found"; Sets
        // never filtered). Same fix class as the mb-field-<slug> inputs.
        // aria-label alone doesn't help — inputText keys off className.
        className={`mb-search-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")} w-full p-2 mb-3 text-sm`}
        placeholder={`Search ${title.toLowerCase()}...`}
        aria-label={`Search ${title.toLowerCase()}`}
      />
      {/* NEO-224 — the filter's result (see `announced`). Always mounted, so
          the first count is a CHANGE a screen reader reports; `sr-only` is
          position:absolute, so it costs the fold-sensitive column nothing.
          One per open column, beside its own search box: the cascade's page
          region outside the row names columns, this one counts rows. */}
      <p className="sr-only" role="status">
        {announced}
      </p>
      {loading ? (
        // NEO-167 — keep the heading on screen while the read is in flight.
        //
        // This used to be `return <div>Loading {title}...</div>`, which removed
        // the column's identity text from the DOM for as long as
        // `getSelectorOptions` took. Maestro matches a selector as a
        // FULL-STRING regex, so `visible: "Variant Types"` cannot match
        // "Loading variant types…" — every flow asserting on a column heading
        // failed outright on a slow read (CI run 31839119469).
        //
        // SCOPE IS LOAD-BEARING. The heading is absent in TWO situations and
        // only the second is the defect:
        //   1. Column not open — EntityColumn returns null on `!isVisible`, so
        //      this component never renders. Flows rely on that: they use
        //      heading visibility to detect that a selection opened the NEXT
        //      column (`when: notVisible: "Manufacturers"`). That still works,
        //      because this branch is only reachable once the column is mounted.
        //   2. Column open, read in flight — here.
        // Do not "simplify" this by lifting the heading above the `isVisible`
        // gate; that would make every guard in (1) permanently false.
        //
        // EXACTLY ONE placeholder row. Keep it that way. The columns sit ABOVE
        // the card checklist, so every pixel added here pushes the checklist
        // down in a 625px headless viewport: a five-row skeleton put "Fetch
        // from Marketplaces" at y=620..652 (15.6% visible against a required
        // 50%), and the seed flow failed with a CDP error that reads like a
        // driver bug and is really a layout bug (NEO-47, NEO-155: height above
        // a fold-sensitive control is never free). Deliberately NOT animated:
        // an infinite animation on a screen a coordinate-tap driver works on is
        // the movement NEO-85 removed, and static is the better reduced-motion
        // default.
        //
        // NEO-224: decorative, not a live region. A nested `role="status"`
        // here was a second polite region per loading column, announcing
        // nothing useful on top of the card's `aria-busy` and the cascade's
        // own page region. With the role gone, an `aria-label` on this plain
        // div would be a prohibited attribute, so it went too.
        <div className="space-y-2" aria-hidden="true">
          <div className="h-[50px] rounded-md border border-gray-200 dark:border-gray-600 bg-gray-100 dark:bg-gray-700" />
        </div>
      ) : (
        // The `aria-controls` target (see `popupId`): a plain wrapper with no
        // class and no name, always rendered once the column has loaded so the
        // reference never dangles.
        //
        // A DELIBERATE departure from the APG combobox, which points
        // `aria-controls` at the listbox itself. maestro-web reports an
        // element's resource-id as `node.id || node.ariaLabel`, so a DOM id on
        // the listbox would shadow its aria-label (the column title) and break
        // every `id: "<Title>"` selector (NEO-313). The wrapper holds the
        // listbox and only the listbox (or the empty line), so the reference
        // still lands on the popup.
        <div id={popupId}>
          {rows.length === 0 ? (
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              <div className="text-sm text-gray-500 dark:text-gray-400 py-2">
                {emptyText}
              </div>
            </div>
          ) : (
            <div
              ref={listRef}
              // The list of choices IS a listbox, named with the column title
              // (the same string the <h2> above already shows). Same class
              // string as before NEO-224: Maestro reads a view hierarchy off
              // this DOM and ~105 flows target these rows.
              role="listbox"
              aria-label={title}
              className="space-y-2 max-h-[400px] overflow-y-auto"
            >
              {rows.map((item: SelectorItem) => {
                const pinned = isPinnedItem(item) ? item.__pinned : null;
                const pd = pinned ? null : getPlatformData(item);
                const showPills = pinned
                  ? false
                  : (isItemTerminal?.(item) ?? false);
                const isSelected = selectedId === item._id;
                const isHighlighted = highlighted === item._id;
                const pick = () => select(item._id);
                return (
                  <button
                    key={item._id}
                    // The `aria-activedescendant` target. NOTE for flows: a DOM
                    // id becomes maestro-web's resource-id ahead of the
                    // aria-label, so the pinned entry is no longer reachable
                    // as `id: "All Brands — every set in …"`.
                    id={optionDomId(item._id)}
                    type="button"
                    // NEO-237: a pinned VIEW carries its full accessible name —
                    // it says what the view shows, not just what it is called —
                    // and the name is still its visible text. Data rows carry
                    // none: their visible text is the whole name.
                    aria-label={pinned?.ariaLabel}
                    // `option`, not the implicit `button`: these are the
                    // mutually exclusive choices of one column.
                    // `aria-selected` is the COMMITTED row; the keyboard
                    // highlight is carried by the search box's
                    // `aria-activedescendant` alone.
                    role="option"
                    aria-selected={isSelected}
                    // Never a Tab stop: the search box is the column's one stop
                    // and the arrows move the highlight from there.
                    tabIndex={-1}
                    onClick={pick}
                    // A synthetic KeyboardEvent has no default action, so a
                    // focused row is NOT clicked by `pressKey: Enter`. Rows are
                    // not focusable by key any more, but a pointer press can
                    // still focus one; Enter there picks it, once.
                    onKeyDown={(e) => activateOnEnter(e, pick)}
                    className={`w-full text-left p-3 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] ${
                      isSelected
                        ? selectedColor
                        : isHighlighted
                          ? HIGHLIGHT_TINT
                          : ROW_IDLE
                    }${isHighlighted ? ` ${HIGHLIGHT_STROKE}` : ""}${
                      // A pinned view is a lens on the column, not one of its
                      // rows: the same row geometry with a rail in the accent
                      // blue down its left edge — the one colour the cascade
                      // does not already spend on a state.
                      pinned ? " border-l-4 border-l-[#00C2FF]" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{nameOf(item)}</span>
                      {showPills && pd?.sportlots && (
                        <span className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                          SL
                        </span>
                      )}
                      {showPills && pd?.bsc && (
                        <span className="text-xs px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">
                          BSC
                        </span>
                      )}
                    </div>
                    {pinned?.description && (
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        {pinned.description}
                      </div>
                    )}
                    {!pinned && getDescription && getDescription(item) && (
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        {getDescription(item)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {!loading && rows.length > 0 && filteredItems.length === 0 && (
        // Pinned entries only: the view is listed, the data rows are not.
        <div className="text-sm text-gray-500 dark:text-gray-400 py-2">
          {emptyText}
        </div>
      )}
    </div>
  );
}

// NEO-85: memoized so a parent re-render that recreates this element with
// referentially-stable props does NOT re-render the whole column — and re-run
// the sort/filter + rebuild every row button. A gratuitously re-rendered list
// churns the DOM subtree Maestro's hierarchyBasedTap reads mid-tap, feeding the
// coordinate-staleness dropped-tap class (the Variant Types "Base" flake).
// Effective only where the wrapper passes stable props (see SetVariantSelector);
// columns still passing inline props re-render exactly as before (shallow prop
// compare simply never matches for them — no behavior change either way).
export default memo(EntitySelector);
