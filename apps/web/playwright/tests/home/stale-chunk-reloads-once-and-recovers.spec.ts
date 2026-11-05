// R1: a visitor whose open tab asks for a page chunk the server no longer has
// (a deploy happened under them) gets one automatic reload and the page they
// clicked opens, with no error message (NEO-434). The chunk is answered 404 once
// (support/stale-chunks.ts), which is exactly the stale-tab failure; the second
// request, from the reloaded page, goes through.
import { test, expect, expectAccessible } from "../../support/fixtures";
import { watchStaleChunks } from "../../support/stale-chunks";

const CRASH_MESSAGE = "An error occurred. Please refresh the page.";

test(
  "A stale page chunk reloads the page once and the route opens with no error",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Signed out (R4): each test has its own browser context, so the reload
    // guard in sessionStorage starts empty.
    const chunks = watchStaleChunks(page);
    await page.goto("/");
    // The landing page is in the entry bundle: once it shows, everything the
    // page loads from here on is a lazy route's chunk.
    await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();

    // /about has a chunk of its own. Arm right before the click that asks for it.
    const about = page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "About", exact: true });
    await chunks.arm("fail-once");
    const injected = chunks.firstBlocked();
    await about.click();

    // The failure was really injected: a code file was answered 404.
    const gone = (await injected).url();

    // Recovery: the route opens, and the visitor never sees the crash message.
    await expect(page.getByRole("heading", { level: 1, name: "About Neon Binder" })).toBeVisible();
    await expect(page.getByText(CRASH_MESSAGE)).toHaveCount(0);
    await expect(page).toHaveURL(/\/about$/);
    await expectAccessible(page, { label: "About page after a stale-chunk reload" });

    // The same file was asked for again, by the reloaded page, and came back;
    // the page reloaded once, not more.
    const statuses = chunks.statusesOf(gone);
    expect(chunks.blockedUrls()).toEqual([gone]);
    expect(statuses[0]).toBe(404);
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[statuses.length - 1]).toBeLessThan(400);
    expect(chunks.navigations()).toBe(1);

    // Navigation lives in the URL: Back from the recovered page returns to the landing page.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
  },
);
