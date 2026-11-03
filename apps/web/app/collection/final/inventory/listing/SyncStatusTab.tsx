import { useEffect, useRef } from "react";
import { SkeletonBars } from "../../catalog/Skeleton";
import { useListing, type ListingExtension } from "../../data/store";
import type { EbaySetupView, ListingPlatform } from "../../data/types";
import SyncStatusView from "./SyncStatusView";
import { takeSyncStatusArrival } from "./ListingGate";

/**
 * NEO-370 Rev 4 — Inventory → Sync status (`/inventory?tab=sync`): the
 * collector's own `SyncStatusView`, read live. What Sync on a checklist sets
 * going, what the next round will send, and how each set's last sync went.
 *
 * The view's one polite line says each step of a run as it lands and how
 * the run ended (NEO-415), so a collector who pressed Sync and came here
 * hears it land. The queue coming and going is not announced: it churns.
 *
 * Arriving by "See what's syncing" (NEO-370), the keyboard lands on the
 * first heading once the status is drawn (the intro line when there is
 * none), since the link it came from is gone.
 *
 * Hidden in a store with no listing (the demo): the page leaves the tab out.
 */
export default function SyncStatusTab() {
  const listing = useListing();
  if (!listing) return null;
  return <Status listing={listing} />;
}

/** A store without eBay has no setup to read. */
const noEbaySetup = (): EbaySetupView | undefined => undefined;

/** NEO-415 — eBay connected but its setup unfinished: nothing goes up there until it is. */
function unfinishedOf(ebay: EbaySetupView | undefined): ListingPlatform[] {
  return ebay && ebay.connected && !ebay.setupComplete ? ["ebay"] : [];
}

function Status({ listing }: { listing: ListingExtension }) {
  const status = listing.useSyncStatus();
  const useEbaySetup = listing.useEbaySetup ?? noEbaySetup;
  const unfinished = unfinishedOf(useEbaySetup());
  const root = useRef<HTMLDivElement>(null);
  const arrived = useRef<boolean | null>(null);
  useEffect(() => {
    if (arrived.current === null) arrived.current = takeSyncStatusArrival();
    if (!arrived.current || status === undefined || !root.current) return;
    arrived.current = false;
    const target = root.current.querySelector<HTMLElement>("h2, h3") ?? root.current.querySelector<HTMLElement>("p");
    if (!target) return;
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus();
  }, [status]);
  return (
    <div ref={root} className="space-y-4">
      <p className="text-sm text-ink-2">
        What&apos;s going up to your marketplaces, what&apos;s waiting, and how each set&apos;s last sync went. Changes go up
        within 15 minutes, or right away when you press Sync on a checklist.
      </p>
      {status === undefined ? (
        <div aria-busy="true">
          <SkeletonBars rows={5} />
        </div>
      ) : (
        <SyncStatusView status={status} loadProblems={listing.loadSetProblems} unfinishedSetup={unfinished} />
      )}
    </div>
  );
}
