import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import { FOCUS } from "../../prototypes/p1/ui";
import { useQuickEntry } from "./QuickEntry";

/**
 * NEO-364 (D8) — "Adding to [Unsorted ▾]": the box the inventory's
 * Checklists count and fill. Every quantity field below reads "how many plain
 * raw copies are in THIS box", and "Add a range to …" files into it.
 *
 * A native select (a combobox to a screen reader, with type-ahead on the
 * box names), like the collection's Binder picker. Unsorted comes first,
 * then the collector's boxes as made. A pick replaces `box=` on the URL (an
 * in-view tweak, never a Back step) and is kept on this device for next time.
 *
 * The bar sticks under the page header (top of the screen on a phone, where
 * the header scrolls away), so the box stays in sight however deep the
 * checklist goes. While it is up, `html`'s scroll-padding-top grows by its
 * height, so a field the keyboard lands on is scrolled clear of it and of
 * the header (WCAG 2.4.11), never parked underneath.
 *
 * The hint under it says what the number counts and what the keys do, and
 * describes the quantity list (`QUICK_ENTRY_HINT_ID`), so a screen reader
 * hears it on the way in. It scrolls with the page: only the box sticks.
 */
/** The hint's id: the quantity list below points at it with `aria-describedby`. */
export const QUICK_ENTRY_HINT_ID = "nb-quick-entry-hint";

/** Room left between the bar and a field scrolled in under it. */
const CLEARANCE_PX = 8;

function Key({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-control bg-field px-1 font-sans text-[0.6875rem] text-ink-2">{children}</kbd>;
}

/**
 * Keeps `html`'s scroll-padding-top at the bar's bottom edge while it is
 * stuck (its `top`, the header above it, plus its own height), and puts the
 * stylesheet's value back when the bar goes.
 */
function useStickyClearance(bar: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement;
    const before = root.style.scrollPaddingTop;
    const measure = () => {
      const top = parseFloat(getComputedStyle(el).top) || 0;
      root.style.scrollPaddingTop = `${Math.ceil(top + el.getBoundingClientRect().height + CLEARANCE_PX)}px`;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.scrollPaddingTop = before;
    };
  }, [bar]);
}

export default function TargetBoxPicker() {
  const { box, boxes, setBox } = useQuickEntry();
  const bar = useRef<HTMLDivElement>(null);
  useStickyClearance(bar);
  return (
    <>
      <div
        ref={bar}
        className="sticky top-0 z-[5] flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-neon-yellow-text/60 bg-raised px-3 py-2 shadow-offset sm:top-[80px]"
      >
        <ArchiveBoxIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-neon-yellow-text" />
        <label className="flex items-center gap-2 text-sm">
          <span aria-hidden="true" className="font-semibold text-ink">
            Adding to
          </span>
          <select
            aria-label="Adding to"
            value={box?.id ?? ""}
            disabled={!box}
            onChange={(e) => setBox(e.target.value)}
            className={`min-h-9 rounded-md border border-control bg-field py-1 pl-2 pr-8 text-sm font-semibold text-ink hover:border-neon-yellow-text disabled:cursor-wait ${FOCUS}`}
          >
            {!box && <option value="">Finding your boxes…</option>}
            {boxes.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p id={QUICK_ENTRY_HINT_ID} className="-mt-4 px-1 text-xs text-ink-3">
        Each number is how many plain raw copies (no grade, no condition, no notes) sit in this box. Graded and noted
        copies show up after it. Type it and tab on, or hit + to box one more. <Key>→</Key> opens Details, <Key>Enter</Key> hops to the next row,{" "}
        <Key>Esc</Key> puts the number back, <Key>Ctrl/⌘+Z</Key> undoes the last count.
      </p>
    </>
  );
}
