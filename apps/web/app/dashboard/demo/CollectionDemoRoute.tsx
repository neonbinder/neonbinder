import { Navigate, useLocation } from "react-router";
import PublicCollectionDemo from "@/app/collection/final/PublicCollectionDemo";
import { SIDE_PARAM } from "@/app/collection/final/mode";
import type { Side } from "@/app/collection/final/data/types";

/**
 * NEO-464 — the Collection and Inventory tabs of the dashboard demo: the
 * collection demo's two sides, drawn inside the demo shell.
 *
 * The side is the URL's `side=` param, as it is in the collection demo
 * (`mode.tsx`, `sideOf`), so the Inventory tab carries `side=inventory` and
 * this route puts it back if a visitor opens the path without it.
 */
export default function DemoCollectionRoute({ side }: { side: Side }) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const onInventory = params.get(SIDE_PARAM) === "inventory";

  if (side === "inventory" && !onInventory) {
    params.set(SIDE_PARAM, "inventory");
    return <Navigate replace to={{ pathname, search: `?${params}` }} />;
  }
  if (side === "collection" && onInventory) {
    // The collection side is the default; `side=inventory` names the other tab.
    return <Navigate replace to={{ pathname: pathname.replace(/\/collection$/, "/inventory"), search }} />;
  }
  return <PublicCollectionDemo keepParams={{}} shell />;
}
