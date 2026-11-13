import { useConvexAuth, useMutation } from "convex/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only dashboard seeds (NEO-464). Signed in, open
//   /testing/seed-dashboard                 a paid order waiting to ship (the default)
//   /testing/seed-dashboard?sale=1          the same, named
//   /testing/seed-dashboard?syncPending=1   one card waiting for the next sync, per marketplace
//   /testing/seed-dashboard?syncError=1     one set whose last sync failed (a card held back), per marketplace
//   /testing/seed-dashboard?syncRecovered=1 that set after a later sync went through (it replaces a failed one: gone from the dashboard)
//   /testing/seed-dashboard?syncHeld=noLink  one set whose last sync went through but held a card back for
//                                            that reason (NEO-536: noLink, sharedLink, numberMismatch, notOnSheet,
//                                            rejected or missingAspect can be reported; any other reason is a
//                                            fix the collector makes), per marketplace
//   /testing/seed-dashboard?clear=1         take every seed above back off
// (combine them: ?sale=1&syncError=1&syncPending=1), then it forwards to
// `redirect` (default /dashboard; only a path on this site, see
// `seedRedirect`). Everything lands on the signed-in caller's own account,
// and nothing written makes NB call a marketplace for it (`convex/testing.ts`):
// the sale goes on a marketplace NB neither lists on nor polls for them, and
// the order poll leaves a seeded order out even once they list there. The sync
// seeds go on every listing marketplace (BuySportsCards and eBay), except a
// waiting card on one NB lists them on (a real sync would send it) and a
// failed set where that set has a real sync record; the readout names each
// marketplace and what it got.
//
// It exists because a sale only reaches NB from a marketplace's order poll,
// and a sync problem only from a real sync: neither can be made on demand.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutations
// themselves also fail closed on production Convex (no TESTING_RESET_SECRET there).

/** The held-back reasons a sync can record (`convex/schema.ts` `listingProblemReasonValidator`). */
export const SYNC_HELD_REASONS = [
  "noLink",
  "sharedLink",
  "numberMismatch",
  "noPrice",
  "priceTooHigh",
  "noCondition",
  "graded",
  "notOnSheet",
  "rejected",
  "missingAspect",
  "noPhoto",
  "setupIncomplete",
] as const;
export type SyncHeldReason = (typeof SYNC_HELD_REASONS)[number];

function heldReasonOf(raw: string | null): SyncHeldReason | undefined {
  return (SYNC_HELD_REASONS as readonly string[]).includes(raw ?? "") ? (raw as SyncHeldReason) : undefined;
}

/**
 * What the URL asks for. No ask at all is a sale. A set cannot be both failed
 * and recovered: the failed one wins. A held set (`syncHeld=<reason>`, NEO-536)
 * is one set's last sync too, so a failed or recovered ask beats it; an
 * unknown reason is no ask.
 */
export function seedsAsked(params: URLSearchParams): {
  clear: boolean;
  sale: boolean;
  syncPending: boolean;
  syncError: boolean;
  syncRecovered: boolean;
  syncHeld?: SyncHeldReason;
} {
  const on = (key: string) => params.get(key) === "1";
  const clear = on("clear");
  const syncPending = on("syncPending");
  const syncError = on("syncError");
  const syncRecovered = on("syncRecovered") && !syncError;
  const syncHeld = syncError || syncRecovered ? undefined : heldReasonOf(params.get("syncHeld"));
  const sale = on("sale") || (!clear && !syncPending && !syncError && !syncRecovered && syncHeld === undefined);
  return {
    clear,
    sale: !clear && sale,
    syncPending: !clear && syncPending,
    syncError: !clear && syncError,
    syncRecovered: !clear && syncRecovered,
    ...(!clear && syncHeld !== undefined ? { syncHeld } : {}),
  };
}

/**
 * Where the page forwards once done: `redirect` when it is a path on this
 * site ("/..."), else /dashboard. A protocol-relative or backslash form
 * ("//host", "/\host") or an absolute URL would leave the site.
 */
export function seedRedirect(params: URLSearchParams): string {
  const raw = params.get("redirect");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/dashboard";
  return raw;
}

/** One line per marketplace: what the sync seed wrote there, and why not when it skipped one. */
export function syncReadout(
  platforms: ReadonlyArray<{
    platform: string;
    pending: boolean;
    error: boolean;
    recovered?: boolean;
    held?: boolean;
    note?: string;
  }>,
): string[] {
  return platforms.map((p) => {
    const wrote = [
      p.pending ? "waiting card" : null,
      p.error ? "failed set" : null,
      p.recovered ? "recovered set" : null,
      p.held ? "held set" : null,
    ].filter((w) => w !== null);
    return `sync on ${p.platform}: ${wrote.length > 0 ? wrote.join(" + ") : "nothing"}${p.note ? ` (${p.note})` : ""}`;
  });
}

function TestingSeedDashboardContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const seedSale = useMutation(api.testing.seedMyTestSale);
  const seedSync = useMutation(api.testing.seedMyTestSync);
  const clearSeeds = useMutation(api.testing.clearMyTestDashboardSeeds);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = seedRedirect(searchParams);
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
        if (asked.syncPending || asked.syncError || asked.syncRecovered || asked.syncHeld !== undefined) {
          const r = await seedSync({
            pending: asked.syncPending,
            error: asked.syncError,
            recovered: asked.syncRecovered,
            ...(asked.syncHeld !== undefined ? { held: asked.syncHeld } : {}),
          });
          done.push(...syncReadout(r.platforms));
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
