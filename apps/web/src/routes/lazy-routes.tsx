import { Suspense, useEffect, type ReactNode } from "react";

// The binder tabs' destinations, named so PrefetchBinderTabs can warm them.
export const loadDashboard = () => import("@/app/dashboard/page");
export const loadCollection = () => import("@/app/collection/page");
export const loadInventory = () => import("@/app/inventory/page");
export const loadAdminHub = () => import("@/app/admin/page");
export const loadPrintHub = () => import("@/app/print/page");
export const loadProfilePublic = () => import("@/app/profile/public/page");

export const BINDER_TAB_LOADERS: ReadonlyArray<() => Promise<unknown>> = [
  loadDashboard,
  loadCollection,
  loadInventory,
  loadAdminHub,
  loadPrintHub,
  loadProfilePublic,
];

/** A lazy route's element: a quiet line while its chunk loads. */
export function Deferred({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-slate-400">
          Sleeving the cards…
        </p>
      }
    >
      {children}
    </Suspense>
  );
}

/**
 * Warms the binder tabs' chunks once the signed-in shell is idle, so a tab
 * click shows its page straight away rather than "Sleeving the cards…" while
 * the chunk downloads. Rendered only inside the binder shell, so the public
 * pages never pay for it. `loaders` is a prop only so a test can stand in for
 * the real chunks.
 */
export function PrefetchBinderTabs({
  loaders = BINDER_TAB_LOADERS,
}: {
  loaders?: ReadonlyArray<() => Promise<unknown>>;
}) {
  useEffect(() => {
    const warm = () => {
      for (const load of loaders) {
        // A failed prefetch is harmless: the route retries when it renders.
        load().catch(() => {});
      }
    };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(warm, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 1500);
    return () => clearTimeout(id);
  }, [loaders]);
  return null;
}
