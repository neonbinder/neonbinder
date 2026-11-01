import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import NeonButton from "@/components/modules/NeonButton";
import {
  BSC_NAME,
  CONSENT_LINE,
  PAUSED_LINE,
  PAUSED_START_LINE,
  REAUTH_LINE,
  SELLER_CONFLICT_LINE,
  listingDay,
} from "@/lib/marketplace/listing-copy";

/**
 * NEO-370 Rev 4 — listing on BuySportsCards, under the BSC sign-in on
 * Profile → Credentials. Consent lives where the sign-in is saved, so each
 * marketplace added later carries its own.
 *
 *   - no sign-in saved: nothing here (there is nothing to start);
 *   - saved, not listing: what starting does to listings they already have
 *     (`CONSENT_LINE`), then "Start listing on BuySportsCards". One way:
 *     there is no pause. Saving a sign-in alone never starts listing;
 *   - listing: since when, and that removing the sign-in stops listing and
 *     sales (re-saving it needs Start again);
 *   - a seller account that lists from another NB account: said in place of
 *     Start, which the server would refuse;
 *   - a dead sign-in, or BSC paused for everyone: said beside the state (a
 *     Start pressed while paused is refused, and says so).
 *
 * The outcome of Start is said on a polite status line that is always in
 * the tree. When Start succeeds its button goes, so focus moves to this
 * section's heading rather than falling to the page.
 */
export default function BscListingSection() {
  const settings = useQuery(api.listingSync.listingSettings, {});
  const start = useMutation(api.listingSync.startListing);
  const headingId = useId();
  const consentId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const started = useRef(false);

  const bsc = settings?.bsc;
  const listing = bsc?.listing === true;

  // Start swapped its button out: park focus on the heading.
  useEffect(() => {
    if (!listing || !started.current) return;
    started.current = false;
    headingRef.current?.focus();
  }, [listing]);

  if (!bsc || !bsc.connected) return null;

  const press = () => {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    start({ platform: "bsc" })
      .then(
        (result) => {
          if (result.started) {
            started.current = true;
            setSaid({ text: `You're live on ${BSC_NAME}. Your boxes go up within 15 minutes.`, tone: "ok" });
          } else if (result.reason === "sellerConflict") {
            setSaid({ text: SELLER_CONFLICT_LINE, tone: "warn" });
          } else if (result.reason === "paused") {
            setSaid({ text: PAUSED_START_LINE, tone: "warn" });
          } else {
            setSaid({ text: `Save your ${BSC_NAME} sign-in above first, then start listing.`, tone: "warn" });
          }
        },
        (error: unknown) =>
          setSaid({
            text: `Couldn't start listing on ${BSC_NAME}: ${error instanceof Error ? error.message : "try again in a moment"}.`,
            tone: "warn",
          }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-md border border-rule p-4">
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="rounded-sm text-lg font-semibold focus-outline">
        Listing on {BSC_NAME}
      </h3>

      {bsc.sellerConflict ? (
        // Checked first: a conflict holds pushing back even after listing started.
        <p className="text-sm text-notice-warn-ink">{SELLER_CONFLICT_LINE}</p>
      ) : listing ? (
        <div className="space-y-2 text-sm">
          <p className="text-notice-success-ink">
            {bsc.listingSince
              ? `Listing your boxes on ${BSC_NAME} since ${listingDay(bsc.listingSince)}.`
              : `Listing your boxes on ${BSC_NAME}.`}
          </p>
          <p className="text-ink-2">
            {`Every card in a listed box goes up at its box count, and sales land in Inventory, under Sales. Removing your ${BSC_NAME} sign-in stops listing and sales; saving it again means starting again here.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink-2">
            List every card in your boxes on {BSC_NAME}, at your box counts, priced at its minimum or the
            checklist&apos;s common price. A box set to in-person only stays off.
          </p>
          <p id={consentId} className="rounded-md border border-notice-warn-rule bg-notice-warn-bg p-3 text-notice-warn-ink">
            <strong className="block">Heads up before you start</strong>
            {CONSENT_LINE}
          </p>
          <NeonButton
            type="button"
            onClick={press}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            aria-describedby={consentId}
            className="max-sm:min-h-11"
          >
            {`Start listing on ${BSC_NAME}`}
          </NeonButton>
        </div>
      )}

      {bsc.paused && <p className="text-sm text-notice-warn-ink">{PAUSED_LINE}</p>}
      {bsc.needsReauth && !bsc.paused && <p className="text-sm text-notice-warn-ink">{REAUTH_LINE}</p>}

      {/* Always mounted: a live region inserted with its text is unreliably
          announced. A refusal is an alert; `key` remounts the node when the
          tone (and so the role) changes. */}
      <p
        key={said?.tone ?? "idle"}
        role={said?.tone === "warn" ? "alert" : "status"}
        aria-live={said?.tone === "warn" ? undefined : "polite"}
        aria-atomic="true"
        className={said ? `text-sm ${said.tone === "ok" ? "text-notice-success-ink" : "text-notice-warn-ink"}` : "sr-only"}
      >
        {said?.text ?? ""}
      </p>
    </section>
  );
}
