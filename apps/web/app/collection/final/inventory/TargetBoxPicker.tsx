import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import { HEADER_HEIGHT_EVENT } from "@/src/hooks/useStickyHeaderHeight";
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
 * The bar sticks under the page header, at the height the header publishes
 * (`--nb-header-h`, 0 on a phone, where the header scrolls away), so the box
 * stays in sight however deep the checklist goes and never gaps or tucks
 * under the header. While it is up, `html`'s scroll-padding-top grows by its
 * height, so a field the keyboard lands on is scrolled clear of it and of
 * the header (WCAG 2.4.11), never parked underneath.
 *
 * The hint under it is one line: what the number counts and how to fill it.
 * It describes the quantity list (`QUICK_ENTRY_HINT_ID`), so a screen reader
 * hears it on the way in. The keys sit on a quieter row below it (not on a
 * phone, which has none), with what shows after the count, outside the
 * description. It scrolls with the
 * page: only the box sticks. The + is never promised to the keyboard: it is
 * pointer-only by design, and "hit +" reads as the + key.
 */
/** The hint's id: the quantity list below points at it with `aria-describedby`. */
export const QUICK_ENTRY_HINT_ID = "nb-quick-entry-hint";

/** Room left between the bar and a field scrolled in under it. */
const CLEARANCE_PX = 8;

function Key({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-control bg-field px-1 font-sans text-[0.6875rem] text-ink-2">{children}</kbd>;
}

/** One shortcut on the keys row: its key cap, then what it does. */
function Shortcut({ keys, children }: { keys: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 max-sm:hidden">
      <Key>{keys}</Key>
      {children}
    </span>
  );
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
    // The header above it grew or shrank, or stopped sticking: `top` moved.
    window.addEventListener(HEADER_HEIGHT_EVENT, measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener(HEADER_HEIGHT_EVENT, measure);
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
        // mb-3 outranks the page's space-y gap, so the hint reads as the bar's own.
        className="sticky top-[var(--nb-header-h,0px)] z-[5] mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-neon-yellow-text/60 bg-raised px-3 py-2 shadow-offset"
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
            className={`min-h-9 rounded-md border border-control bg-field py-1 pl-2 pr-8 max-sm:min-h-11 text-sm font-semibold text-ink hover:border-neon-yellow-text disabled:cursor-wait ${FOCUS}`}
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
      <div className="space-y-1.5 px-1">
        <p id={QUICK_ENTRY_HINT_ID} className="text-sm text-ink-2">
          Punch in how many raw copies sit in this box and tab on. Tap + for one more.
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
          <Shortcut keys="→">Details</Shortcut>
          <Shortcut keys="Enter">next row</Shortcut>
          <Shortcut keys="Esc">put it back</Shortcut>
          <Shortcut keys="Ctrl/⌘+Z">undo</Shortcut>
          <span>Slabs and copies with a condition or note show after the count.</span>
        </p>
      </div>
    </>
  );
}
