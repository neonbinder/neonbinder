import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/solid";

/**
 * A horizontal shelf of cards with visible Back / Forward buttons (a
 * trackpad is not the only way to scroll). The buttons only appear when the
 * row overflows, and each disables at its end.
 */
export default function CardStrip({
  label,
  children,
  header,
}: {
  /** Names the buttons: "Scroll 1996 back". Keep unique on the page. */
  label: string;
  /** Left side of the strip's header row (the buttons sit on the right). */
  header?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({
    overflow: false,
    atStart: true,
    atEnd: true,
  });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 2;
    setEdges({
      overflow,
      atStart: el.scrollLeft <= 2,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  function scrollBy(dir: 1 | -1) {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    el.scrollBy({
      left: dir * el.clientWidth * 0.8,
      behavior: reduce ? "auto" : "smooth",
    });
  }

  const btn =
    "flex h-11 w-11 items-center justify-center rounded-full border border-slate-600 bg-slate-900 text-slate-100 hover:border-[#00C2FF] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00C2FF] sm:h-8 sm:w-8";

  return (
    <div>
      <div
        className={`flex items-end justify-between gap-3 ${header || edges.overflow ? "mb-2" : "hidden"}`}
      >
        <div className="min-w-0 flex-1">{header}</div>
        {edges.overflow && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className={btn}
              aria-label={`Scroll ${label} back`}
              disabled={edges.atStart}
              onClick={() => scrollBy(-1)}
            >
              <ChevronLeftIcon aria-hidden="true" className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={btn}
              aria-label={`Scroll ${label} forward`}
              disabled={edges.atEnd}
              onClick={() => scrollBy(1)}
            >
              <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      {/* relative: an absolutely positioned child (sr-only text) must not
          escape the scroller and widen the document. */}
      <div
        ref={ref}
        onScroll={measure}
        className="relative -mx-1 flex gap-4 overflow-x-auto px-1 pb-3 pt-1 [scrollbar-color:#334155_transparent]"
      >
        {children}
      </div>
    </div>
  );
}
