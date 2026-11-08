import type { ReactNode } from "react";
import { Link } from "react-router";
import { TagIcon } from "@heroicons/react/24/outline";
import {
  intakeRunReadiness,
  listingReadiness,
  type IntakeRunReadiness,
  type ListingReadiness,
} from "@/convex/lib/listingReadiness";
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

export interface IntakeRunLock extends IntakeRunReadiness {
  /** The listing hold: a price or a condition is missing. A missing set is `needsSet`. */
  locked: boolean;
  /** The collector is set up for syncing at all; false while loading. */
  syncing: boolean;
  /** The gate has answered for this home and set. */
  loaded: boolean;
  /** The picked set holds no card to match against. The server refuses a run on it. */
  setHasNoCards: boolean;
}

/**
 * NEO-452 — the same answer for an Add cards run, by `intakeRunReadiness`. Unlike
 * `useListingLock`, which reads as open while the gate loads, this says `loaded`
 * and is never `ready` until then: Add cards sends photos by itself the moment it
 * is ready, so "not known yet" must not look like "nothing is missing".
 *
 * A set with no cards is never ready, and asks for nothing else: a price wouldn't
 * get those photos anywhere, so the next move is another set.
 */
export function useIntakeRunLock(input: {
  homeId: ContainerId | null;
  variantId: VariantId | null;
  condition: string | undefined;
  ownPriceCents?: number;
  graded?: boolean;
}): IntakeRunLock {
  const gate = useListingGate(input.homeId, input.variantId);
  const hasVariant = input.variantId !== null;
  if (!gate) {
    return {
      ready: false,
      needsSet: !hasVariant,
      needsPrice: false,
      needsCondition: false,
      locked: false,
      syncing: false,
      loaded: false,
      setHasNoCards: false,
    };
  }
  if (gate.variantHasCards === false) {
    return {
      ready: false,
      needsSet: false,
      needsPrice: false,
      needsCondition: false,
      locked: false,
      syncing: gate.syncing,
      loaded: true,
      setHasNoCards: true,
    };
  }
  const readiness = intakeRunReadiness({
    applies: gate.applies,
    graded: input.graded,
    condition: input.condition,
    ownPriceCents: input.ownPriceCents,
    commonPriceCents: gate.commonPriceCents,
    hasVariant,
  });
  return {
    ...readiness,
    locked: readiness.needsPrice || readiness.needsCondition,
    syncing: gate.syncing,
    loaded: true,
    setHasNoCards: false,
  };
}

/** The note's lead: what is missing, as a shout. */
function lead(missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">): string {
  if (missing.needsPrice && missing.needsCondition) return "Price and condition first!";
  return missing.needsPrice ? "Price tag first!" : "Condition first!";
}

/** Where a collector sets their default condition. */
export const SETTINGS_PATH = "/profile/settings";
const SETTINGS_WORDS = "Profile → Settings";

/** Why the inventory checklist's counts are held, and where to fix it. */
export function checklistGateLine(homeName: string, missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">): string {
  const fixes = [
    missing.needsPrice ? "set a common price above" : null,
    missing.needsCondition ? `pick a default condition in ${SETTINGS_WORDS}` : null,
  ].filter(Boolean);
  return `${lead(missing)} ${homeName} sells on your marketplaces, so ${fixes.join(" and ")} before you stock it.`;
}

/**
 * `checklistGateLine` with "Profile → Settings" as a real link there (the
 * same words, so the note reads exactly as the line).
 */
export function ChecklistGateText({
  homeName,
  missing,
}: {
  homeName: string;
  missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">;
}) {
  const line = checklistGateLine(homeName, missing);
  const at = missing.needsCondition ? line.indexOf(SETTINGS_WORDS) : -1;
  if (at < 0) return <>{line}</>;
  return (
    <>
      {line.slice(0, at)}
      <Link
        to={SETTINGS_PATH}
        className="rounded-sm font-semibold underline underline-offset-2 focus-outline max-sm:inline-block max-sm:py-2"
      >
        {SETTINGS_WORDS}
      </Link>
      {line.slice(at + SETTINGS_WORDS.length)}
    </>
  );
}

/**
 * Why photo intake is held, and where to fix it. While the run still takes
 * photos they go up once it's fixed; once it doesn't, the same price is still
 * what its saves need.
 */
export function intakeGateLine(
  homeName: string,
  setName: string | null,
  missing: Pick<ListingReadiness, "needsPrice" | "needsCondition">,
  { collecting = true }: { collecting?: boolean } = {},
): string {
  const sells = missing.needsPrice
    ? `${homeName} sells on your marketplaces and ${setName ?? "this set"} has no price yet.`
    : `${homeName} sells on your marketplaces.`;
  const what = missing.needsPrice && missing.needsCondition ? "Set both" : missing.needsPrice ? "Set one" : "Pick one";
  const then = collecting ? "and your photos go up." : "before you save these cards.";
  return `${lead(missing)} ${sells} ${what} in Defaults ${then}`;
}

/**
 * The held add's reason, near the control it concerns (that control points
 * here with `aria-describedby`). Text, with a tag icon for the eye only;
 * `children` is the fix when it sits right here (a button that opens the field).
 */
export function ListingGateNote({ id, line, children }: { id: string; line: ReactNode; children?: ReactNode }) {
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

/** Set by a plain click on "See what's syncing"; Sync status takes it once to move focus to its heading. */
let arrivingAtSyncStatus = false;

/** True once after a click on "See what's syncing" (the link's own view moves focus then). */
export function takeSyncStatusArrival(): boolean {
  const was = arrivingAtSyncStatus;
  arrivingAtSyncStatus = false;
  return was;
}

/**
 * "See what's syncing": Inventory → Sync status (`?tab=sync`), a pushed
 * view, so Back comes straight back here. The link it was unmounts on the
 * way, so Sync status puts the keyboard on its first heading
 * (`takeSyncStatusArrival`).
 */
export function SyncStatusLink({ className = "" }: { className?: string }) {
  return (
    <ParamLink
      search={{ tab: "sync" }}
      onClick={(e) => {
        if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) arrivingAtSyncStatus = true;
      }}
      className={`rounded-sm text-sm font-medium text-neon-yellow-text underline underline-offset-2 focus-outline sm:py-0.5 ${className}`}
    >
      {SYNC_STATUS_LINK}
    </ParamLink>
  );
}
