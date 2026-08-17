import { createContext, useContext } from "react";

/**
 * NEO-84 — socket-level escalation hook for a wedged Convex client.
 *
 * Deliberately its own module rather than living in ConvexClientProvider:
 * consumers (the SetSelector backstop) need only the hook, and importing it
 * from the provider would drag `convex/react-clerk` + `@clerk/clerk-react`
 * into their module graph — and into their unit tests, which have no reason
 * to mock Clerk.
 *
 * The default is a no-op so a subtree rendered outside ConvexClientProvider
 * (tests, Storybook) degrades to the pre-NEO-84 behavior instead of throwing.
 */
export const ConvexReconnectContext = createContext<() => void>(() => {});

/**
 * Request a brand-new Convex websocket. Rate-limited and capped by the
 * provider — see `MAX_CLIENT_RECONNECTS` / `RECONNECT_COOLDOWN_MS`. Callers
 * should treat this as best-effort: it may legitimately do nothing.
 */
export function useConvexReconnect(): () => void {
  return useContext(ConvexReconnectContext);
}
