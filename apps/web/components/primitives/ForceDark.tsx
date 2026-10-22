import { useLayoutEffect, type ReactNode } from "react";
import { useTheme } from "@/src/theme/ThemeProvider";

/**
 * NEO-356 — keeps the whole page dark while it is mounted, whatever the
 * collector's setting: header, portals and all. For pages that were only ever
 * designed dark and are not migrated (the NEO-350 collection prototypes at
 * /collection/1-5). Leaving the page restores the collector's own mode.
 *
 * It sets the ThemeProvider's override slot, which outranks every preference
 * and is never saved. A layout effect, so the switch lands before the first
 * paint of the forced page rather than one frame after it.
 *
 * Wrap the page (`<ForceDark><Page /></ForceDark>`) or render it bare beside it.
 */
export function ForceDark({ children }: { children?: ReactNode }) {
  const { setOverride } = useTheme();
  useLayoutEffect(() => {
    setOverride("dark");
    return () => setOverride(null);
  }, [setOverride]);
  return <>{children}</>;
}

export default ForceDark;
