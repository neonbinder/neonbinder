// NEO-415 (R1): eBay's consent round trip, both ends, without an eBay account.
// A collector who presses Connect on Profile -> eBay is sent to eBay's own
// authorize page (the sandbox's, here), asking for what NeonBinder needs; and a
// return from eBay that NeonBinder did not start (a code with a state it never
// issued) is refused in NeonBinder's words, as an alert, with the code and the
// state scrubbed from the address bar so a refresh or Back cannot replay them.
//
// Needs the deployment wired to eBay's SANDBOX (it FAILS loudly, naming the
// missing setup, when it is not: `expectEbayHookedUp`), but no seller account:
// it never gets past eBay's door. The leg to eBay is not followed: the request
// to eBay's authorize host is answered by the test with an empty page, so the
// browser "arrives" there and nothing real is asked of eBay. The connection
// itself, with a real seller, is proved by
// `collection/inventory-ebay-sandbox-listing-1988-topps-base`.
//
// Under an eBay pause (`env.EBAY_PAUSED`) the page offers no Connect, so the
// paused branch asserts that and stops (R2: both branches end in hard asserts).
//
// R7: it connects nothing and removes nothing. Pressing Connect leaves a
// one-time hookup note on the worker's own eBay settings, which the next
// per-user reset clears and a refused return leaves alone.
import { expectEbayHookedUp } from "../../support/credentials";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const SANDBOX_LINE = "Test mode: this NeonBinder talks to eBay's sandbox, so nothing lists for real.";
const PAUSED_LINE = "eBay is on a break. Your changes wait here and go up when it's back.";
/** What a return with a state NeonBinder never issued is told (NONCE_STALE in convex/ebayConnect.ts). */
const STALE_HOOKUP = "That eBay hookup timed out. Press Connect again.";
/** eBay's sandbox consent page: where Connect must send the collector. */
const SANDBOX_AUTHORIZE = /^https:\/\/auth\.sandbox\.ebay\.com\/oauth2\/authorize\?/;
const SANDBOX_HOST = /^https:\/\/auth\.sandbox\.ebay\.com\//;

test(
  "Profile -> eBay: Connect leaves for eBay's sandbox consent page, and a return with a state NeonBinder never issued is refused clean",
  { tag: ["@profile", "@credentials"] },
  async ({ page, signIn, env }) => {
    const connect = page.getByRole("button", { name: "Connect eBay", exact: true });

    await signIn("/profile/ebay");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    // Fails loudly, naming the setup, when this deployment has no eBay wiring.
    await expectEbayHookedUp(page);

    if (env.EBAY_PAUSED) {
      await expect(page.getByText(PAUSED_LINE, { exact: true })).toBeVisible();
      await expect(connect).toBeHidden();
      await expectAccessible(page, { label: "Profile, eBay on a break" });
      return;
    }

    await expect(
      page.getByText(SANDBOX_LINE, { exact: true }),
      "this spec follows Connect to eBay's authorize host; it runs only on a deployment wired to eBay's SANDBOX (EBAY_ENVIRONMENT=sandbox)",
    ).toBeVisible();
    await expect(connect).toBeVisible();

    // --- Connect: off to eBay's sandbox consent page ---------------------------------------
    // The test answers eBay's host itself, so nothing is asked of eBay.
    await page.route(SANDBOX_HOST, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>eBay consent (stubbed by the test)</title>" }),
    );
    await connect.click();
    await expect(page).toHaveURL(SANDBOX_AUTHORIZE);
    // What NeonBinder asks eBay for: a code grant for this app, handed back with the one-time note it kept.
    const asked = new URL(page.url());
    expect(asked.searchParams.get("response_type"), "an authorization-code grant").toBe("code");
    expect(asked.searchParams.get("client_id"), "this app's id").toBeTruthy();
    expect(asked.searchParams.get("redirect_uri"), "where eBay sends the collector back").toBeTruthy();
    expect(asked.searchParams.get("state"), "the one-time note NeonBinder checks on the way back").toBeTruthy();
    const scopes = (asked.searchParams.get("scope") ?? "").split(" ");
    for (const wanted of ["sell.inventory", "sell.account", "sell.fulfillment"]) {
      expect(scopes.some((scope) => scope.endsWith(`/${wanted}`)), `the consent asks for ${wanted}`).toBe(true);
    }
    await page.unroute(SANDBOX_HOST);
    // Back steps to the page Connect was pressed on, not connected, Connect ready again.
    await page.goBack();
    await expect(page).toHaveURL(/\/profile\/ebay$/);
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(connect).toBeVisible();

    // --- A return NeonBinder did not start: refused, scrubbed, still not connected -----------
    // (A full page load, as eBay's redirect is.)
    await page.goto("/profile/ebay?code=x&state=bogus");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    const refusal = page.getByRole("alert").filter({ hasText: STALE_HOOKUP });
    await expect(refusal).toBeVisible();
    // The code and the state are gone from the address bar (replaced, so Back cannot land on them).
    await expect(page).toHaveURL(/\/profile\/ebay$/);
    // Nothing connected, and the keyboard is on Connect to try again.
    await expect(page.getByText(/^Rockin' on eBay as /)).toBeHidden();
    await expect(page.getByText("Heads up: connecting starts listing", { exact: true })).toBeVisible();
    await expect(connect).toBeFocused();
    await expectAccessible(page, { label: "Profile, eBay return refused" });
    await page.goBack();
    await expect(page).toHaveURL(/\/profile\/ebay$/);
    await expect(page).not.toHaveURL(/code=|state=/);
  },
);
