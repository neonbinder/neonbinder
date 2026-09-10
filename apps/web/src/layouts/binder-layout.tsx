import { useState, useCallback } from "react";
import { Outlet } from "react-router";
import BinderHeader from "@/components/modules/binder-header";
import BinderTabs from "@/components/modules/binder-tabs";
import MobileNav from "@/components/modules/mobile-nav";

/**
 * SCROLL HEADROOM — 208px of empty, non-interactive space below every page in
 * the signed-in shell (NEO-260). The public marketing shells under `app/`
 * carry the same 208px for the same reason; keep them in step.
 *
 * THE PROBLEM. No page had any headroom, so the document bottomed out with the
 * page's primary action pinned to the bottom edge of the viewport. Measured at
 * rest, at maximum scroll, on the 1024x629 headless viewport (625px of
 * document height): the last control on a page parks between y=469 and y=569,
 * i.e. 55-155px above the fold with nothing under it. That is bad for the
 * person using the page, and it is also what stalls the E2E driver: it wants a
 * target inside its centre band, [0.4h, 0.6h] = [250, 375], and keeps swiping
 * at a document that cannot move any further.
 *
 * THE ARITHMETIC. Only what sits BELOW an element fixes where that element
 * parks, so headroom H moves it from y to y - H. Landing every measured case
 * inside the band needs
 *
 *     H >= 569 - 375 = 194   (the lowest-parking control, "Add to sheet")
 *     H <= 469 - 250 = 219   (the highest, the marketing pages' CTA)
 *
 * so one value in [194, 219] covers the whole app. 208px sits mid-window:
 * worst case 569 -> 361 (14px inside the band), best case 469 -> 261 (11px
 * inside). Overshooting matters as much as undershooting — too much headroom
 * lifts a target ABOVE the band, which fails the same way.
 *
 * NOT vh. NEO-255 tried `pb-[50vh]` and it was reverted: at this viewport 50vh
 * is 313px, which is exactly one swipe of the headless driver (measured
 * 432->119, 600->287, 533->220, 615->302), so it handed every downward scroll
 * a whole extra swipe of travel and flows that scroll down to a bottom anchor
 * sailed past it. 208px is 66% of a swipe — the window above forces it over
 * half, but the property that matters is that it is never a whole one. Keep it
 * a fixed px value; a viewport-relative unit re-creates that failure on any
 * viewport where it happens to equal a swipe.
 *
 * WHY HERE AND NOT ON <body>. `main` is `flex-1` inside a `min-h-screen`
 * column, so this spacer only lengthens the document once real content comes
 * within 208px of filling the fold — a page shorter than that still does not
 * scroll and gains no scrollbar. It also sits OUTSIDE the view-transition
 * element below, so the `page-content` snapshot box is unchanged.
 */
export default function BinderLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);

  return (
    <div className="min-h-screen flex flex-col">
      <BinderHeader
        isMobileMenuOpen={mobileMenuOpen}
        onMobileMenuToggle={() => setMobileMenuOpen((prev) => !prev)}
      />
      <div className="flex flex-1 relative">
        {/* min-w-0 lets this flex item shrink below its content's min-content
            width, so a descendant with overflow-x-auto (the set-selector
            cascade columns row) scrolls internally instead of forcing <main>
            wider than the viewport. Without it, flexbox's default
            min-width:auto pins main to its widest child, the document scrolls
            horizontally, and a deep column slides under the fixed nav (NEO-63). */}
        <main className="flex-1 min-w-0 lg:pr-[170px]">
          <div
            className="max-w-6xl mx-auto p-6"
            style={{ viewTransitionName: "page-content" }}
          >
            <Outlet />
          </div>
          {/* Scroll headroom — read the SCROLL HEADROOM note on this component
              before changing or deleting this. */}
          <div aria-hidden="true" className="h-[208px]" />
        </main>
        <BinderTabs />
        {mobileMenuOpen && <MobileNav onClose={closeMobileMenu} />}
      </div>
    </div>
  );
}
