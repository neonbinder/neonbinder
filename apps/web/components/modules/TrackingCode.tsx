import CopyButton from "./CopyButton";

/**
 * A tracking number with a Copy button.
 *
 * Extracted from PurchasedTracking in NEO-213, when label history became a
 * second place a seller copies a tracking number from. NEO-121 then pushed the
 * clipboard half down into `CopyButton`, because the public scan-page link on
 * the same row needed the same *denied* branch — that fallback is the whole
 * reason any of this is shared code. What is left here is the pairing that is
 * specific to a tracking number: select-all text next to the button, and the
 * wording of the two announcements.
 *
 * Renders inline elements exclusively (`<span>`/`<code>`/`<button>`), so it is
 * valid inside a `<p>` (PurchasedTracking) as well as a `<dd>` (label history).
 *
 * @param copyLabel accessible name for the button, for pages that render more
 * than one row. Without it every button on a 25-row history announces as the
 * same bare "Copy" and a screen-reader user cannot tell which label they are
 * about to copy from.
 */
export default function TrackingCode({
  trackingCode,
  copyLabel,
}: {
  trackingCode: string;
  copyLabel?: string;
}) {
  return (
    <span>
      {/* select-all: one click/tap selects the whole number, the manual
          fallback when the Copy button can't reach the clipboard. */}
      <code className="font-mono select-all">{trackingCode}</code>{" "}
      <CopyButton
        value={trackingCode}
        copyLabel={copyLabel}
        copiedMessage="Tracking number copied."
        // The number is selectable text either way — say so rather than fail
        // silently.
        failedMessage="Couldn't copy — select the number and copy it manually."
      />
    </span>
  );
}
