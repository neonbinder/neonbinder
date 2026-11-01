/**
 * NEO-410 — the status line under a smart binder sorted with empty slots:
 * nothing, "finding" (only once a recompute has run for a second), or the
 * failure with Try again. One live region, mounted with the binder, whose
 * words change, so a screen reader hears the failure when it lands. Try again
 * moves focus to the line first: the button goes away as the binder turns
 * pending, and focus must not fall to the page.
 */

import { useEffect, useRef, useState } from "react";
import NeonButton from "@/components/modules/NeonButton";

/** How long a recompute runs before the line says so. */
export const PENDING_SHOWN_AFTER_MS = 1000;

export const FINDING = "Finding cards for this rule…";
export const FAILED = "Couldn't work out which cards this rule wants. The empty slots may be out of date.";

export default function SmartFitsStatus({
  pending,
  failed,
  onRetry,
}: {
  pending: boolean;
  failed: boolean;
  onRetry: () => Promise<void>;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [pendingShown, setPendingShown] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPendingShown(true), PENDING_SHOWN_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setPendingShown(false);
    };
  }, [pending]);

  const retry = async () => {
    if (retrying) return;
    statusRef.current?.focus();
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="mt-3 flex min-h-5 flex-wrap items-center justify-center gap-3 text-sm text-ink-2">
      <p role="status" ref={statusRef} tabIndex={-1} className="text-center outline-none">
        {failed ? FAILED : pending && pendingShown ? FINDING : ""}
      </p>
      {failed && (
        <NeonButton
          type="button"
          variant="secondary"
          outline
          disabled={retrying}
          onClick={() => void retry()}
          className="min-h-10 max-sm:min-h-11"
        >
          Try again
        </NeonButton>
      )}
    </div>
  );
}
