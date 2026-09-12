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
 * ## Position: below the trigger, left-aligned, and nothing clever
 *
 * `top: rect.bottom / left: rect.left` reproduces `top-full left-0` exactly,
 * and `mt-1` stays on the element so the 4px gap is still declared rather than
 * computed. Deliberately NO flip-above and NO viewport clamping: `.maestro`
 * flows tap this popover at measured coordinates
 * (`checklist-attention-walker-missing-team.yaml` documents its own geometry
 * at 1024x629), so the box lands where it has always landed and only the clip
 * changes. A popover that decides for itself which side of the trigger to sit
 * on is a different change, with a different test bill.
 *
 * ## Following the trigger
 *
 * Three things move it, and all three are covered:
 *  - an ancestor scrolling — `scroll` is listened for in the CAPTURE phase on
 *    `window`, which is the only way to hear a scroll on an inner element
 *    (scroll events do not bubble, but they do capture);
 *  - the window resizing;
 *  - the trigger itself moving with no scroll and no resize, which is the
 *    common one: adding a chip reflows the picker's own chip row and pushes
 *    "+ Add team" along. That is why the measurement runs after EVERY commit
 *    rather than only from the two listeners. It is one `getBoundingClientRect`
 *    and a shallow compare, and it no-ops when nothing moved.
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

type Position = { top: number; left: number };

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
  /** `PlayerPicker` puts its listbox role on this container; `TeamPicker` does not. */
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

  const [position, setPosition] = useState<Position>({ top: 0, left: 0 });

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition((prev) =>
      prev.top === rect.bottom && prev.left === rect.left
        ? prev
        : { top: rect.bottom, left: rect.left },
    );
  }, [anchorRef]);

  // Before paint, and after EVERY commit — see "Following the trigger" above.
  // No dependency array on purpose: the trigger moves when the chip row
  // reflows, with no scroll and no resize to hear.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    // Capture phase: a scroll inside an ancestor div never bubbles to window,
    // but it does pass through it on the way down.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
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
        // `mt-1` is still a class so the 4px gap stays declared, not arithmetic.
        // z-[55] sits over the z-50 dialogs that host this picker and under
        // NewTeamDialog's z-[60], which the popover opens and must not cover.
        className={`fixed z-[55] mt-1 ${className ?? ""}`}
        style={{ top: position.top, left: position.left }}
      >
        {children}
      </div>
    </Theme>,
    document.body,
  );
}
