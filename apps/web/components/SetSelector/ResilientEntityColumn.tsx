import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import posthog from "posthog-js";
import NeonButton from "../modules/NeonButton";
import { useConvexReconnect } from "../modules/convexReconnect";
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
 * That give-up state is presentational ONLY: the banner renders above a
 * still-mounted EntityColumn rather than replacing it, so a late-arriving value
 * clears it with no user action. Replacing the column unmounted the
 * subscription and made the state terminal — recoverable solely by a human
 * pressing Retry — which turned a transient stall into a permanent dead end.
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

/**
 * NEO-84 — snapshot of the websocket's health at the moment we give up.
 *
 * This is the evidence that decides whether a stall is ours or Convex's:
 * `ws=down` means the socket died and the client never noticed (our problem
 * to escalate); `ws=up` with a flat `conns` and an `oldest` matching the stall
 * duration means the socket is live and the backend simply never delivered
 * (an upstream problem, with a signature worth reporting).
 *
 * Read imperatively rather than through `useConvexConnectionState()` on
 * purpose. That hook subscribes every column to every connection-state
 * change, re-rendering the whole SetSelector on each one — exactly the
 * gratuitous churn NEO-85 removed, and it reflows the columns out from under
 * Maestro's coordinate taps. A one-shot read at give-up time costs nothing.
 */
type ConnectionSnapshot = {
  connected: boolean;
  connectionCount: number;
  connectionRetries: number;
  inflight: number;
  oldestInflightSecs: number | null;
  /** Compact one-liner, rendered on screen and sent to PostHog. */
  text: string;
};

function readConnection(
  convex: ReturnType<typeof useConvex> | null,
): ConnectionSnapshot | null {
  try {
    const s = convex?.connectionState();
    if (!s) return null;
    const oldestInflightSecs = s.timeOfOldestInflightRequest
      ? Math.round(
          (Date.now() - s.timeOfOldestInflightRequest.getTime()) / 1000,
        )
      : null;
    const inflight = s.inflightMutations + s.inflightActions;
    return {
      connected: s.isWebSocketConnected,
      connectionCount: s.connectionCount,
      connectionRetries: s.connectionRetries,
      inflight,
      oldestInflightSecs,
      text:
        `ws=${s.isWebSocketConnected ? "up" : "down"}` +
        ` · conns=${s.connectionCount}` +
        ` · retries=${s.connectionRetries}` +
        ` · inflight=${inflight}` +
        ` · oldest=${oldestInflightSecs === null ? "none" : `${oldestInflightSecs}s`}`,
    };
  } catch {
    // Diagnostics must never break the recovery path.
    return null;
  }
}

function emitBackstop(
  action: BackstopAction,
  level: string | undefined,
  attempt: number,
  connection?: ConnectionSnapshot | null,
): void {
  try {
    posthog.capture("selector_options_stall_backstop", {
      action,
      level,
      attempt,
      ws_connected: connection?.connected,
      ws_connection_count: connection?.connectionCount,
      ws_connection_retries: connection?.connectionRetries,
      ws_inflight: connection?.inflight,
      ws_oldest_inflight_secs: connection?.oldestInflightSecs,
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
  const [connection, setConnection] = useState<ConnectionSnapshot | null>(null);

  const convex = useConvex();
  const reconnectConvex = useConvexReconnect();

  // Only arm while the column is actually on screen and stuck on the read gate.
  const watching = isVisible && loading && !gaveUp;

  useEffect(() => {
    if (!watching) return;
    const timer = setTimeout(() => {
      if (attempt < MAX_RESUBSCRIBE_ATTEMPTS) {
        emitBackstop("resubscribe", level, attempt + 1);
        setAttempt(attempt + 1); // remount → fresh Convex subscription
      } else {
        // Every cheap recovery has now failed: the initial subscription and
        // MAX_RESUBSCRIBE_ATTEMPTS fresh query ids all stalled. That rules out
        // a per-subscription race and points at the socket itself (NEO-84), so
        // escalate one level — ask for a whole new Convex client, and with it a
        // new websocket. Convex will not do this on its own: its reconnect path
        // is gated on `socket.state === "disconnected"`, which a half-open
        // socket never reaches.
        //
        // The banner still renders at the same moment it always did, so the
        // give-up timing is unchanged (~18s). If the new socket delivers, the
        // existing self-heal below clears the banner with no user action; if it
        // doesn't, Retry is still the escape hatch. Snapshot the connection
        // BEFORE reconnecting — afterwards it describes the new socket, not the
        // wedged one we are trying to explain.
        const snapshot = readConnection(convex);
        emitBackstop("gaveup", level, attempt, snapshot);
        setConnection(snapshot);
        setGaveUp(true);
        reconnectConvex();
      }
    }, SELECTOR_OPTIONS_STALL_BACKSTOP_MS);
    // Re-armed per attempt: after a remount `attempt` changes, EntityColumn
    // re-reports `loading`, and this effect starts a fresh timer for the new
    // subscription. Recovery flips `loading`/`watching` false → cleanup clears.
    return () => clearTimeout(timer);
  }, [watching, attempt, level, convex, reconnectConvex]);

  // Self-heal: the give-up state is presentational only, so a value that lands
  // late (see the mounted-not-replaced note below) clears it with no user
  // action. `loading` flips false the moment EntityColumn's read resolves.
  useEffect(() => {
    if (gaveUp && !loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- self-heal: the give-up state is presentational and clears when a late value lands
      setGaveUp(false);
      // The snapshot described the socket that was wedged; once a value lands
      // it is stale, and leaving it on screen would misdescribe a working
      // connection.
      setConnection(null);
    }
  }, [gaveUp, loading]);

  const handleRetry = () => {
    emitBackstop("retry", level, attempt + 1, connection);
    setGaveUp(false);
    setConnection(null);
    setLoading(false); // re-reported by the fresh EntityColumn mount
    setAttempt((a) => a + 1); // new key → fresh subscription
    // A manual Retry lands only after the automatic escalation already failed,
    // so remounting alone is unlikely to be enough — ask for a new socket too.
    // The provider's cooldown and cap decide whether this actually does
    // anything, which is why it is safe to call unconditionally here.
    reconnectConvex();
  };

  // "Sync Sports" → "Sports", "Sync Variant Types" → "Variant Types", etc.
  // Mirrors EntityColumn's own label derivation.
  const label = addButtonText.replace(/^Sync /, "");

  // `key={attempt}` is load-bearing — see the header comment. It fully
  // unmounts + remounts EntityColumn (dropping the last listener on the shared
  // getSelectorOptions token) so the retry issues a brand-new subscription.
  const column = (
    <EntityColumn key={attempt} {...props} onLoadingChange={setLoading} />
  );

  // The give-up banner renders ABOVE a still-mounted EntityColumn — it does not
  // replace it. Returning the banner *instead of* the column used to unmount the
  // subscription, which made the state terminal: `watching` is false once
  // `gaveUp`, so no timer re-arms, and only a human pressing Retry could ever
  // clear it. A late-delivered value or a socket reconnect could not, so a
  // transient read stall became a permanent dead end (it stranded the
  // set-selector E2E flow that drills this column: the "+ Custom" button is
  // gated on the read and never reappeared).
  //
  // Keeping the column mounted preserves the existing subscription so a late
  // value still lands and self-heals. Retry is unchanged and remains the escape
  // hatch for the case mounting can't fix — a token wedged server-side, where
  // only a brand-new query id will re-deliver.
  //
  // STRUCTURE IS LOAD-BEARING. The wrapper is rendered unconditionally and the
  // banner occupies a fixed leading slot (`… ? <banner/> : null`). Both details
  // exist to keep EntityColumn's position in the element tree identical across
  // the gaveUp toggle:
  //   • Returning EntityColumn bare in one branch and wrapped in the other would
  //     change the ROOT element type (component → div), and React unmounts the
  //     whole subtree when the type changes.
  //   • Omitting the banner entirely (rather than rendering null) would shift
  //     EntityColumn from child index 0 to 1, and unkeyed siblings reconcile by
  //     index — also a remount.
  // Either mistake silently re-breaks the fix by dropping the subscription at
  // the exact moment we need to hold it. `ResilientEntityColumn.test.tsx` pins
  // this via the mount count.
  //
  // No heading in the banner: EntityColumn renders its own. Duplicating it would
  // put the level name on screen twice and make the E2E text selectors
  // ambiguous.
  return (
    <div className="min-w-[260px] max-w-[340px] flex-shrink-0 flex flex-col gap-4">
      {isVisible && gaveUp ? (
        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow">
          <div
            role="alert"
            className="p-3 mb-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-md text-red-800 dark:text-red-200 text-sm"
          >
            Couldn&apos;t load {label.toLowerCase()}. The connection may have
            stalled.
          </div>
          {/*
            NEO-84 — the socket snapshot is rendered, not just captured,
            because PostHog is switched off under E2E (PostHogProvider.tsx
            returns early on VITE_CLERK_TESTING_ENABLED, per NEO-13) and
            Maestro records no console output or failure hierarchy. On screen
            is the only channel that survives into a CI failure screenshot —
            the same conclusion NEO-85's tap forensics reached.

            It is deliberately shown to real users too: this banner only
            appears on an already-broken admin screen, and "send me the
            screenshot" is then a complete bug report.
          */}
          {connection ? (
            <p
              className="mb-3 font-mono text-[11px] leading-tight text-red-700 dark:text-red-300 break-words"
              data-testid="stall-connection-state"
            >
              {connection.text}
            </p>
          ) : null}
          <NeonButton
            onClick={handleRetry}
            aria-label={`Retry loading ${label}`}
          >
            Retry
          </NeonButton>
        </div>
      ) : null}
      {column}
    </div>
  );
}
