import { useLayoutEffect, useRef, useState } from "react";

/**
 * NEO-444 — whether a scroller's content is taller than it, kept current as it
 * resizes. A keyboard user can only scroll a scroller they can reach, and one
 * with nothing to scroll is a stop that does nothing: `tabIndex` follows this.
 * Read once per mount for what's inside: the content is fixed while it's open.
 */
export function useOverflows<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  return [ref, overflows] as const;
}
