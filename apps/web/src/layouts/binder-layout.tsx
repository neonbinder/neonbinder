import { useState, useCallback } from "react";
import { Outlet } from "react-router";
import BinderHeader from "@/components/modules/binder-header";
import BinderTabs from "@/components/modules/binder-tabs";
import MobileNav from "@/components/modules/mobile-nav";

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
        </main>
        <BinderTabs />
        {mobileMenuOpen && <MobileNav onClose={closeMobileMenu} />}
      </div>
    </div>
  );
}
