"use client";

import { useCallback, useState } from "react";

/**
 * NEO-182 — the tracking number from the last postage purchase, with a copy
 * button so the seller can paste it into SportLots right after buying.
 *
 * Rendered OUTSIDE the form-clearing lifecycle on purpose: a successful buy
 * wipes the Ship To form for the next package, and the number must survive
 * that wipe — it is the one artifact of the purchase the seller still needs.
 * It is replaced by the next purchase, never cleared by form edits.
 */
export default function PurchasedTracking({
  name,
  trackingCode,
}: {
  name: string;
  trackingCode: string;
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
    <div className="rounded-lg border border-neon-teal/30 p-3 text-center space-y-1">
      <p className="text-sm text-neon-green">
        Postage bought{name ? ` for ${name}` : ""} — the label is ready to mail.
      </p>
      <p className="text-sm">
        <span className="text-slate-400">Tracking:</span>{" "}
        {/* select-all: one click/tap selects the whole number, the manual
            fallback when the Copy button can't reach the clipboard. */}
        <code className="font-mono select-all">{trackingCode}</code>{" "}
        <button
          type="button"
          onClick={() => void copy()}
          className="text-sm text-neon-teal hover:text-neon-teal/80 underline p-2 -m-2 focus:outline-none focus:ring-2 focus:ring-green-500 rounded-sm"
        >
          Copy
        </button>
      </p>
      {/* Always mounted so the announcement is reliable. */}
      <p role="status" aria-live="polite" className="text-xs text-slate-400">
        {copyState === "copied"
          ? "Tracking number copied."
          : copyState === "failed"
            ? "Couldn't copy — select the number and copy it manually."
            : ""}
      </p>
    </div>
  );
}
