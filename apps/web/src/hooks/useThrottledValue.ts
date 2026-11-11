import { useEffect, useRef, useState } from "react";

/**
 * `value`, changed at most once per `interval` ms.
 *
 * Where `useDebouncedValue` waits for a value to hold still, this one keeps
 * moving through a value that never does: the first change after a quiet
 * spell lands on the next tick, and later changes inside the interval land
 * together, as the latest value, when it ends. Nothing is dropped for good;
 * the last value always arrives.
 *
 * Built for a VISIBLE live region whose number keeps ticking, such as
 * `CardChecklist`'s "Still looking up teams for N cards" line while the
 * background lookup answers one card after another. A debounce would freeze
 * the number on screen until the lookups stopped; passing the raw count would
 * have a screen reader read every step. This shows the count moving and says
 * it at most once per interval.
 *
 * Every state write is in a timer callback, never in the effect body.
 */
export function useThrottledValue<T>(value: T, interval: number): T {
  const [shown, setShown] = useState(value);
  /**
   * When `shown` last changed. Mounting does not count: the first change
   * lands at once, so a list that loads a beat after the page does not hold
   * its first number back for a whole interval.
   */
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const since =
      shownAt.current === null ? Number.POSITIVE_INFINITY : Date.now() - shownAt.current;
    const timer = setTimeout(
      () => {
        shownAt.current = Date.now();
        setShown(value);
      },
      Math.max(0, interval - since),
    );
    return () => clearTimeout(timer);
  }, [value, shown, interval]);
  return shown;
}
