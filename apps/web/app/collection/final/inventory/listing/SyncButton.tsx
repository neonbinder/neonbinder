import { useId, useState } from "react";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import NeonButton from "@/components/modules/NeonButton";
import { FOCUS } from "../../../prototypes/p1/ui";
import { useListing, writeErrorMessage, type ListingExtension } from "../../data/store";
import type { ListingSettings, SyncVariantResult, VariantId } from "../../data/types";
import { usePageApi } from "../../pageApi";

/**
 * NEO-370 Rev 4/5 — "Sync", top right of an inventory checklist's header. One
 * press reads this set's sheet on every platform the collector lists on, sets
 * every card there to NB's box counts, and pushes (throttled on the server).
 * The checklist carries no listing status: the toast says what happened and
 * points to the Sync status tab, where the result lands.
 *
 * Shown, but inert with its reason, while nothing lists anywhere (Rev 5: a
 * saved, unpaused marketplace sign-in on the Profile is what syncs):
 * `aria-disabled`, never native `disabled`, so it stays in the tab order and
 * the reason is read with it. A press while inert
 * says the reason on the status line too, for anyone who can't see the
 * dimmed button's description.
 *
 * Hidden in a store with no listing (the demo).
 */
export default function SyncButton({ variantId, title }: { variantId: VariantId; title: string }) {
  const listing = useListing();
  if (!listing) return null;
  return <Sync listing={listing} variantId={variantId} title={title} />;
}

/** True when the collector lists on at least one platform. */
export function listsAnywhere(settings: ListingSettings | undefined): boolean {
  return !!settings && Object.values(settings).some((p) => p.listing);
}

/** Said when nothing can sync: no saved, unpaused marketplace sign-in anywhere. */
export const NOT_LISTING_LINE = "Nothing to sync to yet. Save a marketplace sign-in on your Profile.";

/** What the toast says after a press. */
export function syncToast(title: string, result: SyncVariantResult): string {
  if (result.queued) return `Syncing ${title} now. Watch it on Sync status.`;
  if (result.ignored === "throttled") return `${title} just synced. Give it a minute, then Sync again.`;
  if (result.ignored === "notListing") return NOT_LISTING_LINE;
  // Taken by no platform: no card in the set links to anywhere the collector lists.
  return `Nothing in ${title} links to a marketplace you list on, so there's nothing to sync.`;
}

function Sync({ listing, variantId, title }: { listing: ListingExtension; variantId: VariantId; title: string }) {
  const api = usePageApi();
  const settings = listing.useSettings();
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const loading = settings === undefined;
  const canSync = listsAnywhere(settings);
  const inert = busy || loading || !canSync;

  const press = () => {
    if (busy || loading) return;
    if (!canSync) {
      api.notify(NOT_LISTING_LINE);
      return;
    }
    setBusy(true);
    listing
      .syncVariant(variantId)
      .then(
        (result) => api.notify(syncToast(title, result)),
        (error: unknown) => api.notify(writeErrorMessage(error)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <NeonButton
        type="button"
        size="1"
        variant="secondary"
        outline
        onClick={press}
        aria-label={`Sync ${title}`}
        aria-disabled={inert || undefined}
        aria-busy={busy || loading || undefined}
        aria-describedby={!loading && !canSync ? reasonId : undefined}
        className={`${FOCUS} shrink-0 max-sm:min-h-11`}
      >
        <ArrowPathIcon aria-hidden="true" className={`h-4 w-4 ${busy ? "motion-safe:animate-spin" : ""}`} />
        Sync
      </NeonButton>
      {!loading && !canSync && (
        <span id={reasonId} hidden>
          {NOT_LISTING_LINE}
        </span>
      )}
    </>
  );
}
