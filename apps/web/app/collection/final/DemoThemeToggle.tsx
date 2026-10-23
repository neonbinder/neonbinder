import { useLayoutEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { ModeRadioGroup } from "@/components/primitives/ModeRadioGroup";
import { useTheme, useThemeOverride } from "@/src/theme/ThemeProvider";
import type { ThemeMode, ThemePreference } from "@/src/theme/theme-mode";

/**
 * NEO-356 — the collection demo's Light / Dark switch, so a visitor can see
 * the binder both ways without touching a setting.
 *
 * - It starts at the mode the page is already in and flips the WHOLE page
 *   (header, portals and all) through its own entry in the ThemeProvider's
 *   overrides. Releasing that entry never touches another forcer's.
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
 * loading. Then the device's stored choice decides, the same value the
 * pre-paint script used (for a collector who signed in here it mirrors the
 * saved one), so the switch is drawn only where it will stay once Clerk
 * answers. Showing it first and then removing it would pull it out from under
 * a keyboard user's focus; a visitor whose device holds a choice sees it
 * appear a moment later instead, which costs nothing.
 */
export function showDemoThemeToggle(signedIn: boolean | undefined, preference: ThemePreference): boolean {
  if (signedIn === false) return true;
  return preference === "system";
}

export default function DemoThemeToggle({ className = "" }: { className?: string }) {
  const { mode, preference } = useTheme();
  const force = useThemeOverride();
  const { isLoaded, isSignedIn } = useAuth();
  const visible = showDemoThemeToggle(isLoaded ? isSignedIn : undefined, preference);

  // Hidden after all (the collector's saved mode arrived): their mode wins.
  // Releasing is a no-op when this switch never flipped.
  useLayoutEffect(() => {
    if (!visible) force(null);
  }, [visible, force]);

  // Leaving the demo by any route releases this switch's entry, and only
  // that: a ForceDark page mounted beside it or after it keeps its own.
  useLayoutEffect(() => () => force(null), [force]);

  if (!visible) return null;
  return <ModeRadioGroup label="Demo theme" value={mode} options={OPTIONS} onChange={force} className={className} />;
}
