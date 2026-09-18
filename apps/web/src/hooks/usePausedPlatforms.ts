import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * NEO-287 — which marketplaces the operator has paused, as credential SITE
 * keys (`"sportlots"`, `"buysportscards"`).
 *
 * One reactive subscription to `marketplacePause.getPausedPlatforms`; the
 * switch is a Convex env var read per call, so a flip reaches every open tab
 * on its next query refresh with no deploy and no reload.
 *
 * The loading state (`undefined`) reads as NOT paused on purpose: a paused
 * card or strip that flashed in and out on every mount would be worse than
 * one that arrives a frame late, and nothing here is a security boundary —
 * every login and fetch is refused server-side regardless of what the UI
 * shows.
 *
 * Returns a Set so callers write `paused.has(site)`; memoised on the query
 * result so consumers can key effects and dismiss-state on it safely.
 */
export function usePausedPlatforms(): ReadonlySet<string> {
  const sites = useQuery(api.marketplacePause.getPausedPlatforms);
  return useMemo(() => new Set<string>(sites ?? []), [sites]);
}
