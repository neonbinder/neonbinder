// NEO-422: eBay's fixed OAuth return pages, /oauth/ebay/return (production
// RuName) and /oauth/ebay/sandbox-return (sandbox RuName).
// R1: each page forwards eBay's trip home to /profile/ebay on the origin named
// in `state`, carrying eBay's query string across byte for byte; it refuses
// (stays put, tells the user) any trip it cannot vouch for, and the production
// page vouches for fewer origins than the sandbox one; and neither page talks
// to any origin but its own, so eBay's code never reaches a third party.
// Public and backend-free: entered signed out with page.goto (R4). The state
// is built inline (specs never import app code) in the documented
// `<nonce>.<base64url(origin)>` format.
import { test, expect, expectAccessible } from "../../support/fixtures";

const PRODUCTION = "/oauth/ebay/return";
const SANDBOX = "/oauth/ebay/sandbox-return";

test(
  "The eBay return pages forward a vouched-for trip to eBay settings, refuse the rest and call no one else",
  { tag: ["@smoke", "@home"] },
  async ({ page, baseURL }) => {
    const ownOrigin = new URL(baseURL ?? "").origin;
    const nonce = "9f2c61ab07d34e58b1c6a0f3d5e87a42";
    const stateFor = (origin: string) => `${nonce}.${Buffer.from(origin).toString("base64url")}`;

    // Every request any page makes, for the last assertion: nothing may leave
    // the page's own origin (no analytics, no error tracker, no auth widget).
    const foreign: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.protocol.startsWith("http") && url.origin !== ownOrigin) foreign.push(req.url());
    });

    // The destination is answered with an empty page: /profile/ebay lands with
    // NEO-415, and the assertions below are on the navigation request the
    // forward made. Without the stub the signed-out SPA boots there and (a)
    // calls PostHog and Clerk, which the last assertion would count against
    // the return pages, and (b) leaves a navigation in flight that hung the
    // next page.goto about half the time.
    await page.route(
      (url) => url.pathname === "/profile/ebay",
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>eBay settings</title>",
        }),
    );

    // Forward, on both pages. The code carries "+" and "%2F" and the trip has
    // extra params: all of it must reach /profile/ebay exactly as eBay sent it.
    for (const path of [PRODUCTION, SANDBOX]) {
      const sent = `?code=ab12+cd34%2Fef56%3D%3D&state=${stateFor(ownOrigin)}&expires_in=299&note=a%20b`;
      const [forwarded] = await Promise.all([
        page.waitForRequest(
          (req) => req.isNavigationRequest() && new URL(req.url()).pathname === "/profile/ebay",
        ),
        page.goto(`${path}${sent}`),
      ]);
      const landed = new URL(forwarded.url());
      expect(landed.origin, `${path} forwards to its own origin`).toBe(ownOrigin);
      expect(landed.search, `${path} keeps eBay's query byte for byte`).toBe(sent);
    }

    const lost = page.getByRole("heading", { name: "That eBay trip got lost", level: 1 });
    const back = page.getByRole("link", { name: "Back to eBay settings" });
    const expectRefused = async (path: string) => {
      await expect(lost).toBeVisible();
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute("href", "/profile/ebay");
      await expect(page).toHaveURL(new RegExp(`${path}\\?`));
    };

    // Refused: another local origin is fine for the sandbox RuName only, so
    // the production page keeps the trip, explains itself and offers the way
    // back. (The foreign-request check below proves nothing was sent to it.)
    await page.goto(`${PRODUCTION}?code=abc123&state=${stateFor("http://localhost:1")}`);
    await expectRefused(PRODUCTION);

    // Refused: an origin that is nobody's, on the production page. Axe runs on
    // this error state in light and dark.
    await page.goto(`${PRODUCTION}?code=abc123&state=${stateFor("https://evil.example")}`);
    await expectRefused(PRODUCTION);
    await expectAccessible(page, { label: "eBay return page, trip refused" });

    // No state at all: the same error page.
    await page.goto(`${PRODUCTION}?code=abc123`);
    await expectRefused(PRODUCTION);

    // Neither page, in any of the visits above, called any other origin.
    expect(foreign).toEqual([]);
  },
);
