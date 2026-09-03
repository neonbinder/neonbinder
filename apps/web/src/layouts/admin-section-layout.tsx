import { NavLink, Outlet } from "react-router";

/**
 * Shell for /admin — the admin tools section (NEO-155).
 *
 * WHY A SECTION AND NOT MORE PANELS: there was one admin nav tab, "Set
 * Builder", and its page had become the place anything admin-only landed.
 * NEO-147 added a Team Colors worklist to it, which is where that broke —
 * managing team entities has nothing to do with building sets. The choice was
 * to keep stacking unrelated panels on one page, add a second top-level tab
 * per tool, or give the admin tools a section of their own. This is the same
 * call NEO-145 made for the print tools, for the same reason.
 *
 * The sub-nav deliberately copies /print's and /profile's: a local SECTIONS
 * array driving NavLinks, not an ARIA tab widget. The panels are separate
 * documents reached by URL, so <nav> + NavLink's implicit aria-current="page"
 * is the honest markup, and Tab/Enter reach them without roving-focus
 * machinery.
 *
 * NOT to be confused with src/layouts/AdminLayout.tsx, which is the
 * AUTHORIZATION gate (redirects non-admins to /dashboard) and wraps this. The
 * filenames differ by more than case on purpose: macOS is case-insensitive, so
 * an `admin-layout.tsx` here would collide with `AdminLayout.tsx`.
 *
 * The "Admin" h1 lives here rather than in the panels, which is why the Set
 * Builder page heads its content with an h2.
 */

export const SECTIONS = [
  { label: "Set Builder", path: "/admin/set-builder" },
  // NEO-212. Sits before Teams rather than after, so the two entity tools read
  // in the order the data does: a card names a player, the player names teams.
  { label: "Players", path: "/admin/players" },
  { label: "Teams", path: "/admin/teams" },
  // NEO-170's operator view. Landed as a top-level tab while this section
  // didn't exist yet; its page header planned the move here all along.
  { label: "Pipeline Runs", path: "/admin/pipeline-runs" },
];

export default function AdminSectionLayout() {
  // Deliberately compact. The Set Builder cascade lives below this chrome, and
  // the headless E2E viewport is 1024x629 — the first version carried an h1, a
  // section subtitle, the nav, a page h2 AND a page subtitle, which pushed the
  // Sports column below the fold. "Baseball" rendered but was never VISIBLE, so
  // setup.yaml failed and took the whole E2E suite with it. Every header line
  // here costs the tool underneath it.
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Admin</h1>

      <nav aria-label="Admin sections" className="border-b border-slate-800">
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
                    ? "border-neon-orange text-neon-orange"
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
