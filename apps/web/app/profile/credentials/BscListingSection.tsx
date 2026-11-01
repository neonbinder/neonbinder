import { useId } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  BSC_NAME,
  NOT_SYNCING_LINE,
  PAUSED_LINE,
  REAUTH_LINE,
  SELLER_CONFLICT_LINE,
  listingDay,
} from "@/lib/marketplace/listing-copy";

/**
 * NEO-370 Rev 5 — where BuySportsCards syncing stands, under the BSC sign-in
 * on Profile → Credentials. A saved, unpaused sign-in IS syncing: listing
 * and sales. There is no Start; the consent is said beside Connect on the
 * sign-in form, before the sign-in is saved (`LISTING_CONSENT`).
 *
 *   - no sign-in saved: nothing shows (the warning is on the form);
 *   - a seller account that lists from another NB account: that, first,
 *     because it holds everything back whatever else is true;
 *   - listing: since when, and that removing the sign-in stops listing and
 *     sales;
 *   - BSC paused for everyone: the paused line;
 *   - saved but not syncing for none of those reasons: a plain "Not
 *     syncing." (only a testing account gets here);
 *   - a dead sign-in: said beside whichever of the above.
 *
 * Nothing here is a control. The state line is one polite live region that
 * stays mounted from before the sign-in is saved, so the moment Connect
 * succeeds and syncing begins ("Listing your boxes … since …") is announced,
 * not just drawn. (Rev 4's focus parking went with the Start button: no
 * control here swaps out under focus.)
 */
export default function BscListingSection() {
  const settings = useQuery(api.listingSync.listingSettings, {});
  const headingId = useId();
  const bsc = settings?.bsc;
  const shown = !!bsc && bsc.connected;

  let line = "";
  let tone = "text-ink-2";
  if (shown) {
    if (bsc.sellerConflict) {
      line = SELLER_CONFLICT_LINE;
      tone = "text-notice-warn-ink";
    } else if (bsc.listing) {
      line = bsc.listingSince
        ? `Listing your boxes on ${BSC_NAME} since ${listingDay(bsc.listingSince)}.`
        : `Listing your boxes on ${BSC_NAME}.`;
      tone = "text-notice-success-ink";
    } else if (bsc.paused) {
      line = PAUSED_LINE;
      tone = "text-notice-warn-ink";
    } else {
      line = NOT_SYNCING_LINE;
    }
  }
  const pausedBeside = shown && bsc.paused && line !== PAUSED_LINE;
  const reauthBeside = shown && bsc.needsReauth && !bsc.paused;

  return (
    // `contents` while hidden: the box takes no room in the page's spacing,
    // but the live region inside it stays in the tree.
    <section
      aria-labelledby={shown ? headingId : undefined}
      className={shown ? "space-y-3 rounded-md border border-rule p-4" : "contents"}
    >
      {shown && (
        <h3 id={headingId} className="text-lg font-semibold">
          Listing on {BSC_NAME}
        </h3>
      )}
      <p role="status" aria-live="polite" aria-atomic="true" className={shown ? `text-sm ${tone}` : "sr-only"}>
        {line}
      </p>
      {shown && bsc.listing && !bsc.sellerConflict && (
        <p className="text-sm text-ink-2">
          {`Every card in a listed box goes up at its box count, and sales land in Inventory, under Sales. Removing your ${BSC_NAME} sign-in stops listing and sales.`}
        </p>
      )}
      {pausedBeside && <p className="text-sm text-notice-warn-ink">{PAUSED_LINE}</p>}
      {reauthBeside && <p className="text-sm text-notice-warn-ink">{REAUTH_LINE}</p>}
    </section>
  );
}
