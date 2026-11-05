// NEO-434 (R1): what eBay sends back on the trip home (`code`, `state`,
// `expires_in`, `error`, `error_description`) leaves the address at once and
// goes nowhere but the eBay panel. A collector returning from eBay lands on
// Profile -> Credentials -> eBay, the refusal or the decline is said, a reload
// or a Back step does not replay the return, and the analytics calls the page
// makes along the way never carry what eBay sent.
//
// Needs the deployment wired to eBay (it FAILS loudly, naming the setup, when
// it is not: `expectEbayHookedUp`), but no seller account: the code is a
// made-up marker with a state NeonBinder never issued, so the server refuses it
// in NeonBinder's words (the copy itself is held by `ebay-return-and-errors`).
// Under an eBay pause the panel offers no Connect, so the paused branch asserts
// that and stops (R2). R7: connects nothing and removes nothing.
//
// Not asserted here, on purpose: what the history entry's own state holds. That
// is under the page, not on it (GUIDE hard rule 2; rule 8 licenses `evaluate`
// for the theme check only). What a user could see of it is a reload replaying
// the return, and that is asserted below. Sentry is off under E2E, so nothing
// here claims anything about it; its scrub is covered by unit tests.
import { gunzipSync } from "node:zlib";
import type { Request } from "@playwright/test";
import { expectEbayHookedUp } from "../../support/credentials";
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

const PAUSED_LINE = "eBay is on a break. Your changes wait here and go up when it's back.";
/** What a return with a state NeonBinder never issued is told (NONCE_STALE in convex/ebayConnect.ts). */
const STALE_HOOKUP = "That eBay hookup timed out. Press Connect again.";
const DECLINED_LINE = "No worries, eBay isn't connected. Connect whenever you're ready.";
const CREDENTIALS_EBAY = /\/profile\/credentials\?platform=ebay$/;
/** The product-analytics calls: through the app's own /ingest path or straight to PostHog. */
const isAnalytics = (request: Request) => {
  const url = new URL(request.url());
  return url.pathname.startsWith("/ingest") || url.hostname.endsWith("posthog.com");
};

/** Everything a request says, as text: its address, its body, and the body gunzipped or base64-decoded. */
function readable(request: Request): string {
  const parts = [request.url()];
  const body = request.postDataBuffer();
  if (body) {
    const raw = body.toString("latin1");
    parts.push(raw);
    if (body[0] === 0x1f && body[1] === 0x8b) {
      try {
        parts.push(gunzipSync(body).toString("utf8"));
      } catch {
        // A body that is not gzip after all is already in `raw`.
      }
    }
    if (raw.startsWith("data=")) {
      parts.push(Buffer.from(decodeURIComponent(raw.slice(5)), "base64").toString("utf8"));
    }
  }
  return parts.join("\n");
}

test(
  "A return from eBay leaves the address at once: refusal and decline are said, a reload does not replay them, and analytics never sees them",
  { tag: ["@profile", "@credentials"] },
  async ({ page, signIn, env }) => {
    // One token, so it survives any encoding the analytics call uses.
    const marker = `ebayreturn${env.ATTEMPT_TOKEN}`;
    const connect = page.getByRole("button", { name: "Connect eBay", exact: true });
    const heading = page.getByRole("heading", { name: "Profile Settings" });
    const refusal = page.getByRole("alert").filter({ hasText: STALE_HOOKUP });
    const declined = page.getByRole("status").filter({ hasText: DECLINED_LINE });

    const analytics: string[] = [];
    page.on("request", (request) => {
      if (isAnalytics(request)) analytics.push(readable(request));
    });

    await signIn("/profile/ebay");
    await expect(heading).toBeVisible({ timeout: LAUNCH_GATE });
    // Fails loudly, naming the setup, when this deployment has no eBay wiring.
    await expectEbayHookedUp(page);
    if (env.EBAY_PAUSED) {
      await expect(page.getByText(PAUSED_LINE, { exact: true })).toBeVisible();
      await expect(connect).toBeHidden();
      return;
    }
    await expect(connect).toBeVisible();

    // --- A code eBay sent, with a state NeonBinder never issued ---------------------------------
    // (A full page load, as eBay's redirect is.) The page sends its first analytics call
    // as it starts; wait for it so the last check has something to look at.
    const started = page.waitForRequest(isAnalytics, { timeout: 7_000 });
    await page.goto(`/profile/ebay?code=${marker}&state=bogus&expires_in=${marker}`);
    await expect(heading).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(refusal).toBeVisible();
    await expect(page).toHaveURL(CREDENTIALS_EBAY);
    await expect(connect).toBeVisible();
    expect(page.url(), "nothing eBay sent stays on the address").not.toContain(marker);
    // A positive anchor: this deployment's analytics did send something. It fails loudly
    // when the build has no PostHog key (VITE_POSTHOG_KEY), instead of passing vacuously.
    await started;

    // A reload does not replay the return: the Credentials page opens as itself, no refusal.
    await page.reload();
    await expect(heading).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(connect).toBeVisible();
    await expect(refusal).toHaveCount(0);
    await expect(page).toHaveURL(CREDENTIALS_EBAY);

    // Back is not an address carrying the code.
    await page.goBack();
    await expect(page).toHaveURL(CREDENTIALS_EBAY);
    await expect(heading).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(connect).toBeVisible();
    await expect(refusal).toHaveCount(0);
    expect(page.url()).not.toContain(marker);

    // --- A no from eBay ---------------------------------------------------------------------------
    await page.goto(`/profile/ebay?error=access_denied&error_description=${marker}`);
    await expect(heading).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(declined).toBeVisible();
    await expect(page).toHaveURL(CREDENTIALS_EBAY);
    expect(page.url(), "nothing eBay sent stays on the address").not.toContain(marker);
    // The decline is said once: a reload brings the page back without it. (It is set the moment
    // the panel mounts, so with Connect on screen its absence is a real one.)
    await page.reload();
    await expect(heading).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(connect).toBeVisible();
    await expect(declined).toHaveCount(0);
    await expect(page).toHaveURL(CREDENTIALS_EBAY);

    // --- Analytics: the calls above, from the sign-in to the last reload, never carried it ------
    expect(analytics.length, "the page's analytics calls were seen").toBeGreaterThan(0);
    // A count, not the calls: a failure must not print request bodies into the published report.
    const leaks = analytics.filter((call) => call.includes(marker)).length;
    expect(leaks, "analytics calls carrying what eBay sent").toBe(0);
  },
);
