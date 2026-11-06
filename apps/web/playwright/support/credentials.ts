/**
 * Marketplace session warm-ups — specs: .maestro/flows/util/util-login-to-bsc.yaml
 * and util-login-to-sportlots.yaml.
 *
 * Both open /profile/credentials, check the worker is CONNECTED (fail fast,
 * by name, if not), press "Test Credentials" and wait for the live login to
 * report success. Both leave the page on /profile/credentials.
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "./env";

/** A cold marketplace login is a real ~22 s Puppeteer/SSO round trip (the flows' 30 s). */
export const LIVE_LOGIN = 30_000;

async function openCredentials(page: Page, gate = 10_000): Promise<void> {
  await page.goto("/profile/credentials");
  // An in-session navigation, not a cold launch: the flows' 10 s. A page that
  // has not loaded the app yet (a second page opened by a cleanup hook) passes
  // `LAUNCH_GATE`.
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: gate,
  });
}

async function testStoredSession(page: Page, success: RegExp): Promise<void> {
  // While another credential op holds the lock the button reads
  // "Testing..."; wait for the real label (the flows' 30 s).
  const test = page.getByRole("button", { name: "Test Credentials" });
  await expect(test).toBeVisible({ timeout: LIVE_LOGIN });
  await test.click();
  await expect(page.getByText(success)).toBeVisible({ timeout: LIVE_LOGIN });
}

/** Open the BSC credentials page and check the worker is connected (no Test press). */
export async function openBscCredentials(page: Page): Promise<void> {
  await openCredentials(page);
  // BuySportsCards is the default tab.
  await expect(page.getByText("Connected to BuySportsCards")).toBeVisible();
}

/** util-login-to-bsc.yaml */
export async function loginToBsc(page: Page): Promise<void> {
  await openBscCredentials(page);
  await testStoredSession(page, /BSC account authenticated successfully/i);
}

/** util-login-to-sportlots.yaml — two branches on the operator's pause switch. */
export async function loginToSportLots(page: Page, env: FlowEnv): Promise<void> {
  await openCredentials(page);
  const tab = page.getByRole("tab", { name: "SportLots" });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();

  if (!env.SL_PAUSED) {
    await expect(page.getByText("Connected to SportLots")).toBeVisible();
    await testStoredSession(page, /Sportlots account authenticated successfully/i);
    return;
  }

  // Paused: the panel says so, and offers none of the live controls.
  await expect(page.getByRole("heading", { name: "SportLots Credentials" })).toBeVisible();
  await expect(page.getByText("SportLots is on pause", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Sign-ins to SportLots are benched for now/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();
  await expect(page.getByLabel(/SportLots Username/i)).toBeHidden();
}

/** Saving a sign-in through the seed hop signs in live to the marketplace (the bootstrap's 90 s). */
export const SEED_SIGN_IN = 90_000;

/**
 * Remove the worker's BuySportsCards sign-in on Profile (Clear Credentials,
 * confirmed). For NEO-370 this is how a collector STOPS listing: it also stops
 * the sales poll and clears the queue. Pair it with `saveBscSignIn` in a
 * `finally`, so a worker is never left without its sign-in (R7). `gate` is
 * the heading wait: `LAUNCH_GATE` on a page that has not loaded the app yet.
 */
export async function removeBscSignIn(page: Page, gate?: number): Promise<void> {
  await openCredentials(page, gate);
  // BuySportsCards is the default tab.
  await expect(page.getByText("Connected to BuySportsCards")).toBeVisible();
  const clear = page.getByRole("button", { name: "Clear Credentials" });
  await expect(clear).toBeVisible({ timeout: LIVE_LOGIN });
  await clear.click();
  await page.getByRole("button", { name: "Yes, Clear" }).click();
  await expect(page.getByText("Cleared your BuySportsCards connection.")).toBeVisible({ timeout: LIVE_LOGIN });
  await expect(page.getByLabel(/BuySportsCards Username/)).toBeVisible();
}

/**
 * Save the worker's BuySportsCards sign-in again, the way the bootstrap does:
 * the `/testing/seed-credentials` hop (no password ever typed, GUIDE hard
 * rule 7). The page must already be signed in. Lands on Profile → Credentials
 * showing "Connected to BuySportsCards".
 *
 * NEO-370 Rev 5: a saved sign-in syncs (counts pushed, sales polled), but the
 * hop marks a seeded one "not syncing" unless `listing: true` (`listing=on`),
 * so a worker's saved sign-in lists nowhere by default. Only `listing: true`
 * sets up real listing on BuySportsCards; pair it with `removeBscSignIn` +
 * `saveBscSignIn(page)` to stop it again. A real save through the Profile
 * form (never done in E2E: it needs a typed password) would also sync.
 */
export async function saveBscSignIn(page: Page, opts: { listing?: boolean } = {}): Promise<void> {
  const listing = opts.listing ? "&listing=on" : "";
  await page.goto(`/testing/seed-credentials?sites=buysportscards${listing}&redirect=/profile/credentials`);
  // The hop signs in to BuySportsCards live (SEED_SIGN_IN, GUIDE hard rule 3).
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: SEED_SIGN_IN });
  await expect(page.getByText("Connected to BuySportsCards")).toBeVisible();
}

// ---------------------------------------------------------------------------
// NEO-415: eBay. It signs in by eBay's own consent screen, never a password,
// so a spec cannot connect it through the UI. The seed hop connects the
// sandbox seller with a refresh token the deployment holds (the same
// `/testing/seed-credentials` route, `sites=ebay`), and Profile -> Credentials -> eBay
// (its eBay tab; `/profile/ebay` forwards there) is where the connection is read, renewed and removed.
// ---------------------------------------------------------------------------

/** What Profile -> Credentials -> eBay says when the deployment has no eBay wiring. */
export const EBAY_NOT_HOOKED_UP = "eBay isn't hooked up on this NeonBinder yet.";

/**
 * Wait until Profile -> Credentials -> eBay's connection card has settled into ONE of its
 * states (every state carries a Connect or a Disconnect button, the not-wired
 * one a disabled Connect), and FAIL LOUDLY, naming the missing setup, when the
 * deployment is not wired to eBay. A spec for eBay is never skipped for want
 * of its credentials (GUIDE hard rule 1): a deployment without them is a red
 * run that says what to set.
 */
export async function expectEbayHookedUp(page: Page): Promise<void> {
  const connect = page.getByRole("button", { name: /^Connect eBay/ });
  const disconnect = page.getByRole("button", { name: "Disconnect eBay", exact: true });
  // One of the card's controls is showing: the connection state has arrived.
  await expect(connect.or(disconnect).first()).toBeVisible();
  if (await page.getByText(EBAY_NOT_HOOKED_UP, { exact: true }).isVisible()) {
    throw new Error(
      "eBay is not configured on this deployment, so the eBay listing spec cannot run. " +
        "Set EBAY_CLIENT_ID, EBAY_RU_NAME and EBAY_ENVIRONMENT=sandbox on the Convex deployment, " +
        "the eBay client secret on the browser service it calls, and DEV_EBAY_REFRESH_TOKEN " +
        "(a sandbox seller's refresh token) beside them. This spec never skips for missing setup.",
    );
  }
}

/**
 * Connect the worker's sandbox eBay seller the way the bootstrap saves the
 * other sign-ins: the `/testing/seed-credentials` hop (no password, GUIDE hard
 * rule 7). The page must already be signed in. Lands on Profile -> Credentials -> eBay.
 *
 * `listing: true` (`listing=on`) is what a collector's own Connect does:
 * connected IS listing. Without it the hop marks the connection "not syncing".
 * Only the eBay listing spec passes `listing: true`; pair it with
 * `removeEbayConnection`.
 *
 * `gate` is the wait for the full page load the hop ends in (the caller's
 * `LAUNCH_GATE`: the hop is one token exchange with eBay, not a live sign-in).
 * A hop that FAILS prints "Seed failed (...)" and goes nowhere; that is thrown
 * here with its reason. A hop that SKIPS (no refresh token on the deployment,
 * or eBay paused) lands on the page with eBay not connected: the caller's next
 * assertion names it. A deployment with no eBay wiring throws from
 * `expectEbayHookedUp`.
 */
export async function saveEbayConnection(page: Page, opts: { listing?: boolean; gate: number }): Promise<void> {
  const listing = opts.listing ? "&listing=on" : "";
  await page.goto(`/testing/seed-credentials?sites=ebay${listing}&redirect=/profile/ebay`);
  const landed = page.getByRole("heading", { name: "Profile Settings" });
  const seedFailed = page.getByText(/^\[testing-seed\] Seed failed/);
  await expect(landed.or(seedFailed)).toBeVisible({ timeout: opts.gate });
  if (await seedFailed.isVisible()) {
    throw new Error(`The eBay seed hop failed: ${(await seedFailed.innerText()).replace(/\s+/g, " ")}`);
  }
  await expectEbayHookedUp(page);
}

/**
 * Disconnect eBay through the product (Profile -> Credentials -> eBay -> Disconnect eBay,
 * confirmed): it takes down every listing NeonBinder put up on eBay, drops the
 * queue and the saved setup, and leaves the account not connected. Safe to call
 * when eBay is not connected (it then only opens the page and returns).
 * `gate` is the page-load wait (`LAUNCH_GATE` on a page that has not loaded the
 * app yet). The takedown gets the standard 7 s budget.
 */
export async function removeEbayConnection(page: Page, opts: { gate: number }): Promise<void> {
  await page.goto("/profile/ebay");
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: opts.gate });
  const connect = page.getByRole("button", { name: /^Connect eBay/ });
  const disconnect = page.getByRole("button", { name: "Disconnect eBay", exact: true });
  await expect(connect.or(disconnect).first()).toBeVisible();
  if (await disconnect.isVisible()) {
    await disconnect.click();
    await page.getByRole("dialog", { name: "Disconnect eBay?", exact: true }).getByRole("button", { name: "Yes, disconnect" }).click();
    await expect(disconnect).toBeHidden();
  }
  await expect(page.getByRole("button", { name: "Connect eBay", exact: true })).toBeVisible();
}
