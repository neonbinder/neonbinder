import { useQuery } from "convex/react";
import { NavLink, Outlet } from "react-router";
import { api } from "@/convex/_generated/api";

/**
 * Shell for /profile. Each section is its own route rendering into the Outlet
 * below, so only one section's DOM exists at a time (NEO-128).
 *
 * WHY ROUTES AND NOT ONE SCROLLING PAGE: /profile used to stack Public Profile,
 * Credentials, Prize Pool and Shipping in a single ~5000px column. Reaching the
 * Credentials section's "Test Credentials" button cost the e2e worker bootstrap
 * a page-level scrollUntilVisible that ran at ~85% of its 20s budget, so the
 * page's total height became a tripwire: NEO-118 appended a section at the
 * BOTTOM of the page and the seed track went red with nothing wrong in the
 * credentials feature at all. The page carried an unwritten "nothing may be
 * added above Credentials" rule that nothing enforced.
 *
 * That rule is retired. Sections cannot push each other off-screen when they
 * are separate routes, and the flows deep-link (/profile/credentials) instead
 * of scrolling. Add sections here freely — order and length no longer affect
 * anything but this nav.
 *
 * The "Profile Settings" heading lives here rather than in a panel because
 * every Maestro flow gates on it before acting; keeping it in the shell means
 * that gate holds on all four sub-routes.
 *
 * These are links, not an ARIA tab widget: the panels are separate documents
 * reached by URL, so <nav> + NavLink's implicit aria-current="page" is the
 * honest markup, and Tab/Enter reach them without roving-focus machinery.
 */

const SECTIONS = [
  { label: "Public Profile", path: "/profile/public" },
  { label: "Credentials", path: "/profile/credentials" },
  { label: "Shipping", path: "/profile/shipping" },
  { label: "Prize Pool", path: "/profile/prizes" },
  // NEO-172. The UserButton menu also links straight here, but a section that
  // exists only in that menu would be a page with no entry in the nav of the
  // shell it renders inside — no highlighted tab, and no way back to it from
  // the other sections.
  { label: "API Keys", path: "/profile/api-keys" },
];

/**
 * Hold every section's query open at the shell level.
 *
 * Splitting the sections into routes means a panel UNMOUNTS when you leave it,
 * which drops its Convex subscription — so coming back re-fetched from
 * `undefined` and the panel painted its loading state first. Switching sections
 * flashed "Loading credentials…" every time, which reads as the page reloading.
 * The old single-page /profile never did this: every section was mounted once
 * and scrolling could not unmount anything.
 *
 * Subscribing here keeps the results warm for as long as the user is anywhere
 * under /profile, so a panel's own useQuery resolves from cache on mount and
 * paints immediately. The values are deliberately unused — the panels still own
 * their own data; this only owns the SUBSCRIPTION LIFETIME.
 *
 * Keep this list in sync when a section gains a query, or that section
 * reintroduces the flash on its own.
 */
function useWarmProfileQueries() {
  useQuery(api.userProfile.getUserProfile); // credentials
  useQuery(api.userProfile.getPrizes); // prizes
  useQuery(api.publicProfile.getMyPublicProfile); // public + shipping
  useQuery(api.shipping.getMyReturnAddress); // shipping
}

export default function ProfileLayout() {
  useWarmProfileQueries();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Profile Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and credentials for supported platforms.
        </p>
      </div>

      <nav aria-label="Profile sections" className="border-b border-slate-800">
        {/* Wraps rather than scrolls horizontally: the items fit two rows at
            375px, and a scrolling strip would hide sections off-screen — the
            same "you cannot see what is there" problem at a smaller scale. */}
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink
                to={section.path}
                className={({ isActive }) =>
                  "block px-1 py-3 -mb-px border-b-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm " +
                  (isActive
                    ? "border-neon-purple text-neon-purple"
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
