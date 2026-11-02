// NEO-415 (R1): eBay has no password to save, so its tab among the marketplace
// sign-ins on Profile -> Credentials is a pointer to its own Profile page.
// The collector finds eBay where they look for sign-ins, reads why it is
// different, finds none of the sign-in controls there, follows the link to
// Profile -> eBay, sees the page and the Profile nav marking it, and Back
// returns to Credentials.
//
// Reads only: it saves, tests and clears nothing, and works on whatever state
// the worker's eBay is in (not wired, not connected, connected), so it needs
// no eBay wiring and no fixture. The connection itself is proved by
// `collection/inventory-ebay-sandbox-listing-1988-topps-base`.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Credentials: the eBay tab points to the eBay page, which the Profile nav marks",
  { tag: ["@profile", "@credentials"] },
  async ({ page, signIn }) => {
    await signIn("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });

    // The tab sits beside the other marketplaces.
    const sites = page.getByRole("tablist");
    await expect(sites.getByRole("tab", { name: "BuySportsCards", exact: true })).toBeVisible();
    await expect(sites.getByRole("tab", { name: "SportLots", exact: true })).toBeVisible();
    await sites.getByRole("tab", { name: "eBay", exact: true }).click();

    // A pointer: why it is different, and none of the sign-in controls.
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeVisible();
    await expect(
      panel.getByText("eBay skips the password. You connect it on eBay's own sign-in screen, and pick your shipping, payment and returns right after."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Clear Credentials" })).toBeHidden();
    await expect(page.getByLabel(/Username/)).toBeHidden();
    await expectAccessible(page, { label: "Profile, Credentials, eBay pointer" });

    // The link leads to the eBay page; the Profile nav marks it.
    await panel.getByRole("link", { name: "Set up eBay on its own page", exact: true }).click();
    await expect(page).toHaveURL(/\/profile\/ebay$/);
    await expect(page.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Profile sections" });
    await expect(nav.getByRole("link", { name: "eBay", exact: true })).toHaveAttribute("aria-current", "page");
    await expectAccessible(page, { label: "Profile, eBay" });

    // Back steps to Credentials.
    await page.goBack();
    await expect(page).toHaveURL(/\/profile\/credentials$/);
    await expect(sites.getByRole("tab", { name: "eBay", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Credentials", exact: true })).toHaveAttribute("aria-current", "page");
  },
);
