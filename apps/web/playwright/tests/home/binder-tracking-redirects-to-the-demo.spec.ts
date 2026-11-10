// NEO-464 (R1): the old demo address, /binder-tracking (bookmarks, old links), lands a
// visitor on the demo app at /demo, signed out, replacing the entry: browser Back
// leaves the demo for where they came from instead of bouncing off the old address.
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
    await expect(page.getByRole("link", { name: "Sign up free" }).first()).toBeVisible();
    await expectAccessible(page, { label: "Demo dashboard, reached from the old address" });

    // The redirect replaced the old address, so Back goes to the page before it.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();
  },
);
