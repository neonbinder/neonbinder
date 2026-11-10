import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

/**
 * NEO-487 — "Waiting on BuySportsCards… 12s".
 *
 * A marketplace call can sit for a long while (a 30 s stall, a cooldown after
 * a 429), and a spinner that says nothing reads as NeonBinder hanging. This
 * line names who we are waiting on and for how long, wherever a checklist
 * fetch, Build from Base or a listing step is held up by one.
 *
 * ## When it shows
 *
 * Only while a call is outstanding: the host passes `waitingSince` (from the
 * server's call recorder) only while its own work is still pending, and the
 * line is empty otherwise. The region itself is always mounted, so the first
 * wait is announced as reliably as the rest.
 *
 * ## The seconds
 *
 * Counted on the CLIENT's clock from the moment this component first saw
 * that `waitingSince`, never from the server timestamp: the two clocks are
 * not the same clock, and a skewed laptop would otherwise open on "-4s" or
 * "93s". A new `waitingSince` is a new wait and starts again from 0.
 *
 * ## Screen readers
 *
 * `role="status"` carries the sentence; the running seconds are
 * `aria-hidden`, so the wait is announced once rather than every second.
 *
 * The marketplace's name is display text only — nothing keys on it.
 */

/** "Waiting on BuySportsCards…" — the sentence the E2E suite matches. */
export function waitingText(marketplace: string): string {
  return `Waiting on ${marketplace}…`;
}

/**
 * Whole seconds since this client first saw `since`, ticking once a second;
 * 0 when `since` is absent. Every state write is in the timer callback.
 */
function useClientSeconds(since: number | undefined): number {
  const [clock, setClock] = useState<{ since: number; at: number; now: number } | null>(null);
  useEffect(() => {
    if (since === undefined) return;
    const at = Date.now();
    const id = window.setInterval(() => setClock({ since, at, now: Date.now() }), 1000);
    return () => window.clearInterval(id);
  }, [since]);
  if (since === undefined || !clock || clock.since !== since) return 0;
  return Math.max(0, Math.floor((clock.now - clock.at) / 1000));
}

export function WaitingOnMarketplace({
  waitingSince,
  marketplace,
  className = "",
}: {
  /** The recorder's start of the outstanding call; absent = not waiting. */
  waitingSince?: number;
  /** Display name, e.g. "BuySportsCards". */
  marketplace: string;
  className?: string;
}) {
  const seconds = useClientSeconds(waitingSince);
  const waiting = waitingSince !== undefined;
  return (
    <p
      role="status"
      data-marketplace-wait=""
      className={`items-center gap-2 text-sm text-ink-2 ${waiting ? "flex" : "hidden"} ${className}`}
    >
      {waiting && (
        <>
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full bg-neon-yellow-text shadow-[0_0_8px_var(--color-neon-yellow)] motion-safe:animate-pulse"
          />
          <span>{waitingText(marketplace)}</span>
          <span aria-hidden="true" className="tabular-nums text-ink-3">
            {seconds}s
          </span>
        </>
      )}
    </p>
  );
}

/**
 * The same line for a run the CLIENT keyed: the host minted `runKey`, passed
 * it to the action, and holds `active` true while that action is pending.
 * Subscribes to `marketplaceWaits.forRun` only while active.
 *
 * The query reference is read defensively: component tests hand-build a
 * partial `api` mock, and a module they do not list must read as "no wait"
 * rather than throw at render.
 */
export function WaitingOnMarketplaceRun({
  runKey,
  active,
  marketplace,
  className,
}: {
  runKey: string | null;
  active: boolean;
  marketplace: string;
  className?: string;
}) {
  const forRun = api.marketplaceWaits?.forRun;
  const wait = useQuery(forRun, active && runKey && forRun ? { runKey } : "skip");
  const waitingSince =
    active && wait && typeof wait === "object" && typeof wait.waitingSince === "number"
      ? wait.waitingSince
      : undefined;
  return (
    <WaitingOnMarketplace
      waitingSince={waitingSince}
      marketplace={marketplace}
      className={className}
    />
  );
}
