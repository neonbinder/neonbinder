import { useCallback, useState } from "react";

/**
 * A tracking number with a Copy button — the app's ONE clipboard affordance.
 *
 * Extracted from PurchasedTracking in NEO-213, when label history became a
 * second place a seller copies a tracking number from. Keeping a single
 * implementation is the point: the interesting part is not `writeText`, it is
 * the *denied* branch. Clipboard access can be refused (permissions policy,
 * an iframe, an insecure context) and it refuses silently, so the fallback has
 * to tell the seller that the number is select-all text they can copy by hand.
 * A second copy button written from scratch would almost certainly ship the
 * happy path only.
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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(trackingCode);
      setCopyState("copied");
    } catch {
      // Clipboard access can be denied (permissions policy, iframe, or an
      // insecure context). The number is selectable text either way — say so
      // instead of failing silently.
      setCopyState("failed");
    }
  }, [trackingCode]);

  return (
    <span>
      {/* select-all: one click/tap selects the whole number, the manual
          fallback when the Copy button can't reach the clipboard. */}
      <code className="font-mono select-all">{trackingCode}</code>{" "}
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copyLabel}
        className="text-sm text-neon-teal hover:text-neon-teal/80 underline p-2 -m-2 focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
      >
        Copy
      </button>
      {/* Always mounted so the announcement is reliable: a live region
          inserted at the same moment its text appears is announced
          unreliably (notably VoiceOver). */}
      <span
        role="status"
        aria-live="polite"
        className="block text-xs text-slate-400"
      >
        {copyState === "copied"
          ? "Tracking number copied."
          : copyState === "failed"
            ? "Couldn't copy — select the number and copy it manually."
            : ""}
      </span>
    </span>
  );
}
