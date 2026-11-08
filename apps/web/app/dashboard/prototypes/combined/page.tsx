import { useCallback, useState } from "react";
import { Link, NavLink } from "react-router";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { BrandMark } from "@/components/primitives/BrandMark";
import NeonButton from "@/components/modules/NeonButton";
import { ModeRadioGroup } from "@/components/primitives/ModeRadioGroup";
import DemoThemeToggle from "@/app/collection/final/DemoThemeToggle";
import { useDocumentTitle } from "@/src/hooks/useDocumentTitle";
import { PERSONAS } from "../_shared/data";
import { usePersona } from "../_shared/persona";
import Dashboard from "./Dashboard";
import DemoMobileNav, { DEMO_MOBILE_NAV_ID } from "./DemoMobileNav";
import { useDemoNav } from "./demo-nav";

/**
 * NEO-464 — the combined dashboard, public and logged out at
 * `/dashboard-demo` on fake data, dressed as the signed-in app: the shell's
 * header (`components/modules/binder-header.tsx`), its staircase of tabs on
 * the right (`binder-tabs.tsx`; a menu dialog below `lg`, as `mobile-nav.tsx`),
 * and the same content column. The tabs are the shell's own Dashboard,
 * Collection and Inventory, pointed at public pages: Dashboard is this page,
 * Collection the collection demo, Inventory the inventory page.
 *
 * Under the header, the demo controls: who is looking (Collector / Dealer,
 * `?as=`) and Light / Dark, with the "UI prototype" note. The 1–5 switcher
 * is gone from here; `/dashboard-demo/1` … `/5` still work on their own.
 */
export default function CombinedDashboardPage() {
  useDocumentTitle("Dashboard | Neon Binder");
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const items = useDemoNav();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Wraps rather than scrolls at 320px; below sm the mark stands alone (the link keeps its name). */}
      <header className="pointer-events-none z-20 flex min-w-0 flex-row flex-wrap items-center justify-between gap-2 border-b-2 border-rule bg-surface p-4 max-sm:px-3 sm:sticky sm:top-0">
        <Link to="/" aria-label="Neon Binder home" className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-md focus-outline">
          <BrandMark />
          <span className="neon-header neon-header-sm text-wordmark max-sm:hidden">Neon Binder</span>
        </Link>
        <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-3 max-sm:gap-2">
          <NeonButton asChild>
            <Link to="/sign-up">Sign up free</Link>
          </NeonButton>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-outline lg:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? DEMO_MOBILE_NAV_ID : undefined}
            aria-haspopup="dialog"
          >
            {menuOpen ? <XMarkIcon className="h-6 w-6" aria-hidden="true" /> : <Bars3Icon className="h-6 w-6" aria-hidden="true" />}
          </button>
        </div>
      </header>
      <div className="relative flex flex-1">
        <main className="min-w-0 flex-1 lg:pr-[170px]">
          <div className="mx-auto max-w-6xl p-4 sm:p-6">
            <DemoControls />
            <div className="mt-6">
              <Dashboard />
            </div>
          </div>
          <div aria-hidden="true" className="h-[208px]" />
        </main>
        <DemoTabs items={items} />
        {menuOpen && <DemoMobileNav items={items} onClose={closeMenu} />}
      </div>
    </div>
  );
}

/**
 * The shell's tab staircase (`binder-tabs.tsx`), copied for the three demo
 * tabs: same classes, hues and stagger, `aria-current` from NavLink.
 */
function DemoTabs({ items }: { items: ReturnType<typeof useDemoNav> }) {
  return (
    <nav aria-label="Main" className="fixed right-0 top-1/2 z-30 hidden -translate-y-1/2 flex-col gap-2 lg:flex">
      {items.map((item, index) => (
        <NavLink
          key={item.label}
          to={item.to}
          end
          className={({ isActive }) =>
            `binder-tab ${item.hueClass} flex w-[170px] cursor-pointer items-center gap-3 rounded-l-xl py-4 pr-5 pl-4 transition-[transform,background-color,color,box-shadow] duration-200 ease-out focus-outline motion-reduce:transition-colors ${
              isActive ? "translate-x-0" : "translate-x-[10px] hover:translate-x-[4px]"
            }`
          }
          style={{ marginRight: `-${index * 6}px` }}
        >
          <item.icon className="h-6 w-6 shrink-0" aria-hidden="true" />
          <span className="text-base font-medium">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** Who is looking and Light / Dark: switches for judging the demo, not part of the app. */
function DemoControls() {
  const [persona, setPersona] = usePersona();

  return (
    <section aria-label="Demo controls" className="flex flex-col gap-3 rounded-xl border border-dashed border-rule-strong bg-raised px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-neon-blue" />
        <span className="font-semibold text-ink">Demo controls</span>
        <span>UI prototype · fake data</span>
      </p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <ModeRadioGroup label="Viewing as" value={persona} options={PERSONAS} onChange={setPersona} className="sm:flex-1" />
        <DemoThemeToggle className="sm:flex-1" />
      </div>
    </section>
  );
}
