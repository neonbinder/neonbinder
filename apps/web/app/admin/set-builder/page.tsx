import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import SetSelector from "@/components/modules/SetSelector";
import AdminTools from "@/components/SetSelector/AdminTools";
import MissingCredentialsBanner from "@/components/SetSelector/MissingCredentialsBanner";

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

  if (profile === undefined) {
    return (
      <div className="p-6 text-center text-sm text-slate-400">
        Loading credentials…
      </div>
    );
  }

  const missing = REQUIRED_SITES.filter(
    (site) =>
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
  // and navigated to /inventory. It also clipped AdminTools at ≤1024px and only
  // added width above ~1300px anyway. So: no break-out — the section renders in
  // normal flow inside binder-layout's max-w-6xl + lg:pr-[170px] nav gutter,
  // nav-safe exactly like every other page; the columns row's overflow-x-auto
  // handles extra columns via horizontal scroll.
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-1">Set Builder</h2>
        <p className="text-sm text-slate-400">
          Build set parameters using marketplace APIs with searchable dropdowns.
        </p>
      </div>

      <AdminTools />
      <SetSelector />
    </div>
  );
}
