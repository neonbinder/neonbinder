/**
 * NEO-339 — the signed-in worker's marketplace credentials, the way the E2E
 * seed has always provisioned them.
 *
 * Seed: `testing.seedMyTestCredentials`, the action `/testing/seed-credentials`
 * calls. It stores the CALLER's own BSC/SportLots credentials from the
 * deployment's server env and needs nothing from the client: no secret, no
 * username, no password ever passes through this tool. It is testing-only by
 * the server's own gate: it throws unless the deployment has
 * `TESTING_RESET_SECRET` set, which production does not. The tool adds no
 * client-side bypass and needs none. It is idempotent server-side (a correct,
 * renewable stored session is left alone) and skips a paused site itself.
 *
 * Warm: `credentials.testSiteCredentials`, the action the profile's "Test
 * Credentials" button calls, once per seeded site. A real marketplace login
 * that refreshes the stored session; it writes no NB data.
 *
 * Nothing here logs or returns a credential: results carry the site key and
 * the server's own product-copy message only.
 */

import { api } from "../../../convex/_generated/api";
import type { NbClient } from "../client/convex-client";
import type { Credentials, SiteKey } from "../spec/schema";
import type { PausedContext } from "./sync-column";

export interface SeedSiteResult {
  site: string;
  outcome: "stored" | "skipped" | "failed";
  /** The server's user-facing reason, on a failure only. */
  reason?: string;
}

export interface WarmSiteResult {
  site: SiteKey;
  success: boolean;
  /** The server's user-facing message ("Successfully connected…"). */
  message: string;
}

export interface CredentialsOutcome {
  seeded: SeedSiteResult[];
  warmed: WarmSiteResult[];
  /** Sites the spec asked for that the declared pause skipped. */
  pausedSkipped: SiteKey[];
}

/** Seeding or warming failed. `results` says which site and why (product copy). */
export class CredentialsError extends Error {
  readonly results: ReadonlyArray<SeedSiteResult | WarmSiteResult>;
  constructor(message: string, results: ReadonlyArray<SeedSiteResult | WarmSiteResult>) {
    super(message);
    this.name = "CredentialsError";
    this.results = results;
  }
}

/** The server refuses seeding on this deployment (production, or testing not enabled). */
export class SeedingNotEnabled extends Error {
  constructor() {
    super(
      "This deployment refuses test credential seeding (it is enabled on preview/testing deployments only). " +
        "Remove `credentials` from the spec, or point the run at a preview.",
    );
    this.name = "SeedingNotEnabled";
  }
}

const NOT_ENABLED_RE = /not enabled on this deployment/i;

/**
 * `testing.seedMyTestCredentials` for `sites`. Throws `CredentialsError` when
 * a site neither stored nor skipped, and `SeedingNotEnabled` on a deployment
 * that refuses the call.
 */
export async function seedCredentials(
  client: NbClient,
  sites: readonly SiteKey[],
): Promise<SeedSiteResult[]> {
  if (sites.length === 0) return [];
  let res: Awaited<ReturnType<typeof callSeed>>;
  try {
    res = await callSeed(client, sites);
  } catch (err) {
    if (err instanceof Error && NOT_ENABLED_RE.test(err.message)) throw new SeedingNotEnabled();
    throw err;
  }
  const results: SeedSiteResult[] = res.seeded.map((s) => ({
    site: s.site,
    outcome: s.stored ? "stored" : s.skipped ? "skipped" : "failed",
    ...(!s.stored && !s.skipped ? { reason: s.reason ?? "no reason reported" } : {}),
  }));
  const failed = results.filter((r) => r.outcome === "failed");
  if (failed.length > 0) {
    throw new CredentialsError(
      `Seeding credentials failed: ${failed.map((f) => `${f.site}: ${f.reason}`).join("; ")}`,
      results,
    );
  }
  return results;
}

function callSeed(client: NbClient, sites: readonly SiteKey[]) {
  return client.action(api.testing.seedMyTestCredentials, { sites: [...sites] });
}

/** "Test Credentials" for each site, in order. Throws `CredentialsError` on the first refusal. */
export async function warmCredentials(
  client: NbClient,
  sites: readonly SiteKey[],
): Promise<WarmSiteResult[]> {
  const results: WarmSiteResult[] = [];
  for (const site of sites) {
    const r = await client.action(api.credentials.testSiteCredentials, { site });
    results.push({ site, success: r.success, message: r.message });
    if (!r.success) {
      throw new CredentialsError(`Warming the ${site} session failed: ${r.message}`, results);
    }
  }
  return results;
}

/**
 * The spec's `credentials` block: seed every named site the declared pause
 * does not skip, then (when `warm`) warm every site the seed actually stored.
 * A site the server skipped (paused there, or no dev credentials configured)
 * is not warmed.
 */
export async function ensureCredentials(
  client: NbClient,
  creds: Credentials,
  paused: PausedContext,
): Promise<CredentialsOutcome> {
  const unique = [...new Set(creds.seed)];
  const pausedSkipped = unique.filter((site) => paused.sites.has(site));
  const toSeed = unique.filter((site) => !paused.sites.has(site));
  const seeded = await seedCredentials(client, toSeed);
  // Every site sent is undeclared-paused, so a server skip means the
  // deployment has no dev credentials for it (or pauses it without saying
  // so). Either way the fetches that follow would fail on a symptom; stop on
  // the cause instead.
  const skipped = seeded.filter(
    (s) => s.outcome === "skipped" && (toSeed as readonly string[]).includes(s.site),
  );
  if (skipped.length > 0) {
    throw new CredentialsError(
      `The deployment skipped seeding ${skipped.map((s) => s.site).join(", ")}: no test credentials ` +
        `are configured for it there, or it is paused there but not in PAUSED_PLATFORMS.`,
      seeded,
    );
  }
  const stored = new Set(seeded.filter((s) => s.outcome === "stored").map((s) => s.site));
  const warmed = creds.warm
    ? await warmCredentials(
        client,
        toSeed.filter((site) => stored.has(site)),
      )
    : [];
  return { seeded, warmed, pausedSkipped };
}
