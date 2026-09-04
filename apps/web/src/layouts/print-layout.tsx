import { useQuery } from "convex/react";
import { NavLink, Outlet } from "react-router";
import { api } from "@/convex/_generated/api";

/**
 * Shell for /print — the Print Shop (NEO-145).
 *
 * WHY A SECTION AND NOT MORE TABS: the binder tabs are a hardcoded list rendered
 * as a staircase down the right edge, and two of the seven entries were already
 * print utilities (QR Code, Labels). With binder placeholder sheets and spine
 * labels coming, appending them would have made nine top-level tabs — and
 * "Labels" already meant SHIPPING labels, so a binder-label tab at the same
 * level would have been genuinely ambiguous. Folding the print tools into one
 * section takes the nav from seven tabs to six and gives the two new tools a
 * home to land in.
 *
 * The sub-nav deliberately copies /profile's (src/layouts/profile-layout.tsx):
 * a local SECTIONS array driving NavLinks, not an ARIA tab widget. The panels
 * are separate documents reached by URL, so <nav> + NavLink's implicit
 * aria-current="page" is the honest markup, and Tab/Enter reach them without
 * roving-focus machinery.
 *
 * The "Print Shop" h1 lives here rather than in the panels, which is why the
 * moved shipping and QR pages head their content with an h2.
 */

export const SECTIONS = [
  { label: "Shipping", path: "/print/shipping" },
  // Directly after Shipping because it is where a label bought there ends up —
  // the two are one flow read left to right (NEO-213).
  { label: "Label History", path: "/print/labels" },
  { label: "QR Code", path: "/print/qr" },
  { label: "Placeholders", path: "/print/placeholders" },
  { label: "Spine Labels", path: "/print/spine-label" },
];

/**
 * Hold both tools' queries open at the shell level.
 *
 * Same reason /profile does it: a sub-route UNMOUNTS when you leave it, which
 * drops its Convex subscription, so coming back re-fetches from `undefined` and
 * the page paints its full-height spinner first. Switching sub-tabs would flash
 * a spinner every time, which reads as the page reloading. The values are
 * deliberately unused — the pages still own their own data; this owns only the
 * SUBSCRIPTION LIFETIME.
 *
 * Keep this in sync when a tool gains a query, or that tool reintroduces the
 * flash on its own.
 */
function useWarmPrintQueries() {
  useQuery(api.shipping.getMyReturnAddress); // shipping labels
  useQuery(api.shipping.listMyLabelPurchases); // label history
  useQuery(api.publicProfile.getMyPublicProfile); // QR code
  useQuery(api.shipmentTracking.getMyTrackingSetup); // label history's scan-updates chip
  // Spine labels (NEO-147) deliberately has nothing here. Both of its queries
  // are demand-driven — `players.search` is skipped until the user types, and
  // `teams.getManyByIds` needs a selected player — so neither paints a spinner
  // on arrival and there is nothing to keep warm.
}

export default function PrintLayout() {
  useWarmPrintQueries();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Print Shop</h1>
        <p className="text-muted-foreground">
          Everything you print — shipping labels, sale QR codes, and binder
          inserts.
        </p>
      </div>

      <nav aria-label="Print Shop sections" className="border-b border-slate-800">
        {/* Wraps rather than scrolls horizontally: a scrolling strip would hide
            tools off-screen, and you cannot use what you cannot see. */}
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink
                to={section.path}
                className={({ isActive }) =>
                  "block px-1 py-3 -mb-px border-b-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm " +
                  (isActive
                    ? "border-neon-teal text-neon-teal"
                    : "border-transparent text-slate-400 hover:text-foreground hover:border-slate-600")
                }
              >
                {section.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <Outlet />
    </div>
  );
}
