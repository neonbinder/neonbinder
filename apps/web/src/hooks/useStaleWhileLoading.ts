import { useState } from "react";

/**
 * Keep showing the last answer while the next one loads.
 *
 * Convex's `useQuery` answers `undefined` from the moment its args change until
 * the new result arrives. For a query keyed on what the operator is typing,
 * that is every keystroke — so anything rendered off the answer (a warning, an
 * `aria-disabled`) blinks off and back on as they type. This returns `value`
 * when there is one and, while it is `undefined`, the last defined value seen
 * under the same `resetKey`.
 *
 * `resetKey` is what makes an old answer stale for good rather than merely
 * late: change it (a different review row, a different record) and nothing
 * from before is held — not even if the key later comes back. Until the first
 * answer under the new key arrives, the result is `undefined`, exactly as the
 * query's own.
 *
 * A caller that SKIPS its query should pass a definite value (`[]`, `null`)
 * rather than the skipped `undefined`: "not asked" is an answer, and holding
 * the previous one through it would show a result for a question nobody is
 * asking any more.
 *
 * Adjusts state during render, the pattern React documents for "storing
 * information from previous renders" — no effect, no ref read, no extra
 * committed frame. It only sets state when a NEW defined value or a new key
 * arrives, so a query result's stable reference cannot loop it — which is also
 * why a caller's stand-in value must be one stable reference, not a fresh
 * literal per render.
 */
export function useStaleWhileLoading<T>(
  value: T | undefined,
  resetKey: string,
): T | undefined {
  const [held, setHeld] = useState<{ key: string; value: T } | null>(null);
  if (held !== null && held.key !== resetKey) {
    // A new key drops the old answer outright — even if this key has no
    // answer of its own yet — so returning to an earlier key later cannot
    // resurrect what was held before the switch.
    setHeld(value !== undefined ? { key: resetKey, value } : null);
  } else if (value !== undefined && (held === null || held.value !== value)) {
    setHeld({ key: resetKey, value });
  }
  if (value !== undefined) return value;
  return held !== null && held.key === resetKey ? held.value : undefined;
}
