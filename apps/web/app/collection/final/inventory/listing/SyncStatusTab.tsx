import { SkeletonBars } from "../../catalog/Skeleton";
import { useListing, type ListingExtension } from "../../data/store";
import SyncStatusView from "./SyncStatusView";

/**
 * NEO-370 Rev 4 — Inventory → Sync status (`/inventory?tab=sync`): the
 * collector's own `SyncStatusView`, read live. What Sync on a checklist sets
 * going, what the next round will send, and how each set's last sync went.
 *
 * Hidden in a store with no listing (the demo): the page leaves the tab out.
 */
export default function SyncStatusTab() {
  const listing = useListing();
  if (!listing) return null;
  return <Status listing={listing} />;
}

function Status({ listing }: { listing: ListingExtension }) {
  const status = listing.useSyncStatus();
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        What&apos;s going up to your marketplaces, what&apos;s waiting, and how each set&apos;s last sync went. Changes go up
        within 15 minutes, or right away when you press Sync on a checklist.
      </p>
      {status === undefined ? (
        <div aria-busy="true">
          <SkeletonBars rows={5} />
        </div>
      ) : (
        <SyncStatusView status={status} loadProblems={listing.loadSetProblems} />
      )}
    </div>
  );
}
