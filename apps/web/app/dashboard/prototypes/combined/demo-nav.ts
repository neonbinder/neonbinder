import { useMemo, type ComponentType, type SVGProps } from "react";
import { useSearchParams, type To } from "react-router";
import { NAV_ITEMS } from "@/components/modules/binder-tabs";
import { DASHBOARD_BASE_PATH } from "../_shared/names";
import { PERSONA_PARAM } from "../_shared/persona";

/**
 * NEO-464 — the demo's three tabs, taken from the signed-in shell's own
 * `NAV_ITEMS` (labels, icons, hues) and pointed at public pages:
 * Dashboard → this page (keeping `?as=`), Collection → the collection demo,
 * Inventory → the inventory page.
 */

export interface DemoNavItem {
  label: string;
  to: To;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  hueClass: string;
}

const DEMO_PATHS: Record<string, string> = {
  Collection: "/binder-tracking?demo=on",
  Inventory: "/managing-inventory",
};

export function useDemoNav(): DemoNavItem[] {
  const [params] = useSearchParams();
  const as = params.get(PERSONA_PARAM);
  return useMemo(() => {
    const dashboard: To = { pathname: DASHBOARD_BASE_PATH, search: as ? `?${new URLSearchParams({ [PERSONA_PARAM]: as })}` : "" };
    return ["Dashboard", "Collection", "Inventory"].flatMap((label) => {
      const item = NAV_ITEMS.find((n) => n.label === label);
      if (!item) return [];
      return [{ label, to: label === "Dashboard" ? dashboard : DEMO_PATHS[label], icon: item.icon, hueClass: item.hueClass }];
    });
  }, [as]);
}
