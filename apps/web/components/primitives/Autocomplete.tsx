import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "./Input";

/**
 * NEO-147 — the app's shared ARIA combobox.
 *
 * There were four bespoke typeaheads before this one (SetSelector's
 * `PlayerPicker`, `TeamPicker`, `EntityLinkSearch` and `CareerTeamEntry`), each
 * re-solving keyboard handling and ARIA wiring, and each fetching up to 500
 * rows to filter client-side with `.includes()`. This primitive owns the
 * interaction half of that duplication; the data half is the caller's, which is
 * what lets a server-backed caller like {@link PlayerAutocomplete} exist
 * without this component knowing anything about Convex.
 *
 * Migrating those four call sites is deliberately NOT part of NEO-147 — they
 * work, and each carries its own commit/creation semantics. The generic
 * `items` + `getKey`/`getLabel` shape here is what makes that migration
 * possible later.
 *
 * ## ARIA
 * Implements the ARIA 1.2 combobox pattern properly, which
 * `CareerTeamEntry` (the best of the four, and the model for this) only
 * partially did: it had `role="combobox"` and `aria-autocomplete="list"` but no
 * `aria-controls` and no `aria-activedescendant`, so a screen reader announced
 * that a listbox existed without ever announcing which option was highlighted
 * as the user arrowed through it. Both are wired here, and the options are
 * `<li role="option">` rather than nested `<button>`s — a button inside an
 * option is not a valid child of a listbox and made the arrow-key focus model
 * ambiguous.
 *
 * ## Layer (NEO-307)
 * The open list is `position: fixed`, anchored to the field (below it, or
 * above when there is not room below), and PORTALLED into the nearest
 * `role="dialog"` around the field — `<body>` when there is none.
 *
 * It used to be `absolute` under the field, which a scrolling ancestor clips.
 * CI caught it at 1024x629: in NewTeamDialog the League field sits near the
 * bottom of an `overflow-y-auto` body, the list ran on under the pinned footer,
 * and a tap on "No league" (always last) landed on the footer instead. Only the
 * HIGHLIGHTED option was ever scrolled into view, so everything under it was
 * cut off for every operator, not only for the driver. Scrolling the list into
 * view on open was the cheaper fix and was rejected: it moves the page under a
 * keyboard user who only focused a field, it cannot help when the body has no
 * scroll left, and it does nothing for the next host that clips.
 *
 * Why the DIALOG, not `<body>`: `inertBackground` makes every body child but
 * the open modal inert, so a list portalled to `<body>` from inside a modal
 * would be inert — untappable and out of the tree. Inside the dialog's own
 * subtree it is live whenever the dialog is, and a fixed element there is not
 * clipped by the panel's overflow (the dialog roots here are full-viewport
 * overlays with no transform). The ids, `aria-controls` and
 * `aria-activedescendant` are unchanged: they are document-wide.
 *
 * ## Keyboard
 * Arrow keys move the highlight, Enter confirms, Escape cancels — the
 * behaviour the rest of the app is held to. Escape is swallowed ONLY while the
 * list is open, so a host dialog's own Escape-to-close still works when it is
 * not; that carry-over from `CareerTeamEntry` is load-bearing and easy to lose.
 */

/**
 * NEO-307 — the attribute a quiet focus sets for the length of one `.focus()`.
 * Read by the combobox's own `onFocus`; see {@link focusWithoutOpening}.
 */
const QUIET_FOCUS_ATTR = "data-quiet-focus";

/**
 * NEO-307 — move focus to an element WITHOUT opening a combobox's list.
 *
 * A picker-mode combobox opens on focus (`openOnEmpty`), which is right for a
 * person tabbing or clicking in, and wrong for code handing focus BACK — after
 * "Add league", after a sub-form's Cancel, when a dialog restores its opener.
 * CI and a local run both found the cost: the list opened by a focus return
 * floated over NewTeamDialog's footer, the operator's next click on "Create
 * team" landed on "No league", and the league they had just added was thrown
 * away. Every programmatic focus that can land on a combobox goes through here.
 *
 * Safe on any element: on one that is not a combobox the attribute is
 * meaningless and removed again at once. `focus()` dispatches `focus`
 * synchronously, so the flag is set exactly for the handler it is meant for.
 */
export function focusWithoutOpening(
  el: HTMLElement | null | undefined,
  options?: FocusOptions,
): void {
  if (!el) return;
  el.setAttribute(QUIET_FOCUS_ATTR, "");
  try {
    el.focus(options);
  } finally {
    el.removeAttribute(QUIET_FOCUS_ATTR);
  }
}

export interface AutocompleteProps<T> {
  /** Current text in the field. Controlled — the caller owns the query. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Results to offer. The caller decides how these are produced. */
  items: T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  /** Optional secondary line, e.g. a player's sport or a team's league. */
  getDescription?: (item: T) => string | undefined;
  onSelect: (item: T) => void;
  /** Accessible name for the input. Also the Maestro selector for it. */
  label: string;
  placeholder?: string;
  /** Shown in place of the list when a search is in flight. */
  loading?: boolean;
  /** Shown when a non-empty query produced nothing. */
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  /**
   * NEO-307 — show the list on focus even with nothing typed.
   *
   * Off by default: a SEARCH over an unbounded table (players) has nothing to
   * show until there is a query. On for a bounded PICKER (a sport's leagues),
   * where the whole set is the useful first view and typing only narrows it.
   */
  openOnEmpty?: boolean;
  /**
   * NEO-307 — the item that is the field's current answer, by `getKey`.
   *
   * Opening the list puts the highlight on it rather than on row 0, so Enter
   * on a freshly-focused field re-confirms what is already chosen instead of
   * silently swapping it for whatever sorts first. It is also marked with a
   * check, so the answer is findable in a long list.
   */
  selectedKey?: string;
  /**
   * NEO-307 — the list closed without a pick (blur, or Escape while open).
   * A caller showing its current answer in the field uses this to put that
   * answer's label back after the operator typed and walked away.
   */
  onDismiss?: () => void;
  /**
   * NEO-307 — select the field's text on focus, so typing REPLACES a label the
   * field is displaying rather than appending to it.
   */
  selectOnFocus?: boolean;
  /**
   * Height cap for the list, as a whole Tailwind class. Replaced rather than
   * appended: Tailwind resolves two `max-h-*` utilities by stylesheet order,
   * not by the order they appear in the string.
   */
  listMaxHeightClassName?: string;
  /**
   * The input's padding and font size, as whole Tailwind classes. Replaced
   * rather than appended to `inputClassName`, for the same stylesheet-order
   * reason as `listMaxHeightClassName`: a caller dropping this into a form of
   * compact `p-1.5 text-sm` fields cannot out-rank `px-3 py-2 text-base`.
   */
  inputGeometryClassName?: string;
  /**
   * NEO-307 — put `getDescription`'s text on its own line under the label
   * instead of beside it. For rows whose second fact is what tells two of
   * them apart (five "Dodgers": league and years), where a trailing inline
   * note is the first thing a narrow list truncates or wraps mid-phrase. The
   * label stays the option's only direct text node either way.
   */
  descriptionBelow?: boolean;
  /**
   * NEO-307 — keep the list shut while there is nothing in it and nothing on
   * its way, instead of showing `emptyMessage`. For a field that opens
   * pre-filled with a proposal rather than with a search: "No matches" under a
   * query the operator never typed answers a question nobody asked. The caller
   * turns it off once the operator types, so a real search that finds nothing
   * still says so.
   */
  hideWhenEmpty?: boolean;
}

export function Autocomplete<T>({
  query,
  onQueryChange,
  items,
  getKey,
  getLabel,
  getDescription,
  onSelect,
  label,
  placeholder,
  loading = false,
  emptyMessage = "No matches",
  disabled = false,
  className = "",
  inputClassName = "",
  openOnEmpty = false,
  selectedKey,
  onDismiss,
  selectOnFocus = false,
  listMaxHeightClassName = "max-h-60",
  inputGeometryClassName = "px-3 py-2 text-base",
  descriptionBelow = false,
  hideWhenEmpty = false,
}: AutocompleteProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * NEO-307 — where the open list is rendered: the nearest `role="dialog"`
   * around the field, or `<body>` when there is none. See "Layer" in the
   * module doc. Captured when the list OPENS, from the event's own element,
   * rather than read off a ref during render.
   */
  const [layer, setLayer] = useState<Element | null>(null);
  const openFrom = (el: Element) => {
    setLayer(el.closest('[role="dialog"]') ?? el.ownerDocument.body);
    setOpen(true);
  };
  const listRef = useRef<HTMLUListElement>(null);
  /** Set by a focus, consumed by the mouseup that follows a click-to-focus —
   *  see `selectOnFocus`. */
  const justFocusedRef = useRef(false);
  const listboxId = useId();

  // The highlight indexes into `items`, so it has to reset when the results
  // change. Without that, arrowing to row 8 of a long list and then typing
  // another character leaves the highlight past the end of the new (shorter)
  // list, and Enter selects nothing.
  //
  // Keyed on the CONTENT of `items`, not its identity. A caller that builds
  // the array inline — `items={all.filter(...)}`, which is the natural way to
  // write it — produces a new array on every render, so an identity check
  // would reset the highlight on the very re-render that moving the highlight
  // causes, and arrow keys would appear completely dead.
  //
  // Done during render rather than in an effect: this is React's documented
  // "adjusting state when props change" pattern, it avoids the extra render
  // pass an effect costs, and `react-hooks/set-state-in-effect` correctly
  // rejects the effect form.
  const signature = items.map(getKey).join(" ");
  const [prevSignature, setPrevSignature] = useState(signature);
  if (signature !== prevSignature) {
    setPrevSignature(signature);
    setHighlightIdx(0);
  }

  // Close on an outside click. A combobox left open over other controls
  // swallows the next click, which reads as the UI ignoring input.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The list is portalled out of the container, so a press inside IT (on
      // its scrollbar, say) is not an outside click.
      if (
        !containerRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const hasResults = items.length > 0;
  // The popup is also shown for the loading and empty states, so the user gets
  // "searching…" / "no matches" rather than a silently absent list.
  const showPopup =
    open &&
    (openOnEmpty || query.trim().length > 0) &&
    !(hideWhenEmpty && !hasResults && !loading);
  const activeId = hasResults ? `${listboxId}-opt-${highlightIdx}` : undefined;

  // Keep the highlighted row on screen as the arrows walk a list longer than
  // its height cap. Without this the highlight scrolls out of the box and a
  // sighted keyboard user is steering blind. `nearest` so a row already in
  // view does not jump. Optional-called: happy-dom has no layout.
  useEffect(() => {
    if (!showPopup || !hasResults) return;
    const option = listRef.current?.querySelector<HTMLElement>(
      `[id="${listboxId}-opt-${highlightIdx}"]`,
    );
    option?.scrollIntoView?.({ block: "nearest" });
  }, [showPopup, hasResults, highlightIdx, listboxId]);

  /*
   * NEO-307 — anchor the fixed-position list to the field, below it or,
   * when there is not room for it there, above.
   *
   * Written straight to the list's style in a layout effect (before paint, so
   * it never flashes at 0,0) rather than through state: it is geometry the
   * browser owns, re-measured on every scroll and resize while open, and a
   * render per scroll event would be pure cost.
   *
   * The height cap is whatever `listMaxHeightClassName` resolves to, read
   * back from the computed style with the inline value cleared, so a caller's
   * cap stays the cap; the list only ever SHRINKS below it, to fit the room
   * on the side it opened. 240px when no stylesheet answers (tests).
   */
  useLayoutEffect(() => {
    if (!showPopup) return;
    const place = () => {
      const list = listRef.current;
      const field = inputRef.current;
      if (!list || !field) return;
      const rect = field.getBoundingClientRect();
      const viewport = window.innerHeight;
      /*
       * Room is measured inside the field's nearest SCROLLING ancestor (a
       * dialog body), not only the viewport, so the list opens on the side
       * where it stays inside that body and never covers a pinned footer
       * beside it — a list over "Create team" is a list that eats the click
       * meant for it. Falls back to the viewport when the body leaves too
       * little room on both sides to be worth honouring.
       */
      let boundTop = 0;
      let boundBottom = viewport;
      for (let el = field.parentElement; el; el = el.parentElement) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden") {
          const box = el.getBoundingClientRect();
          boundTop = Math.max(0, box.top);
          boundBottom = Math.min(viewport, box.bottom);
          break;
        }
      }
      list.style.maxHeight = "";
      const capped = Number.parseFloat(getComputedStyle(list).maxHeight);
      const cap = Number.isFinite(capped) ? capped : 240;
      const wanted = Math.min(cap, list.scrollHeight || cap);
      const gap = 4;
      const margin = 8;
      const MIN_USEFUL = 96;
      let below = boundBottom - rect.bottom - gap - margin;
      let above = rect.top - boundTop - gap - margin;
      if (Math.max(below, above) < Math.min(wanted, MIN_USEFUL)) {
        below = viewport - rect.bottom - gap - margin;
        above = rect.top - gap - margin;
      }
      const flip = below < wanted && above > below;
      list.style.left = `${rect.left}px`;
      list.style.width = `${rect.width}px`;
      if (flip) {
        list.style.top = "";
        list.style.bottom = `${viewport - rect.top + gap}px`;
      } else {
        list.style.bottom = "";
        list.style.top = `${rect.bottom + gap}px`;
      }
      list.dataset.placement = flip ? "top" : "bottom";
      list.style.maxHeight = `${Math.max(0, Math.min(cap, flip ? above : below))}px`;
    };
    place();
    // Capture: `scroll` does not bubble, and the ancestor that scrolls (a
    // dialog body) is not known here.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [showPopup, signature, layer]);

  const select = (item: T) => {
    onSelect(item);
    setOpen(false);
  };

  /** Close without a pick, and tell the caller. Idempotent for the caller: a
   *  blur after a pick reports a dismissal of a list that was already shut. */
  const dismiss = () => {
    setOpen(false);
    onDismiss?.();
  };

  const selectedIdx =
    selectedKey === undefined
      ? -1
      : items.findIndex((item) => getKey(item) === selectedKey);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <Input
        bare
        ref={inputRef}
        type="text"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        // Tracks whether the POPUP is displayed, not whether it has results.
        // The loading and empty states render a real listbox containing a
        // disabled option, so reporting "collapsed" there would tell a screen
        // reader nothing is shown while sighted users are looking at "No
        // matches" — and it contradicts the `aria-controls` element being in
        // the accessibility tree. ARIA 1.2 defines it as popup visibility.
        aria-expanded={showPopup}
        aria-autocomplete="list"
        // Only while the listbox is in the DOM. An IDREF to an element that
        // does not exist is an invalid reference (ARIA 1.2 lets a collapsed
        // combobox omit aria-controls), and some AT reads a dangling one as
        // "controls nothing". Conditional rather than an always-rendered
        // hidden <ul>, so the collapsed DOM stays exactly what flows see.
        aria-controls={showPopup ? listboxId : undefined}
        aria-activedescendant={showPopup ? activeId : undefined}
        autoComplete="off"
        onChange={(e) => {
          onQueryChange(e.target.value);
          openFrom(e.currentTarget);
        }}
        onFocus={(e) => {
          // A focus handed back by code (`focusWithoutOpening`) never opens
          // the list — only a person tabbing, clicking or typing does. The
          // text is still selected, so typing replaces the label.
          const quiet = e.currentTarget.hasAttribute(QUIET_FOCUS_ATTR);
          if (!quiet) openFrom(e.currentTarget);
          // Open on the current answer, not on row 0 — see `selectedKey`.
          if (selectedIdx !== -1) setHighlightIdx(selectedIdx);
          if (selectOnFocus) {
            e.currentTarget.select();
            // Only a pointer focus is followed by the mouseup this guards.
            justFocusedRef.current = !quiet;
          }
        }}
        // A click on a field that already has focus fires no focus event, so
        // after a pick (the list closes, focus stays) clicking the field again
        // would do nothing. Reopen on click too.
        onClick={(e) => openFrom(e.currentTarget)}
        onMouseUp={(e) => {
          // A click-to-focus runs focus (which selects) and THEN mouseup, and
          // the mouseup's default is to drop a caret where the pointer is —
          // throwing the selection away. Cancel only that first mouseup, so a
          // later click inside the text still places the caret normally.
          if (justFocusedRef.current) {
            justFocusedRef.current = false;
            e.preventDefault();
          }
        }}
        onBlur={() => {
          justFocusedRef.current = false;
          dismiss();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openFrom(e.currentTarget);
            setHighlightIdx((i) => (hasResults ? Math.min(i + 1, items.length - 1) : 0));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Home" && showPopup) {
            e.preventDefault();
            setHighlightIdx(0);
          } else if (e.key === "End" && showPopup) {
            e.preventDefault();
            setHighlightIdx(Math.max(items.length - 1, 0));
          } else if (e.key === "Enter") {
            // Never let Enter bubble to a host form's submit or a dialog's
            // confirm shortcut while a suggestion is highlighted.
            if (showPopup && hasResults) {
              e.preventDefault();
              select(items[highlightIdx]);
            }
          } else if (e.key === "Escape") {
            // Swallow Escape only while the list is open, so a host dialog's
            // Escape-to-cancel still works when it is not.
            if (showPopup) {
              e.preventDefault();
              e.stopPropagation();
              dismiss();
            }
          }
        }}
        // `bare` Input supplies NO geometry — that is its contract, so the
        // caller can drop it into existing markup. This component IS the
        // standalone control, so it has to supply the same geometry the
        // non-bare Input would (`px-3 py-2 text-base`). Without it the
        // placeholder sits flush against the border and the field is shorter
        // than every select beside it.
        className={`w-full ${inputGeometryClassName} ${inputClassName}`}
      />

      {showPopup && layer && createPortal(
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={`${label} suggestions`}
          // A press on the list itself (its scrollbar, its padding) must not
          // blur the field: blur dismisses, and the list would vanish under
          // the pointer. Options already do this for the same reason.
          onMouseDown={(e) => e.preventDefault()}
          className={`fixed z-[70] ${listMaxHeightClassName} overflow-y-auto rounded-md border border-gray-700 bg-gray-900 shadow-lg`}
        >
          {!hasResults && (
            // role="option" + aria-disabled, NOT role="presentation": per the
            // ARIA "Presentational Roles Conflict Resolution" rule, a global
            // property like aria-live on a role="presentation" element forces
            // the browser to ignore the presentational role and fall back to
            // implicit semantics instead — which, inside a ul[role=listbox],
            // is undefined/inconsistent across browsers, so the announcement
            // was not reliable. A disabled option is valid listbox content and
            // keeps aria-live's announcement behaviour intact.
            //
            // aria-live so the outcome of a search is announced rather than
            // only rendered — the input keeps focus throughout.
            <li
              role="option"
              aria-disabled="true"
              aria-selected={false}
              aria-live="polite"
              className="px-3 py-2 text-sm text-gray-400"
            >
              {loading ? "Searching…" : emptyMessage}
            </li>
          )}
          {items.map((item, idx) => {
            const description = getDescription?.(item);
            const isCurrent = idx === selectedIdx;
            return (
              <li
                key={getKey(item)}
                id={`${listboxId}-opt-${idx}`}
                role="option"
                aria-selected={idx === highlightIdx}
                onMouseEnter={() => setHighlightIdx(idx)}
                // onMouseDown, not onClick: the input's blur fires first on a
                // click and would close the list before the click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(item);
                }}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  idx === highlightIdx
                    ? "bg-[#00D558]/20 text-[#00D558]"
                    : "text-gray-200 hover:bg-gray-800"
                }`}
              >
                {selectedKey !== undefined && (
                  /* The current answer's mark. A fixed-width slot on EVERY
                     row, so labels stay aligned whether or not they carry it.
                     aria-hidden: the combobox's own value already announces
                     the answer, and the glyph must not join the option's
                     accessible name or its text (the label is the option's
                     only direct text node, which is what a flow matches). */
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block w-3 text-[#00D558]"
                  >
                    {isCurrent ? "✓" : ""}
                  </span>
                )}
                {getLabel(item)}
                {description && (
                  <span
                    // `pl-5` = the check slot's `w-3 mr-2`, so a line under
                    // the label starts under the label and not under the mark.
                    className={`${
                      descriptionBelow
                        ? `block mt-0.5 ${selectedKey !== undefined ? "pl-5" : ""}`
                        : "ml-2"
                    } text-xs text-gray-400`}
                  >
                    {description}
                  </span>
                )}
              </li>
            );
          })}
        </ul>,
        layer,
      )}
    </div>
  );
}
