import TrackingCode from "./TrackingCode";

/**
 * NEO-182 — the tracking number from the last postage purchase, with a copy
 * button so the seller can paste it into a marketplace right after buying.
 *
 * Rendered OUTSIDE the form-clearing lifecycle on purpose: a successful buy
 * wipes the Ship To form for the next package, and the number must survive
 * that wipe — it is the one artifact of the purchase the seller still needs.
 * It is replaced by the next purchase, never cleared by form edits.
 *
 * The copy affordance itself moved to {@link TrackingCode} in NEO-213, so this
 * component and the label-history rows share one implementation of the
 * clipboard's denied branch rather than two.
 */
export default function PurchasedTracking({
  name,
  trackingCode,
}: {
  name: string;
  trackingCode: string;
}) {
  return (
    <div className="rounded-lg border border-neon-teal/30 p-3 text-center space-y-1">
      <p className="text-sm text-neon-green">
        Postage bought{name ? ` for ${name}` : ""} — the label is ready to mail.
      </p>
      <p className="text-sm">
        <span className="text-slate-400">Tracking:</span>{" "}
        <TrackingCode trackingCode={trackingCode} />
      </p>
    </div>
  );
}
