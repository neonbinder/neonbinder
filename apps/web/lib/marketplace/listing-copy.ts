/**
 * NEO-370 — the listing words said on more than one screen: the Profile's
 * sign-in form and BuySportsCards panel, the eBay panel (NEO-415), and the
 * inventory's Sync button, Sync status and Sales tabs. Rev 5: a saved,
 * unpaused connection IS syncing (listing and sales); there is no Start. One
 * place, so a sentence reads the same everywhere. NB voice: short, plain, a
 * little rad; never an internal word ("outbox", "lease", "drain", "SKU").
 *
 * Names here are display only. Nothing keys behaviour on them (invariant #4):
 * every lookup goes by NB's own platform key ("bsc", "ebay").
 */

/** The platforms NB lists box copies on, by NB's own key. */
export type ListingPlatformKey = "bsc" | "ebay";

/** The platform's name as a collector reads it. */
export const BSC_NAME = "BuySportsCards";
export const EBAY_NAME = "eBay";

export const PLATFORM_NAME: Record<ListingPlatformKey, string> = { bsc: BSC_NAME, ebay: EBAY_NAME };

/** Where a collector saves (or renews) their marketplace sign-in, which starts syncing. */
export const CREDENTIALS_PATH = "/profile/credentials";

/**
 * The query parameter that picks a platform on Profile → Credentials, by the
 * page's own site key ("buysportscards", "sportlots", "ebay"). In the URL so
 * a link, a refresh and Back all land on the same platform.
 */
export const PLATFORM_PARAM = "platform";

/** Profile → Credentials with one platform picked. */
export function credentialsPathFor(siteKey: string): string {
  return `${CREDENTIALS_PATH}?${PLATFORM_PARAM}=${encodeURIComponent(siteKey)}`;
}

/**
 * NEO-415 — eBay's connection and listing setup, under Profile → Credentials.
 * (`/profile/ebay` is only where eBay's consent screen sends the collector
 * back; it forwards here.)
 */
export const EBAY_PATH = credentialsPathFor("ebay");

/** Where each platform is connected, renewed and disconnected. */
export const PLATFORM_PROFILE_PATH: Record<ListingPlatformKey, string> = {
  bsc: credentialsPathFor("buysportscards"),
  ebay: EBAY_PATH,
};

/**
 * What connecting a BSC sign-in does, said beside Connect on the sign-in
 * form before it is pressed: saving the sign-in starts syncing, and NB's box
 * count wins over listings they already have, including 0. "Connect" is the
 * form's Save, so the sentence names it the way the button does.
 */
export const CONSENT_HEADING = "Heads up: connecting starts listing";
export const CONSENT_LINE =
  `Connecting lists every card in your boxes on ${BSC_NAME} at your box counts, and brings your sales back here. Cards you already list there, in any set you have in your boxes, go to your counts too. A card that isn't in a box, or sits in an in-person box, goes to 0.`;

/**
 * NEO-415 — the same promise for eBay, said beside Connect on the eBay panel.
 * eBay listings are NB's own (one per card and condition), so nothing the
 * seller already lists there is touched; only what NB put up follows the
 * box counts.
 */
export const EBAY_CONSENT_LINE =
  `Connecting lists every raw card in your boxes on ${EBAY_NAME} at your box counts, once your setup is done, and brings your sales back here. A card that leaves your boxes, or sits in an in-person box, comes down. Listings you made on ${EBAY_NAME} yourself stay untouched, and if you disconnect, we take down the ones we put up.`;

/** The listing consent for a sign-in form, by site key; a site that doesn't list says nothing. */
export const LISTING_CONSENT: Partial<Record<string, string>> = { buysportscards: CONSENT_LINE };

/** The seller account lists from another NB account: said wherever listing's state is. */
export function sellerConflictLine(name: string, username?: string | null): string {
  const who = username ? ` (${username})` : "";
  return `That ${name} seller account${who} already lists from another NeonBinder account, so nothing goes up or comes in from this one.`;
}
export const SELLER_CONFLICT_LINE = sellerConflictLine(BSC_NAME);

/** The platform is paused for everyone (NB's switch): changes wait, nothing is lost. */
export function pausedLine(name: string): string {
  return `${name} is on a break. Your changes wait here and go up when it's back.`;
}
export const PAUSED_LINE = pausedLine(BSC_NAME);

/** The saved sign-in (or eBay's consent) died: nothing goes up until they renew it. */
export function reauthLine(platform: ListingPlatformKey): string {
  return platform === "ebay"
    ? `Your ${EBAY_NAME} connection ran out, so nothing goes up until you connect again.`
    : `Your ${BSC_NAME} sign-in ran out, so nothing goes up until you sign in again.`;
}
export const REAUTH_LINE = reauthLine("bsc");

/** Saved, unpaused and none of the above, but not syncing (a testing account). */
export const NOT_SYNCING_LINE = "Not syncing.";

/** NEO-415 — eBay is connected but its shipping, payment, returns or ships-from isn't picked yet. */
export const EBAY_SETUP_LINE = `Your ${EBAY_NAME} setup isn't finished, so nothing goes up there yet.`;

/** "Nov 1, 2026". */
export function listingDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
