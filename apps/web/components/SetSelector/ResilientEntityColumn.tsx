import { useEffect, useState } from "react";
import posthog from "posthog-js";
import NeonButton from "../modules/NeonButton";
import EntityColumn, { type EntityColumnProps } from "./EntityColumn";

/**
 * NEO-83 — client-side resilience backstop for a stalled selector-option read.
 *
 * The SetSelector column heading is hard-gated on its `getSelectorOptions`
 * read (`EntitySelector.tsx` renders "Loading <level>…" while `items ===
 * undefined`). That read is normally sub-second, but a Convex reactive
 * subscription's *initial value* can occasionally stall indefinitely on an
 * otherwise-healthy socket (NEO-84: measured 16.8s and never resolving, while
 * another client served the identical query in 0.3s). With no timeout/retry on
 * that path the column hangs on "Loading…" until the user reloads.
 *
 * This wrapper watches the pure-read loading state (reported up from
 * EntityColumn as `items === undefined`) and, if it stays loading past
 * {@link SELECTOR_OPTIONS_STALL_BACKSTOP_MS}, auto re-subscribes by remounting
 * the whole EntityColumn (bumping its `key`). After
 * {@link MAX_RESUBSCRIBE_ATTEMPTS} failed auto-attempts it shows a recoverable
 * error + Retry instead of an infinite spinner. This self-heals the product
 * AND stabilizes the set-selector E2E flake class (a stalled subscription
 * auto-recovers → the column's heading renders → the flow assertion passes).
 *
 * Why remount the WHOLE EntityColumn (not just its EntitySelector child):
 * EntityColumn and its EntitySelector child both `useQuery(getSelectorOptions,
 * {level, parentId})` with identical args, which the Convex client dedupes into
 * ONE ref-counted subscription (`numSubscribers`). Removing just one listener
 * leaves `numSubscribers >= 1`, so the query token — and its stalled query id —
 * stays alive; a fresh child would re-attach to the same stalled value. Only
 * when the LAST subscriber unmounts does the client delete the token and, on
 * remount, re-add it under a brand-new query id (`nextQueryId++`), forcing the
 * server to re-run and re-deliver. Keying the entire column drops both
 * listeners, so this is a genuinely new subscription, not just a re-render.
 * (Verified against convex@1.42 browser/sync/local_state.js.)
 *
 * Scope: only the pure-read `items === undefined` state is targeted. The
 * separate marketplace "Syncing… / Fetching from marketplaces…" state has
 * `items === []` (defined) and its own ~35s child deadlines — the backstop is
 * disarmed during it and never interferes.
 */

/**
 * How long the column may sit on the pure-read "Loading…" gate before we
 * re-subscribe. The read is normally sub-second (~0.3s measured); the observed
 * stall was 16.8s. 9s sits ~30x above the normal latency (so a merely-slow but
 * progressing read never trips it) yet well under the stall (so recovery kicks
 * in instead of the user waiting indefinitely). Deliberately far below the
 * legacy `SELECTOR_SYNC_FE_TIMEOUT_MS` (38s) — that budget covers a real
 * marketplace fetch, whereas this guards a read that should be instant.
 */
export const SELECTOR_OPTIONS_STALL_BACKSTOP_MS = 9_000;

/**
 * Number of automatic re-subscribe (remount) attempts before falling back to a
 * manual Retry. A one-off stall almost always clears on the first fresh
 * subscription; 2 gives headroom without an unbounded remount loop. Manual
 * Retry then grants one further attempt per press.
 */
export const MAX_RESUBSCRIBE_ATTEMPTS = 2;

type BackstopAction = "resubscribe" | "gaveup" | "retry";

function emitBackstop(
  action: BackstopAction,
  level: string | undefined,
  attempt: number,
): void {
  try {
    posthog.capture("selector_options_stall_backstop", {
      action,
      level,
      attempt,
    });
  } catch {
    // Diagnostics must never break the recovery path.
  }
}

// The wrapper owns `onLoadingChange` internally; callers use the same public
// API as EntityColumn.
type ResilientEntityColumnProps = Omit<EntityColumnProps, "onLoadingChange">;

export default function ResilientEntityColumn(
  props: ResilientEntityColumnProps,
) {
  const { isVisible, level, addButtonText } = props;

  // `attempt` doubles as the remount key: bumping it re-subscribes the column.
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);

  // Only arm while the column is actually on screen and stuck on the read gate.
  const watching = isVisible && loading && !gaveUp;

  useEffect(() => {
    if (!watching) return;
    const timer = setTimeout(() => {
      if (attempt < MAX_RESUBSCRIBE_ATTEMPTS) {
        emitBackstop("resubscribe", level, attempt + 1);
        setAttempt(attempt + 1); // remount → fresh Convex subscription
      } else {
        emitBackstop("gaveup", level, attempt);
        setGaveUp(true);
      }
    }, SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
    // Re-armed per attempt: after a remount `attempt` changes, EntityColumn
    // re-reports `loading`, and this effect starts a fresh timer for the new
    // subscription. Recovery flips `loading`/`watching` false → cleanup clears.
    return () => clearTimeout(timer);
  }, [watching, attempt, level]);

  const handleRetry = () => {
    emitBackstop("retry", level, attempt + 1);
    setGaveUp(false);
    setLoading(false); // re-reported by the fresh EntityColumn mount
    setAttempt((a) => a + 1); // new key → fresh subscription
  };

  if (isVisible && gaveUp) {
    // "Sync Sports" → "Sports", "Sync Variant Types" → "Variant Types", etc.
    // Mirrors EntityColumn's own label derivation.
    const label = addButtonText.replace(/^Sync /, "");
    return (
      <div className="min-w-[260px] max-w-[340px] flex-shrink-0 flex flex-col gap-4">
        <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-3">{label}</h2>
          <div
            role="alert"
            className="p-3 mb-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm"
          >
            Couldn&apos;t load {label.toLowerCase()}. The connection may have
            stalled.
          </div>
          <NeonButton
            onClick={handleRetry}
            aria-label={`Retry loading ${label}`}
          >
            Retry
          </NeonButton>
        </div>
      </div>
    );
  }

  // `key={attempt}` is load-bearing — see the header comment. It fully
  // unmounts + remounts EntityColumn (dropping the last listener on the shared
  // getSelectorOptions token) so the retry issues a brand-new subscription.
  return <EntityColumn key={attempt} {...props} onLoadingChange={setLoading} />;
}
