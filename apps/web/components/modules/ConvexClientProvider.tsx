import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { useAuth } from "@clerk/clerk-react";
import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConvexReconnectContext } from "./convexReconnect";

/**
 * NEO-84 — the client must be replaceable, because a wedged websocket cannot
 * be recovered any other way.
 *
 * Observed in CI (run 31839119469): a client stopped receiving transitions on
 * a socket it still believed was healthy. Everything already delivered kept
 * rendering from cache; nothing new ever arrived. Re-subscribing does not fix
 * this — the NEO-83 backstop issued two fresh query ids, 9s apart, and all
 * three subscriptions stalled.
 *
 * Convex cannot self-heal from it either. Its only auto-reconnect trigger is
 * the window `online` event → `tryReconnectImmediately()`, which returns
 * early unless `socket.state === "disconnected"`
 * (convex@1.43.0 browser/sync/web_socket_manager.js:543). A half-open socket
 * that never emits `close` is invisible to that check.
 *
 * So the only escalation short of `location.reload()` is a new client, which
 * opens a new websocket. `generation` is that lever: bumping it rebuilds the
 * client, and every `useQuery` in the tree re-subscribes against it.
 *
 * This is a heavy hammer — every subscription app-wide briefly returns
 * `undefined` — so it is rate-limited and capped below, and callers only
 * reach for it after the cheaper per-column re-subscribes have failed.
 */

/**
 * Hard cap on client swaps per page load. A wedged socket is a one-off; if
 * three new sockets in a row cannot deliver, the problem is not the socket
 * (backend down, auth broken, no network) and swapping again just churns
 * every subscription in the app to no purpose. Manual Retry is bounded by
 * this too — past the cap the honest answer is "reload the page".
 */
export const MAX_CLIENT_RECONNECTS = 3;

/**
 * Minimum spacing between swaps. Several columns can hit their give-up
 * threshold at nearly the same moment (they share one stalled socket), and
 * without this the first swap would be torn down by the second before its
 * new socket ever had a chance to deliver.
 */
export const RECONNECT_COOLDOWN_MS = 30_000;

export default function ConvexClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [generation, setGeneration] = useState(0);

  const convex = useMemo(() => {
    return new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `generation` IS the dependency: bumping it to build a new client (and therefore a new websocket) is the entire mechanism.
  }, [generation]);

  // Close the superseded client, but only after the new one is committed and
  // the tree is reading from it. Closing during render — or inside the
  // callback that bumps `generation` — would tear down the socket the tree is
  // still subscribed to and surface as errors mid-swap.
  const currentClient = useRef<ConvexReactClient | null>(null);
  useEffect(() => {
    const superseded = currentClient.current;
    currentClient.current = convex;
    if (superseded && superseded !== convex) {
      void superseded.close();
    }
  }, [convex]);

  const lastReconnectAt = useRef(0);
  const reconnectCount = useRef(0);

  const reconnect = useCallback(() => {
    if (reconnectCount.current >= MAX_CLIENT_RECONNECTS) return;
    const now = Date.now();
    if (now - lastReconnectAt.current < RECONNECT_COOLDOWN_MS) return;
    lastReconnectAt.current = now;
    reconnectCount.current += 1;
    setGeneration((g) => g + 1);
  }, []);

  return (
    <ConvexReconnectContext.Provider value={reconnect}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ConvexReconnectContext.Provider>
  );
}
