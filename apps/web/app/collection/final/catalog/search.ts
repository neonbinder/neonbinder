import { useEffect, useState } from "react";
import { SEARCH_DEBOUNCE_MS, useCollectionStore } from "../data/store";

/**
 * NEO-358 — the search box's pause. The real catalog is asked once typing
 * stops for `SEARCH_DEBOUNCE_MS`; the demo answers from memory, so it keeps
 * answering every keystroke as it always has.
 */
export function useSearchText(text: string): string {
  const delay = useCollectionStore().kind === "convex" ? SEARCH_DEBOUNCE_MS : 0;
  return useDebounced(text.trim(), delay);
}

/** `value`, once it has held still for `ms` (at once for 0). */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (ms <= 0) return;
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return ms <= 0 ? value : settled;
}
