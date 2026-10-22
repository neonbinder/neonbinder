import { useEffect } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useTheme } from "./ThemeProvider";
import type { ThemePreference } from "./theme-mode";

/**
 * NEO-356 — carries a signed-in collector's saved theme into the ThemeProvider.
 *
 * The provider sits OUTSIDE Clerk and Convex (it has to: Radix `<Theme>` and
 * `<ClerkProvider appearance>` both read its mode), so it cannot run a Convex
 * query itself. This renders nothing; it lives inside the Convex provider and
 * hands `getUserProfile().preferences.theme` to `setProfilePreference`, which
 * outranks localStorage in the provider's precedence (override > profile >
 * localStorage > system).
 *
 * - Signed in, profile loaded: the saved value, or "system" when there is none
 *   (no row, or a row that predates the setting). It is mirrored to the
 *   device (localStorage) so the pre-paint script in index.html, and any
 *   signed-out page after sign-out, start in the same mode with no flash.
 * - Signed in, profile still loading (`undefined`, including the brief gap a
 *   Convex client swap causes): push nothing, so the localStorage mirror keeps
 *   governing and the page does not flicker to "system" and back.
 * - Signed out: clear the profile slot, so localStorage (the last choice made
 *   on this device) takes over again.
 *
 * Only a CHANGE in the saved value re-pushes. Settings applies a pick
 * immediately and then saves it; while that save is in flight this component
 * still sees the old value but does not re-run, so it never stomps the pick.
 */
export function ProfileThemeSync(): null {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const profile = useQuery(
    api.userProfile.getUserProfile,
    isAuthenticated ? {} : "skip",
  );
  const { setPreference, setProfilePreference } = useTheme();

  const saved: ThemePreference | undefined =
    !isAuthenticated || profile === undefined
      ? undefined
      : (profile?.preferences?.theme ?? "system");

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      setProfilePreference(null);
      return;
    }
    if (saved === undefined) return;
    setProfilePreference(saved);
    // The mirror goes through `setPreference`, not a bare localStorage write:
    // it also moves the provider's in-memory device value, which is what the
    // page falls back to the moment the collector signs out. A bare write
    // would leave that holding whatever was stored at page load, so signing
    // out would flip to a mode this device no longer has saved. Blocked
    // storage is swallowed there; the profile still drives this session.
    setPreference(saved);
  }, [isLoading, isAuthenticated, saved, setPreference, setProfilePreference]);

  return null;
}

export default ProfileThemeSync;
