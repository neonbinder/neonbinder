import { useLayoutEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { NavLink, Outlet, useLocation } from "react-router";
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
  { label: "Postage", path: "/profile/postage" },
  { label: "Prize Pool", path: "/profile/prizes" },
  // NEO-172. The UserButton menu also links straight here, but a section that
  // exists only in that menu would be a page with no entry in the nav of the
  // shell it renders inside — no highlighted tab, and no way back to it from
  // the other sections.
  { label: "API Keys", path: "/profile/api-keys" },
  // NEO-356. Last on purpose (Jason, 2026-10-22): the sections above are the
  // seller's account and marketplace setup; this one is app preferences.
  { label: "Settings", path: "/profile/settings" },
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

/**
 * Keeps the lit section in view in the one-row strip: on a phone the strip
 * scrolls sideways, and a deep link to /profile/settings must not land with
 * its own tab off the right edge. Moves the strip only (scrollLeft), never
 * the page, and only when the tab is not already wholly visible.
 */
function useActiveTabInView() {
  const listRef = useRef<HTMLUListElement>(null);
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const fit = () => {
      const list = listRef.current;
      const active = list?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!list || !active) return;
      // The list is `relative`, so it is the tab's offsetParent.
      const left = active.offsetLeft;
      const right = left + active.offsetWidth;
      if (left < list.scrollLeft) list.scrollLeft = left;
      else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
    };
    fit();
    // Lexend arriving widens every label; fit again once it has.
    let live = true;
    document.fonts?.ready.then(() => {
      if (live) fit();
    });
    return () => {
      live = false;
    };
  }, [pathname]);
  return listRef;
}

export default function ProfileLayout() {
  useWarmProfileQueries();
  const listRef = useActiveTabInView();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2 text-ink">Profile Settings</h1>
        <p className="text-ink-3">
          Manage your account settings and credentials for supported platforms.
        </p>
      </div>

      <nav aria-label="Profile sections">
        {/* One row. On a phone it scrolls sideways (settling on a tab's
            start, or the last tab's end, so the lit tab can sit wholly in
            view at either end; mandatory snapping would pull a scroll to the
            last tab back to a start and cut it off), and the lit tab is kept
            in view; wrapping took three rows at 390px. The rule
            under the strip is an inset shadow on the list itself, under the
            tabs' 2px underline: a border on the nav would sit outside the
            scroller, and a -1px margin into it would make the list scroll
            vertically by a pixel. `relative` keeps any absolutely placed
            child inside the scroller instead of widening the page. A
            scroller clips what spills out of it, so each tab draws its focus
            outline inset (px-2 + gap-4 keeps the old 32px between labels). */}
        <ul
          ref={listRef}
          className="relative flex flex-nowrap gap-x-4 overflow-x-auto overscroll-x-contain snap-x snap-proximity [scrollbar-width:none] shadow-[inset_0_-1px_0_var(--rule)]"
        >
          {SECTIONS.map((section) => (
            <li key={section.path} className="shrink-0 snap-start last:snap-end">
              <NavLink
                to={section.path}
                className={({ isActive }) =>
                  "block whitespace-nowrap px-2 py-3 border-b-2 text-sm font-medium transition-colors focus-outline focus-visible:-outline-offset-4! rounded-sm " +
                  (isActive
                    ? "border-neon-purple text-neon-purple-text"
                    : "border-transparent text-ink-3 hover:text-ink hover:border-control")
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
