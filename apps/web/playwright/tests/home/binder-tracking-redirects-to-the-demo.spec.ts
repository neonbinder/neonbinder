// NEO-464 (R1): the old demo address, /binder-tracking (bookmarks, old links), lands a
// visitor on the demo app at /demo, signed out, replacing the entry: browser Back
// leaves the demo for where they came from instead of bouncing off the old address.
// The old demo kept its side in the query: `?demo=on&side=inventory` lands on the
// demo's Inventory (/demo/inventory), not on its dashboard with the side dropped,
// and the rest of the query goes along: an old `tab=pick` link opens the Pick List.
// The demo's own depth is covered by demo-collection-and-inventory.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "The old /binder-tracking address opens the demo at /demo",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/");
    await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

    await page.goto("/binder-tracking");
    await expect(page).toHaveURL(/\/demo$/);
    await expect(page.getByRole("region", { name: "Demo controls" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign up free" })).toBeVisible();
    await expectAccessible(page, { label: "Demo dashboard, reached from the old address" });

    // The redirect replaced the old address, so Back goes to the page before it.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

    // The old Inventory link keeps its side: the demo's Inventory screen opens, not its dashboard.
    await page.goto("/binder-tracking?demo=on&side=inventory");
    await expect(page).toHaveURL(/\/demo\/inventory(\?|$)/);
    await expect(page.getByRole("region", { name: "About this demo" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Inventory", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toHaveCount(0);
    await expectAccessible(page, { label: "Demo Inventory, reached from the old address" });

    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

    // An old deep link to a tab keeps the tab: the Pick List opens, not the cards.
    await page.goto("/binder-tracking?demo=on&side=inventory&tab=pick");
    await expect(page).toHaveURL(/\/demo\/inventory\?tab=pick$/);
    await expect(
      page.getByRole("region", { name: "Pick List" }).getByRole("heading", { level: 2, name: "Pick List" }),
    ).toBeVisible();
  },
);
