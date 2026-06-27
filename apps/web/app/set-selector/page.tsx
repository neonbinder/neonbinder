import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import SetSelector from "../../components/modules/SetSelector";
import AdminTools from "../../components/SetSelector/AdminTools";
import MissingCredentialsBanner from "../../components/SetSelector/MissingCredentialsBanner";

const REQUIRED_SITES = ["buysportscards", "sportlots"];

export default function SetSelectorPage() {
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
    return (
      <div className="p-6">
        <MissingCredentialsBanner missing={missing} />
      </div>
    );
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
    <>
      <div className="max-w-6xl mx-auto px-6 pt-6 mb-4">
        <h1 className="text-3xl font-bold mb-6 text-center">Set Selector</h1>
        <p className="text-center text-gray-600 dark:text-gray-400 mb-6">
          Build set parameters using marketplace APIs with searchable dropdowns
        </p>
        <AdminTools />
      </div>
      <div className="px-6 pb-6">
        <SetSelector />
      </div>
    </>
  );
}
