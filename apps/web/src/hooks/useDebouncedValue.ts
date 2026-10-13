import { useEffect, useState } from "react";

/**
 * `value`, once it has held still for `delay` ms.
 *
 * Starts at the value it mounts with, so nothing waits on the first render.
 * Every change restarts the clock, so a burst of changes settles on its last
 * value once. Two uses: holding a typed name back from a preview query
 * (`MakeInsertControl`), and holding a live region's text back so a burst of
 * count changes is announced once rather than once per change
 * (`CardChecklist`'s "N cards need you" status).
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
