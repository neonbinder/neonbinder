import { createContext, useContext } from "react";
import type { PickListStore } from "./types";

/**
 * NEO-500 — where the Pick List reads its store. The demo mounts
 * `DemoPickListProvider` (`./demoPickStore`); the signed-in app will mount a
 * Convex-backed provider supplying the same `PickListStore`. Null: no store
 * mounted (`PickListTab` falls back to the demo's).
 */
export const PickListStoreContext = createContext<PickListStore | null>(null);

export function usePickListStore(): PickListStore {
  const store = useContext(PickListStoreContext);
  if (!store) throw new Error("usePickListStore: no Pick List store mounted");
  return store;
}
