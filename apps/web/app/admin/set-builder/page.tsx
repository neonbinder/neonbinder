import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import SetSelector from "@/components/modules/SetSelector";
import MissingCredentialsBanner from "@/components/SetSelector/MissingCredentialsBanner";
import ReauthNotice from "@/components/SetSelector/ReauthNotice";
import PausedNotice from "@/components/SetSelector/PausedNotice";
import { usePausedPlatforms } from "@/src/hooks/usePausedPlatforms";

/**
 * /admin/set-builder — was /set-selector until NEO-155 gave the admin tools a
 * section of their own. The old URL still resolves here (see the redirect in
 * src/main.tsx): it is bookmarked, and ~48 Maestro flows reach this page by URL
 * rather than by tapping the nav tab.
 *
 * The h1 lives in the section layout, so this heads its content with an h2, and
 * the outer max-w/padding wrapper this page used to carry is gone —
 * binder-layout already supplies `max-w-6xl mx-auto p-6`, so it was nesting a
 * container inside an identical one.
 */

const REQUIRED_SITES = ["buysportscards", "sportlots"];

export default function AdminSetBuilderPage() {
  const profile = useQuery(api.userProfile.getUserProfile);
  // NEO-287: a paused marketplace is not REQUIRED. The operator has switched
  // it off deployment-wide, so asking every admin for its credentials before
  // the builder opens would gate the tool on a sign-in the server refuses.
  // Syncs run on the remaining side and the strip below says so.
  const paused = usePausedPlatforms();

  if (profile === undefined) {
    return (
      <div className="p-6 text-center text-sm text-slate-400">
        Loading credentials…
      </div>
    );
  }

  const missing = REQUIRED_SITES.filter(
    (site) =>
      !paused.has(site) &&
      !profile?.siteCredentials?.some(
        (c) => c.site === site && c.hasCredentials,
      ),
  );

  if (missing.length > 0) {
    return <MissingCredentialsBanner missing={missing} />;
  }

  // The cascade lives in a horizontally-scrollable columns row, so it does NOT
  // need to break out of the layout for width — it scrolls. A prior vw-based
  // full-bleed break-out (negative margins) caused NEO-63: the negative left
  // margin pushed content off the left edge, which let scrollIntoView drag a
  // deep column UNDER the fixed nav (x≈864–1024 at 1024px) so taps hit the nav
  // and navigated to /inventory. It also clipped the page's own content at
  // ≤1024px and only added width above ~1300px anyway. So: no break-out — the
  // section renders in normal flow inside binder-layout's max-w-6xl +
  // lg:pr-[170px] nav gutter, nav-safe exactly like every other page; the
  // columns row's overflow-x-auto handles extra columns via horizontal scroll.
  return (
    <div className="space-y-4">
      {/* NEO-287: the operator's pause switch, shown where syncs are
          triggered. A warning, not a gate — the cascade keeps working on the
          marketplaces that are not paused. Renders nothing unless a platform
          is paused. Sits ABOVE ReauthNotice because paused beats
          needs-reauth: a paused platform is filtered out of the strip below. */}
      <PausedNotice sites={paused} />

      {/* NEO-278: a lapsed marketplace session used to surface ONLY on
          /profile/credentials while syncs here kept running on the stale
          token. This is the same server-owned `needsReauth` flag, shown where
          the syncs are triggered. A warning, not a gate — the cascade below
          keeps working. Renders nothing unless a platform is flagged. */}
      <ReauthNotice
        siteCredentials={profile?.siteCredentials}
        pausedSites={paused}
      />

      {/* The subtitle is load-bearing beyond decoration: ~47 Maestro flows wait
          on "Build set parameters using marketplace APIs" as the signal that
          THIS panel (not the nav, not the /admin hub card) has mounted. Do not
          reword it without updating them. The h2 is visually small because the
          cascade below needs the vertical room — see the layout's note. */}
      <div>
        {/* Focus park for ReauthNotice's Dismiss (its click unmounts the
            button it lives in; see focus-park-pattern). Never in tab order. */}
        <h2
          id="set-builder-heading"
          tabIndex={-1}
          className="text-lg font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] rounded"
        >
          Set Builder
        </h2>
        <p className="text-sm text-slate-400">
          Build set parameters using marketplace APIs with searchable dropdowns.
        </p>
      </div>

      <SetSelector />
    </div>
  );
}
