/**
 * NEO-287 — the operator switch that pauses all contact with a marketplace.
 *
 * ## What it is for
 *
 * When a marketplace is hostile or broken (today: SportLots, whose login
 * started answering with a Turnstile challenge), the operator flips ONE
 * Convex environment variable and NeonBinder stops asking that marketplace
 * for anything: no fresh sign-ins, no stored-session validation, no
 * selector or checklist fetches on that side. Every link and every stored
 * session stays exactly as it is; the other marketplaces keep working; syncs
 * run on the remaining sides and say so.
 *
 * Skipping the side is the only shape that cannot lose a link. A challenge
 * page is a 200 that parses to zero options, and an EMPTY SUCCESSFUL side
 * enters `coveredSides`, which is what the store's unlink pass keys on
 * (invariant 5: linkage is maintained, not optional). A paused side is not
 * fetched, so it is never "covered", so nothing beneath it is ever detached.
 *
 * ## How it is flipped
 *
 *     npx convex env set NEONBINDER_PAUSED_PLATFORMS sportlots
 *     npx convex env remove NEONBINDER_PAUSED_PLATFORMS
 *
 * No deploy. Convex functions read the variable on each call, so the pause
 * takes effect on the next login or sync and lifts the same way. The value is
 * a comma-separated list of credential site keys (`sportlots`,
 * `buysportscards`); see `lib/marketplacePause.ts` for the parse rules and
 * why the vocabulary is site keys rather than slot sides.
 *
 * ## This file is the ONLY place the variable is read
 *
 * Every consumer — `credentials.ts` before a login, the SportLots adapter
 * before a fetch, the sync entry points that thread `pausedSides()` into
 * `resolvableSides` — imports one of the readers below. Nothing else touches
 * `process.env[PAUSED_PLATFORMS_ENV]`: `marketplaceResolvability.ts` and
 * `selectorSyncStore.ts` are imported by React components, and Vite does not
 * polyfill `process`, so an env read there would crash the browser bundle.
 * The pause reaches those pure modules as an argument, never as a read.
 *
 * ## What the SPA sees
 *
 * `getPausedPlatforms` is the one client-facing surface: the sorted list of
 * paused site keys, for the Profile card, the Set Builder strip and the
 * marketplace pickers. Signed-in, not admin — the pause is shown to every user
 * who could otherwise have pressed "Sign in" or "Test Credentials", and it
 * reveals nothing but an operator decision that the UI is about to announce
 * anyway. Components never import this module; they subscribe to the query
 * and take the vocabulary from `lib/marketplacePause.ts`.
 */

import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireSignedIn } from "./auth";
import type { PlatformSide } from "./platformSlots";
import {
  type KnownSite,
  PAUSED_PLATFORMS_ENV,
  parsePausedPlatforms,
  sidesOfSites,
} from "./lib/marketplacePause";

export {
  KNOWN_SITES,
  PAUSED_PLATFORMS_ENV,
  SITE_TO_SIDE,
  isKnownSite,
  parsePausedPlatforms,
  sidesOfSites,
} from "./lib/marketplacePause";
export type { KnownSite } from "./lib/marketplacePause";

/** The paused site keys, read from the deployment's environment right now. */
export function pausedPlatforms(): ReadonlySet<KnownSite> {
  return parsePausedPlatforms(process.env[PAUSED_PLATFORMS_ENV]);
}

/**
 * Is this credential site paused? Takes the loose `string` the credential
 * functions carry (`args.site`), so an unknown site is simply "not paused" —
 * the caller's own `isSupportedSite` check is what refuses it.
 */
export function isPlatformPaused(site: string): boolean {
  return (pausedPlatforms() as ReadonlySet<string>).has(site);
}

/**
 * The paused SLOT SIDES, for callers that thread the pause into
 * `resolvableSides(chain, { paused })` and the sync result's `pausedSides`.
 */
export function pausedSides(): ReadonlySet<PlatformSide> {
  return sidesOfSites(pausedPlatforms());
}

/**
 * The paused site keys, sorted, for the SPA. Signed-in gate, not admin: see
 * the file comment. Returns `string[]` rather than a literal union so adding
 * a site key never changes the wire shape.
 */
export const getPausedPlatforms = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx): Promise<string[]> => {
    await requireSignedIn(ctx);
    return [...pausedPlatforms()].sort();
  },
});
