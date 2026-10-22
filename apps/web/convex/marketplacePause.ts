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
 *
 * ## What the browser service sees (NEO-355)
 *
 * `servicePausedPlatforms` serves the same sorted list over HTTP to the
 * browser service's login canary, so one `env set` pauses the canary too
 * instead of a second, Terraform-side switch drifting out of step with this
 * one. It is routed in `http.ts` and authenticated by the caller's Google
 * identity (`lib/googleIdTokenVerify.ts`), never by a shared secret.
 */

import { httpAction, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSignedIn } from "./auth";
import { verifyGoogleIdToken } from "./lib/googleIdTokenVerify";
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

// ─── the browser service's read (NEO-355) ────────────────────────────────────

/**
 * Comma-separated service-account emails allowed to read the pause over HTTP:
 * the browser service's runtime identity. Unset means nobody may (fail closed),
 * which is the right answer for a dev or preview deployment that has no
 * canary calling it.
 */
export const BROWSER_RUNTIME_SA_ENV = "NEONBINDER_BROWSER_RUNTIME_SA";

/** One caching story for every answer: the pause can flip at any moment. */
function pauseResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * Error bodies are one fixed word per status, never the verification reason:
 * telling a caller WHICH check refused it ("not allowlisted" vs "bad token")
 * would confirm a stolen token is genuine. The reason goes to the log only.
 */
const ERROR_BODY: Readonly<Record<401 | 403 | 503, { error: string }>> = {
  401: { error: "unauthorized" },
  403: { error: "forbidden" },
  503: { error: "unavailable" },
};

/**
 * `GET /internal/marketplace-pause` → `200 {"paused": [...sorted site keys]}`.
 *
 * The caller is the browser service, deciding whether a scheduled canary
 * sign-in should run. It presents a Google id token minted for its runtime
 * service account with this deployment's site URL as the audience. Read-only
 * and side-effect free, so a retry is always safe; the browser treats any
 * non-200 as "not paused" and signs in for real.
 */
export const servicePausedPlatforms = httpAction(async (_ctx, request) => {
  const started = Date.now();
  const verdict = await verifyGoogleIdToken(
    request.headers.get("authorization"),
    {
      audience: process.env.CONVEX_SITE_URL,
      allowedEmails: process.env[BROWSER_RUNTIME_SA_ENV],
    },
  );
  if (!verdict.ok) {
    // No token, no claim values: the line exists to make a refusal and its
    // cause visible to the operator, not to help anyone reproduce it.
    console.warn(
      JSON.stringify({
        msg: "marketplace_pause_lookup_refused",
        status: verdict.status,
        reason: verdict.reason,
        duration_ms: Date.now() - started,
      }),
    );
    return pauseResponse(verdict.status, ERROR_BODY[verdict.status]);
  }
  const paused = [...pausedPlatforms()].sort();
  console.log(
    JSON.stringify({
      msg: "marketplace_pause_lookup_served",
      paused,
      duration_ms: Date.now() - started,
    }),
  );
  return pauseResponse(200, { paused });
});
