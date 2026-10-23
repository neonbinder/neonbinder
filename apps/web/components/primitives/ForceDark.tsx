import { useLayoutEffect, type ReactNode } from "react";
import { useThemeOverride } from "@/src/theme/ThemeProvider";

/**
 * NEO-356 — keeps the whole page dark while it is mounted, whatever the
 * collector's setting: header, portals and all. For pages that were only ever
 * designed dark and are not migrated (the NEO-350 collection prototypes at
 * /collection/1-5). Leaving the page restores the collector's own mode.
 *
 * It claims its own entry in the ThemeProvider's overrides, which outrank
 * every preference and are never saved. Leaving releases only that entry, so
 * another forcer still mounted (a second ForceDark, the collection demo's
 * switch) keeps its mode. A layout effect, so the switch lands before the first
 * paint of the forced page rather than one frame after it.
 *
 * Wrap the page (`<ForceDark><Page /></ForceDark>`) or render it bare beside it.
 */
export function ForceDark({ children }: { children?: ReactNode }) {
  const force = useThemeOverride();
  useLayoutEffect(() => {
    force("dark");
    return () => force(null);
  }, [force]);
  return <>{children}</>;
}

export default ForceDark;
