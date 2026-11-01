import type { ReactNode } from "react";
import { TagIcon } from "@heroicons/react/24/outline";
import { listingReadiness, type ListingReadiness } from "@/convex/lib/listingReadiness";
import { useListingGate } from "../../data/store";
import type { ContainerId, VariantId } from "../../data/types";
import { ParamLink } from "../../mode";

/**
 * NEO-370 — the listing gate on the screens that add cards to a box (the
 * inventory checklist, photo intake). A collector set up for syncing puts
 * cards in a box that lists on marketplaces only once they carry a price
 * and a condition; the server refuses anything else (`convex/listingGate.ts`)
 * and these screens hold the add back first, with the reason beside it.
 * Everyone else sees no change.
 *
 * Also here: "See what's syncing", the link to Inventory → Sync status shown
 * after a Sync press or "Done adding photos", to a collector who syncs.
 */

export interface ListingLock extends ListingReadiness {
  /** The add is held: the gate applies and something is missing. */
  locked: boolean;
  /** The collector is set up for syncing at all; false while loading. */
  syncing: boolean;
}

const OPEN: ListingLock = { locked: false, syncing: false, ready: true, needsPrice: false, needsCondition: false };

/**
 * Whether adds of a copy like this into `homeId` are held, by the server's
 * rule (`lib/listingReadiness`): the copy's own price, else the common price
 * for `variantId`, and its condition. Nothing is held while the gate loads
 * (the server still refuses an add that would not list).
 */
export function useListingLock(input: {
  homeId: ContainerId | null;
  variantId: VariantId | null;
  condition: string | undefined;
  ownPriceCents?: number;
  graded?: boolean;
}): ListingLock {
  const gate = useListingGate(input.homeId, input.variantId);
  if (!gate) return OPEN;
  const readiness = listingReadiness({
    applies: gate.applies,
    graded: input.graded,
    condition: input.condition,
    ownPriceCents: input.ownPriceCents,
    commonPriceCents: gate.commonPriceCents,
  });
  return { ...readiness, locked: !readiness.ready, syncing: gate.syncing };
}

/** The note's lead: what is missing, as a shout. */
function lead(missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">): string {
  if (missing.needsPrice && missing.needsCondition) return "Price and condition first!";
  return missing.needsPrice ? "Price tag first!" : "Condition first!";
}

/** Why the inventory checklist's counts are held, and where to fix it. */
export function checklistGateLine(homeName: string, missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">): string {
  const fixes = [
    missing.needsPrice ? "set a common price above" : null,
    missing.needsCondition ? "pick a default condition in Profile → Settings" : null,
  ].filter(Boolean);
  return `${lead(missing)} ${homeName} sells on your marketplaces, so ${fixes.join(" and ")} before you stock it.`;
}

/** Why photo intake's upload is held, and where to fix it. */
export function intakeGateLine(homeName: string, missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">): string {
  const fixes = [
    missing.needsPrice ? "give these cards a price in Defaults (or pick a set with a common price)" : null,
    missing.needsCondition ? "pick a condition in Defaults" : null,
  ].filter(Boolean);
  return `${lead(missing)} ${homeName} sells on your marketplaces, so ${fixes.join(" and ")} before you send photos.`;
}

/**
 * The held add's reason, beside the control it holds (that control points
 * here with `aria-describedby`). Text, with a tag icon for the eye only;
 * `children` is the fix when it sits right here (a button that opens the field).
 */
export function ListingGateNote({ id, line, children }: { id: string; line: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-notice-warn-rule bg-notice-warn-bg px-3 py-2 text-sm text-notice-warn-ink">
      <p id={id} className="m-0 flex min-w-0 flex-1 items-start gap-2">
        <TagIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0">{line}</span>
      </p>
      {children}
    </div>
  );
}

/** The words of the link to Inventory → Sync status. */
export const SYNC_STATUS_LINK = "See what's syncing";

/**
 * "See what's syncing": Inventory → Sync status (`?tab=sync`), a pushed
 * view, so Back comes straight back here.
 */
export function SyncStatusLink({ className = "" }: { className?: string }) {
  return (
    <ParamLink
      search={{ tab: "sync" }}
      className={`rounded-sm text-sm font-medium text-neon-yellow-text underline underline-offset-2 focus-outline ${className}`}
    >
      {SYNC_STATUS_LINK}
    </ParamLink>
  );
}
