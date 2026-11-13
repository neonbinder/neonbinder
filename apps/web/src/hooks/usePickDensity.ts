import { useCallback, useSyncExternalStore } from "react";

/**
 * NEO-522 — how the Pick List draws its rows on this device: "spacious" (read
 * from across the room, the default) or "condensed" (the denser pre-NEO-522
 * screen). A device preference, not a filter: it lives in this browser's
 * storage, never in the URL, so the card-room monitor and a laptop can differ,
 * and "Back to default" leaves it alone. The page frame reads it too: only a
 * spacious Pick List opens to the wide page.
 */
export type PickDensity = "spacious" | "condensed";

export const PICK_DENSITY_KEY = "nb.pickList.density";

const DEFAULT: PickDensity = "spacious";

/** What this browser saved; spacious when nothing is saved or storage is unavailable. */
export function readPickDensity(): PickDensity {
  try {
    return window.localStorage.getItem(PICK_DENSITY_KEY) === "condensed" ? "condensed" : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

let current: PickDensity | null = null;
const listeners = new Set<() => void>();

function snapshot(): PickDensity {
  current ??= readPickDensity();
  return current;
}

function emit() {
  for (const listener of listeners) listener();
}

/** Switch every Pick List and page frame on this device; kept for this visit even when storage refuses it. */
export function setPickDensity(next: PickDensity): void {
  current = next;
  try {
    window.localStorage.setItem(PICK_DENSITY_KEY, next);
  } catch {
    // Private mode or blocked storage: the choice still holds until the page reloads.
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab on this device switched it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PICK_DENSITY_KEY) return;
    current = readPickDensity();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** For tests: forget what this visit holds, so the next read goes back to storage. */
export function resetPickDensityForTests(): void {
  current = null;
  emit();
}

export function usePickDensity(): [PickDensity, (next: PickDensity) => void] {
  const density = useSyncExternalStore(subscribe, snapshot, () => DEFAULT);
  const set = useCallback((next: PickDensity) => setPickDensity(next), []);
  return [density, set];
}

/** The Pick List's own pages, signed in and in the demo: `/inventory?tab=pick`, `/demo/inventory?tab=pick`. */
export function isPickListPage(pathname: string, search: string): boolean {
  return (pathname === "/inventory" || pathname === "/demo/inventory") && new URLSearchParams(search).get("tab") === "pick";
}

/** Whether the page frame opens to the wide page: a spacious Pick List only. */
export function useWidePickPage(pathname: string, search: string): boolean {
  const [density] = usePickDensity();
  return density === "spacious" && isPickListPage(pathname, search);
}
