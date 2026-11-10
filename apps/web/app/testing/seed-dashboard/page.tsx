import { useConvexAuth, useMutation } from "convex/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only dashboard seeds (NEO-464). Signed in, open
//   /testing/seed-dashboard                 a paid order waiting to ship (the default)
//   /testing/seed-dashboard?sale=1          the same, named
//   /testing/seed-dashboard?syncPending=1   one card waiting for the next sync
//   /testing/seed-dashboard?syncError=1     one set whose last sync failed, a card held back
//   /testing/seed-dashboard?clear=1         take every seed above back off
// (combine them: ?sale=1&syncError=1&syncPending=1), then it forwards to
// `redirect` (default /dashboard). Everything lands on the signed-in caller's
// own account, on a marketplace NB neither lists on nor polls for them, so no
// marketplace is ever called (`convex/testing.ts`).
//
// It exists because a sale only reaches NB from a marketplace's order poll,
// and a sync problem only from a real sync: neither can be made on demand.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutations
// themselves also fail closed on production Convex (no TESTING_RESET_SECRET there).

/** What the URL asks for. No ask at all is a sale. */
export function seedsAsked(params: URLSearchParams): { clear: boolean; sale: boolean; syncPending: boolean; syncError: boolean } {
  const on = (key: string) => params.get(key) === "1";
  const clear = on("clear");
  const syncPending = on("syncPending");
  const syncError = on("syncError");
  const sale = on("sale") || (!clear && !syncPending && !syncError);
  return { clear, sale: !clear && sale, syncPending: !clear && syncPending, syncError: !clear && syncError };
}

function TestingSeedDashboardContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const seedSale = useMutation(api.testing.seedMyTestSale);
  const seedSync = useMutation(api.testing.seedMyTestSync);
  const clearSeeds = useMutation(api.testing.clearMyTestDashboardSeeds);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status readout of an async driver effect; test-only page
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    // Wait for the Convex client to finish syncing the Clerk session token.
    if (isLoading) return;
    if (!isAuthenticated) {
      setStatus("Waiting for authentication...");
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;
    const asked = seedsAsked(searchParams);

    (async () => {
      try {
        const done: string[] = [];
        if (asked.clear) {
          const r = await clearSeeds({});
          done.push(`cleared ${r.sales} sale(s), ${r.queued} queued card(s), ${r.records} sync record(s)`);
        }
        if (asked.sale) {
          const r = await seedSale({});
          done.push(`sale ${r.orderNo} on ${r.platform}${r.matched ? "" : " (no card to name)"}`);
        }
        if (asked.syncPending || asked.syncError) {
          const r = await seedSync({ pending: asked.syncPending, error: asked.syncError });
          done.push(`sync records on ${r.platform}`);
        }
        setStatus(`Done: ${done.join("; ")} — redirecting...`);
        navigate(redirect);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        setStatus(`Error: ${msg}`);
      }
    })();
  }, [clearSeeds, seedSale, seedSync, isAuthenticated, isLoading, navigate, redirect, searchParams]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface">
      <p className="text-ink-3 font-mono text-sm">[testing-seed-dashboard] {status}</p>
    </div>
  );
}

export default function TestingSeedDashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-surface">
          <p className="text-ink-3 font-mono text-sm">[testing-seed-dashboard] Loading…</p>
        </div>
      }
    >
      <TestingSeedDashboardContent />
    </Suspense>
  );
}
