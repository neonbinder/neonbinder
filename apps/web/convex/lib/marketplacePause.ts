/**
 * NEO-287 — the pure half of the marketplace pause switch.
 *
 * ## Why this is a separate file
 *
 * `convex/marketplacePause.ts` is the switch: it reads the environment
 * variable and exposes the query the SPA subscribes to. Reading the
 * environment and declaring a `query` both make a module Convex-only —
 * `_generated/server` pulls `./auth` and `@clerk/backend` into whatever
 * imports it, and Vite does not polyfill `process`, so a component that
 * imported the switch itself would break the browser bundle.
 *
 * The SPA still needs the vocabulary: which site keys exist, how a site key
 * maps to the `PlatformSide` the resolvability layer speaks, and (for tests)
 * how a raw value is parsed. Those parts have no I/O and live here, next to
 * the other helpers components already import from `convex/lib/`.
 *
 * **Pure by contract.** No `_generated/server` import, no `process.env`, no
 * Convex types. Keep it that way; the env read belongs in the parent module.
 *
 * ## Vocabulary
 *
 * The switch speaks in credential SITE KEYS (`sportlots`, `buysportscards`),
 * not slot sides (`sportlots`, `bsc`), because that is the vocabulary the
 * Profile tabs, `credentials.ts` and PostHog already use — the operator is
 * pausing "the thing you sign in to". `SITE_TO_SIDE` is the one bridge to the
 * side vocabulary, for callers that thread the pause into `resolvableSides`.
 */

import type { PlatformSide } from "../platformSlots";

/** The Convex environment variable the switch reads. Set it, don't deploy. */
export const PAUSED_PLATFORMS_ENV = "NEONBINDER_PAUSED_PLATFORMS";

/**
 * The credential site keys the switch recognises. Keep in step with
 * `SUPPORTED_SITES` in `convex/credentials.ts` and the tab list in
 * `app/profile/credentials/page.tsx` — the three are the same vocabulary and
 * `credentials.ts` cannot export its copy across the `"use node"` boundary.
 */
export const KNOWN_SITES = ["buysportscards", "sportlots"] as const;

export type KnownSite = (typeof KNOWN_SITES)[number];

/** Site key → the slot side `marketplaceResolvability` judges. */
export const SITE_TO_SIDE: Readonly<Record<KnownSite, PlatformSide>> = {
  buysportscards: "bsc",
  sportlots: "sportlots",
};

export function isKnownSite(site: string): site is KnownSite {
  return (KNOWN_SITES as readonly string[]).includes(site);
}

/**
 * Parse the raw variable into the set of paused site keys.
 *
 * Comma-separated, whitespace-trimmed, case-insensitive; empty entries are
 * ignored. An unknown key is DROPPED with one `console.warn` naming every
 * unknown key in the value — never a throw. This is read on the hot path of
 * every login and sync, so a typo in an operator-set variable must degrade to
 * "nothing paused" plus a log line, not take the deployment down.
 */
export function parsePausedPlatforms(
  raw: string | undefined,
): ReadonlySet<KnownSite> {
  const paused = new Set<KnownSite>();
  if (!raw) return paused;

  const unknown: string[] = [];
  for (const entry of raw.split(",")) {
    const key = entry.trim().toLowerCase();
    if (key === "") continue;
    if (isKnownSite(key)) {
      paused.add(key);
    } else {
      unknown.push(key);
    }
  }

  if (unknown.length > 0) {
    console.warn(
      `[marketplacePause] ${PAUSED_PLATFORMS_ENV} names unknown platform key(s) ` +
        `${unknown.map((k) => JSON.stringify(k)).join(", ")}; ignored. ` +
        `Known keys: ${KNOWN_SITES.join(", ")}.`,
    );
  }

  return paused;
}

/** The slot sides behind a set of paused site keys. */
export function sidesOfSites(
  sites: ReadonlySet<KnownSite>,
): ReadonlySet<PlatformSide> {
  const sides = new Set<PlatformSide>();
  for (const site of sites) sides.add(SITE_TO_SIDE[site]);
  return sides;
}
