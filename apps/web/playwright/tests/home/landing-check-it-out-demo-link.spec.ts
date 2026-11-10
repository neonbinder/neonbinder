// R1: the signed-out home page's "Check it Out" section, right after the hero,
// links straight into the demo (/demo/collection). The demo's own depth is
// covered by its own specs; this spec proves only the doorway from home and the
// way back out.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Landing page: the Check it Out link opens the collection demo, and Back to the tour returns home",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/");

    const checkItOut = page.getByRole("region", { name: "Check it Out" });
    await expect(checkItOut).toBeVisible();
    await expect(checkItOut.getByRole("heading", { level: 2, name: "Check it Out", exact: true })).toBeVisible();
    await expectAccessible(page, { within: checkItOut, label: "Landing page, Check it Out" });

    // The link opens the demo directly.
    await checkItOut.getByRole("link", { name: "Check it Out", exact: true }).click();
    await expect(page).toHaveURL(/\/demo\/collection$/);
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();

    // "Back to the tour" in the demo's tab bar goes back to the home page.
    await page.getByRole("link", { name: "Back to the tour" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(checkItOut).toBeVisible();
  },
);
