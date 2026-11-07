import { readEbayReturn, type EbayReturnState } from "@/app/profile/credentials/ebay/oauth-return";

/**
 * NEO-434 — takes eBay's return off the address before anything can record it.
 *
 * Sentry and PostHog read `location.href` in places no scrub hook reaches:
 * Replay's Meta frame and the `replay_event`'s `urls` and `request.url`. So on
 * `/profile/ebay` this drops what eBay sent from the URL as the app starts,
 * before any SDK is set up. `src/sentry.ts` imports it first, and `src/main.tsx`
 * imports `src/sentry.ts` first; a test holds both orders in source and
 * `scripts/check-entry-order.mjs` holds them in the built entry chunk, whose
 * static imports (posthog-js among them) evaluate before it.
 *
 * The return goes into this history entry's state under our own key, for the
 * landing page to hand on. Not module memory, because a reload before the
 * landing renders (Clerk can take a moment) must still finish the trip. Not
 * sessionStorage, because this entry's state goes when the entry is replaced:
 * by the landing's forward, or by the redirect to sign in when signed out. That
 * is no longer lived than the location state the panel gets next.
 *
 * Replacing the entry leaves no Back step with the code on it. Sentry and
 * PostHog are not set up yet, so neither records this as a navigation.
 */

/** Matched the way the router matches: any case, trailing slashes allowed. */
const LANDING_PATH = /^\/profile\/ebay\/*$/i;
/** What eBay adds to the address. Anything else on it stays. */
const EBAY_PARAMS = ["code", "state", "expires_in", "error", "error_description"];

export function takeEbayReturnOffAddress(win: Pick<Window, "location" | "history"> = window): void {
  const { pathname, search, hash } = win.location;
  if (!LANDING_PATH.test(pathname)) return;
  const params = new URLSearchParams(search);
  if (!EBAY_PARAMS.some((name) => params.has(name))) return;

  const ebayReturn = readEbayReturn(params);
  const handed: Partial<EbayReturnState> = ebayReturn ? { ebayReturn } : {};
  for (const name of EBAY_PARAMS) params.delete(name);
  const rest = params.toString();
  win.history.replaceState({ ...win.history.state, ...handed }, "", `${pathname}${rest ? `?${rest}` : ""}${hash}`);
}

takeEbayReturnOffAddress();
