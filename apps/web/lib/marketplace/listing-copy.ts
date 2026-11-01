/**
 * NEO-370 — the listing words said on more than one screen: the Profile's
 * sign-in form and BuySportsCards panel, and the inventory's Sync button and
 * Sync status tab. Rev 5: a saved, unpaused sign-in IS syncing (listing and
 * sales); there is no Start. One place, so a sentence reads the same
 * everywhere. NB voice: short, plain, a little rad; never an internal word
 * ("outbox", "lease", "drain", "SKU").
 */

/** The platform's name as a collector reads it. */
export const BSC_NAME = "BuySportsCards";

/** Where a collector saves (or renews) their marketplace sign-in, which starts syncing. */
export const CREDENTIALS_PATH = "/profile/credentials";

/**
 * What connecting a BSC sign-in does, said beside Connect on the sign-in
 * form before it is pressed: saving the sign-in starts syncing, and NB's box
 * count wins over listings they already have, including 0. "Connect" is the
 * form's Save, so the sentence names it the way the button does.
 */
export const CONSENT_HEADING = "Heads up: connecting starts listing";
export const CONSENT_LINE =
  `Connecting lists every card in your boxes on ${BSC_NAME} at your box counts, and brings your sales back here. Cards you already list there, in any set you have in your boxes, go to your counts too. A card that isn't in a box, or sits in an in-person box, goes to 0.`;

/** The listing consent for a sign-in form, by site key; a site that doesn't list says nothing. */
export const LISTING_CONSENT: Partial<Record<string, string>> = { buysportscards: CONSENT_LINE };

/** The seller account lists from another NB account: said wherever listing's state is. */
export const SELLER_CONFLICT_LINE = `That ${BSC_NAME} seller account already lists from another NeonBinder account, so nothing goes up or comes in from this one.`;

/** BSC is paused for everyone (NB's switch): changes wait, nothing is lost. */
export const PAUSED_LINE = `${BSC_NAME} is on a break. Your changes wait here and go up when it's back.`;

/** The saved sign-in died: nothing goes up until they sign in again. */
export const REAUTH_LINE = `Your ${BSC_NAME} sign-in ran out, so nothing goes up until you sign in again.`;

/** Saved, unpaused and none of the above, but not syncing (a testing account). */
export const NOT_SYNCING_LINE = "Not syncing.";

/** "Nov 1, 2026". */
export function listingDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
