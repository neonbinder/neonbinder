import { useCallback, useState, type ReactNode } from "react";

/**
 * The app's ONE clipboard affordance: a Copy button plus the live region that
 * says what happened.
 *
 * Extracted from TrackingCode in NEO-121, when the public scan-page link became
 * a second thing a seller copies off Label History. The interesting part has
 * never been `writeText` — it is the *denied* branch. Clipboard access can be
 * refused (permissions policy, an iframe, an insecure context) and it refuses
 * silently, so every caller has to be able to tell the seller what to do
 * instead. A second copy button written from scratch would almost certainly
 * ship the happy path only, which is exactly why this is shared code rather
 * than a four-line hook each caller re-implements.
 *
 * Renders a fragment of inline elements (`<button>` + `<span>`) and no wrapper
 * of its own, so a caller keeps full control of its own layout and markup —
 * TrackingCode's output is byte-for-byte what it was before the extraction.
 *
 * The status span is per-control ON PURPOSE. Label History gives each row one
 * shared `role="status"` for its reprint/refresh results; routing copy results
 * there too would let a copy announcement overwrite a reprint failure. A copy
 * is a local, instant, self-explanatory outcome — it announces next to the
 * button that caused it.
 *
 * @param value the exact text placed on the clipboard.
 * @param copyLabel accessible name, for pages that render more than one. Without
 * it every button on a 25-row history announces as the same bare "Copy" and a
 * screen-reader user cannot tell which one they are about to press.
 * @param copiedMessage what to announce on success — name the thing copied, not
 * "Copied.", so it still means something read out of context.
 * @param failedMessage what to announce when the clipboard refused. It must name
 * the manual fallback (select the text, open the link), because the seller has
 * no other way to learn the press did nothing.
 */
export default function CopyButton({
  value,
  copyLabel,
  copiedMessage,
  failedMessage,
  children = "Copy",
}: {
  value: string;
  copyLabel?: string;
  copiedMessage: string;
  failedMessage: string;
  children?: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      // Denied (permissions policy, iframe, or an insecure context). Say so —
      // the alternative is a button that silently does nothing.
      setCopyState("failed");
    }
  }, [value]);

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copyLabel}
        // `p-2 -m-2`: grows the hit area to WCAG 2.5.8's 24px minimum without
        // shifting the layout around it.
        className="text-sm text-neon-teal hover:text-neon-teal/80 underline p-2 -m-2 focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
      >
        {children}
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
          ? copiedMessage
          : copyState === "failed"
            ? failedMessage
            : ""}
      </span>
    </>
  );
}
