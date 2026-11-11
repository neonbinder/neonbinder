// First: the demo's sample sets and cards (1989 Score, Reggie White), before anything reads the catalog.
import "@/app/collection/final/data/sample";
import { useMemo } from "react";
import { Link } from "react-router";
import { ArrowUturnLeftIcon } from "@heroicons/react/24/outline";
import BinderLayout from "@/src/layouts/binder-layout";
import NeonButton from "@/components/modules/NeonButton";
import { NAV_ITEMS, type NavItem } from "@/components/modules/binder-tabs";

/**
 * NEO-464 — the dashboard demo is one app, the signed-in shell (header,
 * staircase, mobile menu, content column, scroll headroom) on fake data, for
 * anyone logged out. Its tabs are the shell's own Dashboard, Collection and
 * Inventory, pointed at the demo's pages, plus Back to the tour.
 *
 * The header keeps "Sign up free" where the account controls are signed out,
 * on every width; it is the demo's one sign-up link, so the tabs carry none.
 */

const BASE = "/demo";

/** One of the signed-in shell's tabs, by its label, at a demo path. */
function shellTab(label: string, path: string, end?: boolean): NavItem {
  const item = NAV_ITEMS.find((n) => n.label === label);
  if (!item) throw new Error(`No shell tab named ${label}`);
  return { label, path, icon: item.icon, hueClass: item.hueClass, end };
}

/** The demo's tabs. */
export function useDemoNavItems(): NavItem[] {
  return useMemo<NavItem[]>(() => {
    return [
      shellTab("Dashboard", BASE, true),
      shellTab("Collection", `${BASE}/collection`),
      shellTab("Inventory", `${BASE}/inventory?side=inventory`),
      { label: "Back to the tour", path: "/", icon: ArrowUturnLeftIcon, hueClass: "tab-hue-purple" },
    ];
  }, []);
}

export default function DashboardDemoLayout() {
  const items = useDemoNavItems();
  return (
    <BinderLayout
      navItems={items}
      headerActions={
        <NeonButton asChild>
          <Link to="/sign-up">Sign up free</Link>
        </NeonButton>
      }
    />
  );
}
