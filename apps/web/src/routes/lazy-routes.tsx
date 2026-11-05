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

/** The quiet line shown while a page's code is on its way. */
export function LoadingLine() {
  return (
    <p role="status" className="text-sm text-ink-3">
      Sleeving the cards…
    </p>
  );
}

/** A lazy route's element: a quiet line while its chunk loads. */
export function Deferred({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingLine />}>{children}</Suspense>;
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
        // A failed prefetch never touches the page in front of the user. The
        // browser may remember the failure for this document, so the route's
        // own import can fail later; the boundary's reload recovers that
        // (chunk-reload.tsx).
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
