// R1: the signed-out home page's "Check it Out" section, right after the hero,
// links straight into the collection demo (/binder-tracking?demo=on). The demo's
// own depth (tabs, binders, theme) is covered by binder-tracking-demo and
// binder-tracking-demo-theme; this spec proves only the doorway from home.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Landing page: the Check it Out link opens the collection demo, and Back to the tour leaves it",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/");

    const checkItOut = page.getByRole("region", { name: "Check it Out" });
    await expect(checkItOut).toBeVisible();
    await expect(checkItOut.getByRole("heading", { level: 2, name: "Check it Out", exact: true })).toBeVisible();
    await expectAccessible(page, { within: checkItOut, label: "Landing page, Check it Out" });

    // The link opens the demo directly (no tour stop in between).
    await checkItOut.getByRole("link", { name: "Check it Out", exact: true }).click();
    await expect(page).toHaveURL(/\/binder-tracking\?demo=on$/);
    await expect(page.getByRole("region", { name: "About this demo" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();

    // Arriving from home there is no tour entry behind the demo, so "Back to
    // the tour" replaces the demo with the tour.
    await page.getByRole("button", { name: "Back to the tour" }).click();
    await expect(page).toHaveURL(/\/binder-tracking$/);
    await expect(page.getByRole("region", { name: "Take it for a spin" })).toBeVisible();

    // Browser Back steps through the URL: the demo's entry was replaced, so the
    // previous view is the home page, not the demo.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(checkItOut).toBeVisible();
  },
);
