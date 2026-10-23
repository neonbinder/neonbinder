import { useLayoutEffect, useRef } from "react";
import { useAuth } from "@clerk/clerk-react";
import { ModeRadioGroup } from "@/components/primitives/ModeRadioGroup";
import { useTheme } from "@/src/theme/ThemeProvider";
import type { ThemeMode, ThemePreference } from "@/src/theme/theme-mode";

/**
 * NEO-356 — the collection demo's Light / Dark switch, so a visitor can see
 * the binder both ways without touching a setting.
 *
 * - It starts at the mode the page is already in and flips the WHOLE page
 *   (header, portals and all) through the ThemeProvider's override slot.
 * - It never saves anything: the collector's own choice (`preference`) is
 *   left alone, and leaving the demo by any route restores it.
 * - It shows only to someone who has not picked a mode: a signed-out visitor,
 *   or a collector on System. A collector who chose Light or Dark in Settings
 *   has already said how they want the app to look, so the demo honours that.
 */

const OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Who sees the switch. `signedIn` is `undefined` while Clerk is still
 * loading; that counts as signed out, so a visitor never waits for it (a
 * signed-in page has already waited for Clerk behind ProtectedLayout).
 */
export function showDemoThemeToggle(signedIn: boolean | undefined, preference: ThemePreference): boolean {
  if (!signedIn) return true;
  return preference === "system";
}

export default function DemoThemeToggle({ className = "" }: { className?: string }) {
  const { mode, preference, setOverride } = useTheme();
  const { isLoaded, isSignedIn } = useAuth();
  const visible = showDemoThemeToggle(isLoaded ? isSignedIn : undefined, preference);

  // Only release an override this switch set: nothing else on the demo forces
  // a mode, but a page that does (ForceDark) must never be clobbered by it.
  const flipped = useRef(false);
  const choose = (next: ThemeMode) => {
    flipped.current = true;
    setOverride(next);
  };

  // Hidden after all (Clerk finished loading: signed in with a saved mode):
  // the collector's own mode wins.
  useLayoutEffect(() => {
    if (!visible && flipped.current) {
      flipped.current = false;
      setOverride(null);
    }
  }, [visible, setOverride]);

  // A layout effect, so the release runs as the demo unmounts, before the
  // next page's own layout effects (a ForceDark page sets its override there).
  useLayoutEffect(
    () => () => {
      if (flipped.current) setOverride(null);
    },
    [setOverride],
  );

  if (!visible) return null;
  return <ModeRadioGroup label="Demo theme" value={mode} options={OPTIONS} onChange={choose} className={className} />;
}
