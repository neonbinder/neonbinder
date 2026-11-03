/**
 * NEO-415 — eBay's trip home, handed from the landing route to the panel.
 *
 * eBay (through NEO-422's static return pages, which cannot change without a
 * production deploy) sends the collector to `/profile/ebay?code=…&state=…`,
 * or `?error=…` when they said no. eBay lives under Profile → Credentials, so
 * that address is only a landing: it reads what eBay sent, then swaps itself
 * (`replace`, no Back step) for the Credentials page with eBay picked,
 * carrying the return in the router's location state rather than the URL. The
 * panel spends the code once and clears that state (`replace` again), so the
 * code and nonce never sit in an address bar, a link or a history entry
 * anyone can come back to.
 */

/** What eBay sent back: a consent to spend, or a no. */
export type EbayReturn = { kind: "code"; code: string; state: string } | { kind: "declined" };

/** Read eBay's return from the landing's query string. Nothing eBay sent: null. */
export function readEbayReturn(params: URLSearchParams): EbayReturn | null {
  const code = params.get("code");
  const state = params.get("state");
  if (code && state) return { kind: "code", code, state };
  if (params.get("error")) return { kind: "declined" };
  return null;
}

/** The location-state shape the landing hands over. */
export type EbayReturnState = { ebayReturn: EbayReturn };

/** The return riding in a location's state, if one does; anything else is null. */
export function ebayReturnFrom(locationState: unknown): EbayReturn | null {
  const handed = (locationState as Partial<EbayReturnState> | null)?.ebayReturn;
  if (!handed || typeof handed !== "object") return null;
  if (handed.kind === "declined") return handed;
  if (handed.kind === "code" && typeof handed.code === "string" && typeof handed.state === "string") return handed;
  return null;
}
