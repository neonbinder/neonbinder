import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";

/**
 * NEO-272 — the typeahead popover `TeamPicker` and `PlayerPicker` hang off
 * their "+ Add" trigger, portalled out of whatever is clipping it.
 *
 * ## Why this exists
 *
 * Both popovers were `absolute left-0 top-full mt-1 z-10` inside the picker's
 * own `relative` wrapper. `overflow: auto` establishes a clip box whether or
 * not a scrollbar is showing, so ANY scrolling ancestor cut the list off at
 * its own edge — and three of the five hosts are exactly that:
 * `CardAttentionWalker`'s `overflow-y-auto` body (where `MissingTeamFixer` and
 * `UnreviewedNameFixer` live) and `CardDetailPanel`'s `flex-1 overflow-y-auto`
 * drawer body. `NewTeamDialog`'s own docstring names this bug from the other
 * side — it is portalled for the same reason, and NEO-236's `scrollIntoView`
 * workaround was the earlier, worse answer to it.
 *
 * A portal to `document.body` has no clipping ancestor at all, which is why
 * every dialog in this directory uses one. `<Theme>` inside the portal for the
 * same reason they all need one: a portal escapes the root Theme's CSS scope,
 * and the popover inherits its font from it.
 *
 * ## Position: below the trigger when it fits, and always inside the viewport
 *
 * The default is unchanged: `top: rect.bottom / left: rect.left` reproduces
 * `top-full left-0`, and `mt-1` stays on the element so the 4px gap is
 * declared rather than computed.
 *
 * NEO-341 removed the old "no flip, no clamp" rule. A `fixed` element cannot be
 * scrolled into view, so a trigger near the bottom of the viewport ("+ Add
 * player" at y≈617 in the 629px-tall E2E window, or most of the card drawer on
 * a 412px phone) opened a list nobody could reach: Playwright refused the
 * click as "outside of the viewport", and a person could not scroll to it
 * either. `placePopover` now decides, every time it measures:
 *  - **Below** when the whole popover fits under the trigger.
 *  - **Above** when it does not fit below but fits above, or when neither side
 *    fits and above has more room. It is pinned by `bottom` (and `mb-1`), so
 *    a list that shrinks as the operator types stays attached to the trigger.
 *  - **Sticky**: once above, it stays above while it still fits there. Typing
 *    narrows the list, and a box that jumped back below on every keystroke
 *    would move under the cursor.
 *  - **Clamped** when it fits on neither side: `max-height` is the room on the
 *    chosen side and the popover scrolls inside itself. `overflow-y` is set
 *    ONLY then, because an overflow box clips, and `SportSwitch` hangs its
 *    own absolute list off the popover's footer.
 *  - **Horizontally**, `left` is clamped so the box keeps an 8px gutter from
 *    both edges, and `max-width` keeps it inside a viewport narrower than the
 *    box.
 * While the popover scrolls, the ArrowDown row (`aria-selected`, or the
 * create row's `aria-current`) is kept in view, because focus stays in the
 * search box and the browser would not scroll for it.
 *
 * ## Following the trigger
 *
 * Four things move it, and all four are covered:
 *  - an ancestor scrolling — `scroll` is listened for in the CAPTURE phase on
 *    `window`, which is the only way to hear a scroll on an inner element
 *    (scroll events do not bubble, but they do capture);
 *  - the window resizing;
 *  - the trigger itself moving with no scroll and no resize, which is the
 *    common one: adding a chip reflows the picker's own chip row and pushes
 *    "+ Add team" along. That is why the measurement runs after EVERY commit
 *    rather than only from the two listeners. It is one `getBoundingClientRect`
 *    and a shallow compare, and it no-ops when nothing moved;
 *  - the popover's own content changing height inside a child that keeps its
 *    own state (`SportSwitch` opening its list), which re-renders nothing
 *    here. A `MutationObserver` on the subtree hears that. It watches child
 *    lists only, never attributes, so the style this component writes cannot
 *    wake it.
 *
 * ## Tab
 *
 * A portalled element sits at the end of `document.body`, so DOM order can no
 * longer be what carries focus into and out of the popover — and inside
 * `CardAttentionWalker`, whose `aria-modal` Tab trap collects focusables from
 * the dialog element, "out of the popover" would mean out of the modal
 * entirely. So the picker owns the two boundary hops instead (see
 * `onTabOut` here and the trigger's own `onKeyDown` in each picker), which
 * makes the keyboard contract independent of where the portal lands.
 *
 * Everything else about propagation is unchanged: React events bubble through
 * the REACT tree, not the DOM one, so the walker still sees Escape from the
 * search box exactly as it did, and the pickers' own `onBlur` on their root
 * still fires for focus moves inside the portal. What DOES change is `Node.
 * contains()`, which is a DOM question — both pickers pass this component's
 * element into their dismissal checks for that reason.
 */

/**
 * The focusable set, matching `CardAttentionWalker`'s own trap selector.
 * Native `disabled` only: the "+ Create" row is deliberately `aria-disabled`
 * and stays in the tab order while its write is in flight (NEO-220).
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])';

/** The popover's tab stops, in document order. */
export function popoverFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Matches `mt-1` / `mb-1`, the gap the element declares between it and the trigger. */
export const POPOVER_GAP = 4;
/** The popover never comes closer than this to a viewport edge. */
export const POPOVER_EDGE = 8;

export type PopoverPlacement = "below" | "above";

/**
 * Where the popover goes. `top` is set when it sits below the trigger and
 * `bottom` when it sits above; `maxHeight` only when it has to scroll.
 */
export type PopoverPosition = {
  placement: PopoverPlacement;
  top?: number;
  bottom?: number;
  left: number;
  maxHeight?: number;
  maxWidth: number;
};

/**
 * Pure geometry, exported for its unit tests. See "Position" in the
 * docstring above for the rules.
 *
 * @param anchor  the trigger's viewport rect.
 * @param size    the popover's natural (unclamped) border-box size.
 * @param viewport the fixed-position containing block (the layout viewport).
 * @param prev    the side it sat on last time, for the sticky rule.
 */
export function placePopover(
  anchor: { top: number; bottom: number; left: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  prev: PopoverPlacement = "below",
): PopoverPosition {
  const spaceBelow = viewport.height - anchor.bottom - POPOVER_GAP - POPOVER_EDGE;
  const spaceAbove = anchor.top - POPOVER_GAP - POPOVER_EDGE;
  const fitsBelow = size.height <= spaceBelow;
  const fitsAbove = size.height <= spaceAbove;

  let placement: PopoverPlacement;
  if (prev === "above" && fitsAbove) placement = "above";
  else if (fitsBelow) placement = "below";
  else if (fitsAbove) placement = "above";
  else placement = spaceAbove > spaceBelow ? "above" : "below";

  const room = placement === "below" ? spaceBelow : spaceAbove;
  const maxHeight =
    size.height > room ? Math.max(0, Math.floor(room)) : undefined;

  const maxWidth = Math.max(0, viewport.width - 2 * POPOVER_EDGE);
  const width = Math.min(size.width, maxWidth);
  const left = Math.max(
    POPOVER_EDGE,
    Math.min(anchor.left, viewport.width - POPOVER_EDGE - width),
  );

  return placement === "below"
    ? { placement, top: anchor.bottom, left, maxHeight, maxWidth }
    : {
        placement,
        bottom: viewport.height - anchor.top,
        left,
        maxHeight,
        maxWidth,
      };
}

function samePosition(a: PopoverPosition, b: PopoverPosition): boolean {
  return (
    a.placement === b.placement &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.maxHeight === b.maxHeight &&
    a.maxWidth === b.maxWidth
  );
}

/**
 * The fixed-position containing block. `clientWidth/Height` on the root
 * element excludes classic scrollbars, which is what `bottom` and the right
 * edge are measured against; happy-dom reports 0 there, hence the fallback.
 */
function viewportSize(): { width: number; height: number } {
  const root = document.documentElement;
  return {
    width: root.clientWidth || window.innerWidth,
    height: root.clientHeight || window.innerHeight,
  };
}

/**
 * The row the ArrowDown cursor is on. Focus stays in the search box, so the
 * browser never scrolls a clamped popover for it. `SportSwitch`'s own options
 * also carry `aria-selected` (its current sport), so they are excluded.
 */
const HIGHLIGHT_SELECTOR =
  '[role="option"][aria-selected="true"]:not([data-sport-switch-option]), [aria-current="true"]';

export default function PickerPopover({
  anchorRef,
  popoverRef,
  className,
  children,
  onTabOut,
  role,
  "aria-label": ariaLabel,
}: {
  /** The "+ Add …" trigger the popover hangs off. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * Handed back to the picker, which needs the ELEMENT (not the React tree) to
   * answer "was that press inside the popover?" once it is no longer a DOM
   * descendant of the picker's root.
   */
  popoverRef: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
  /**
   * Tab off the popover's last stop. The picker closes and returns focus to
   * the trigger — which is where DOM order used to leave the operator one hop
   * later anyway, and which keeps focus inside whatever dialog hosts the
   * picker.
   */
  onTabOut: () => void;
  /**
   * Neither picker sets this: both put `role="listbox"` on the options list
   * INSIDE the popover (TeamPicker since NEO-236, PlayerPicker since NEO-341),
   * because the popover also holds a search box and a sport switch and a
   * listbox may own only options. Never put `listbox` here for a picker.
   */
  role?: string;
  "aria-label"?: string;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  /**
   * One node, two holders: this component reads it, the picker asks it
   * questions. Memoised so React does not detach and re-attach the ref on
   * every render — the picker's dismissal checks read it between renders, and
   * churn there is pointless work at best.
   */
  const attachRef = useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      popoverRef.current = node;
    },
    [popoverRef],
  );

  const [position, setPosition] = useState<PopoverPosition>({
    placement: "below",
    top: 0,
    left: 0,
    maxWidth: Number.POSITIVE_INFINITY,
  });

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    const el = innerRef.current;
    if (!anchor || !el) return;
    const rect = anchor.getBoundingClientRect();
    // The NATURAL height, whatever max-height is applied right now:
    // `scrollHeight` is the content (plus padding) even while the box is
    // clamped, and offsetHeight - clientHeight adds the borders back.
    const size = {
      width: el.offsetWidth,
      height: el.scrollHeight + (el.offsetHeight - el.clientHeight),
    };
    const viewport = viewportSize();
    setPosition((prev) => {
      const next = placePopover(rect, size, viewport, prev.placement);
      return samePosition(prev, next) ? prev : next;
    });
  }, [anchorRef]);

  /** The highlighted row last kept in view, so a wheel scroll is not undone. */
  const lastHighlightRef = useRef<Element | null>(null);

  // Before paint, and after EVERY commit — see "Following the trigger" above.
  // No dependency array on purpose: the trigger moves when the chip row
  // reflows, with no scroll and no resize to hear.
  useLayoutEffect(() => {
    measure();

    const el = innerRef.current;
    if (!el) return;
    const highlighted = el.querySelector(HIGHLIGHT_SELECTOR);
    if (highlighted === lastHighlightRef.current) return;
    lastHighlightRef.current = highlighted;
    if (!highlighted || el.scrollHeight <= el.clientHeight) return;
    // Nearest-edge scroll inside the popover only. `scrollIntoView` would
    // also scroll every scrollable ancestor of the TRIGGER's host — the
    // drawer, the page — which is exactly what must not move under it.
    const box = el.getBoundingClientRect();
    const row = highlighted.getBoundingClientRect();
    if (row.top < box.top) el.scrollTop -= box.top - row.top;
    else if (row.bottom > box.bottom) el.scrollTop += row.bottom - box.bottom;
  });

  useEffect(() => {
    // Capture phase: a scroll inside an ancestor div never bubbles to window,
    // but it does pass through it on the way down. The popover scrolling
    // inside itself moves nothing it is anchored to, so a wheel through a
    // long list does not re-measure on every tick.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && innerRef.current?.contains(e.target)) return;
      measure();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", measure);
    // Content that changes height without re-rendering this component — see
    // "Following the trigger". Child lists only: never attributes, so the
    // style written below cannot re-trigger it.
    const el = innerRef.current;
    const observer =
      el && typeof MutationObserver !== "undefined"
        ? new MutationObserver(measure)
        : null;
    if (el && observer) {
      observer.observe(el, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [measure]);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const stops = popoverFocusables(innerRef.current);
    if (stops.length === 0) return;
    const active = document.activeElement;
    if (e.shiftKey && active === stops[0]) {
      // Backwards off the search box lands on the trigger, exactly as DOM
      // order used to. The popover stays open: the trigger is inside the
      // picker's root, so no dismissal path fires.
      e.preventDefault();
      e.stopPropagation();
      anchorRef.current?.focus();
    } else if (!e.shiftKey && active === stops[stops.length - 1]) {
      // Forwards off the last row. The popover is drawn over whatever the host
      // put after the picker (WCAG 2.4.11 — the reason both pickers close on a
      // Tab-out at all), so it closes and hands focus back to the trigger for
      // the next Tab to continue from.
      e.preventDefault();
      e.stopPropagation();
      onTabOut();
    }
    // Every other Tab is an ordinary hop between rows inside the popover, and
    // the host's trap cannot reach into it to interfere: `stopPropagation` is
    // exactly the two cases above.
  };

  return createPortal(
    // Nested <Theme>: a portal escapes the root Theme's CSS scope, and the
    // popover's type would otherwise fall back to the body font rather than
    // the one every host renders in. Same reason every dialog in this
    // directory carries one.
    <Theme>
      <div
        ref={attachRef}
        role={role}
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        // `fixed` + measured coordinates, replacing `absolute left-0 top-full`.
        // The 4px gap stays a class (`mt-1` below the trigger, `mb-1` above
        // it), so it is declared, not arithmetic.
        // z-[55] sits over the z-50 dialogs that host this picker and under
        // NewTeamDialog's z-[60], which the popover opens and must not cover.
        data-placement={position.placement}
        className={`fixed z-[55] ${
          position.placement === "above" ? "mb-1" : "mt-1"
        } ${className ?? ""}`}
        style={{
          top: position.top,
          bottom: position.bottom,
          left: position.left,
          maxWidth: Number.isFinite(position.maxWidth)
            ? position.maxWidth
            : undefined,
          maxHeight: position.maxHeight,
          // Only while clamped: an overflow box clips, and SportSwitch hangs
          // its own list off the popover's footer.
          overflowY: position.maxHeight === undefined ? undefined : "auto",
          overscrollBehavior:
            position.maxHeight === undefined ? undefined : "contain",
        }}
      >
        {children}
      </div>
    </Theme>,
    document.body,
  );
}
