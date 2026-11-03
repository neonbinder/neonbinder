// NEO-415 (R1): everything for a marketplace is managed in Profile -> Credentials
// (Jason, 2026-11-02), eBay included. eBay has no password to save, so its tab
// shows its own setup in place of the sign-in form: the connection card and,
// once connected, the setup below it. A collector finds eBay among the
// marketplace tabs, sees its connection there (none of the sign-in controls,
// no pointer to another page), and the picked marketplace lives in the address:
// `?platform=ebay` opens it, and Back steps back through the tabs. eBay has no
// Profile tab of its own; `/profile/ebay` is only where eBay's trip home lands,
// and a plain visit opens Credentials with eBay picked, the Credentials tab lit.
//
// Reads only: it saves, tests and clears nothing, and works on whatever state
// the worker's eBay is in (not wired, not connected, connected), so it needs
// no eBay wiring and no fixture. The connection itself is proved by
// `collection/inventory-ebay-sandbox-listing-1988-topps-base`, and the consent
// round trip by `profile/ebay-return-and-errors`.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Credentials: eBay's setup shows in its tab, ?platform=ebay picks it, Back steps through the tabs, and /profile/ebay lands there",
  { tag: ["@profile", "@credentials"] },
  async ({ page, signIn }) => {
    await signIn("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });

    const sites = page.getByRole("tablist");
    const nav = page.getByRole("navigation", { name: "Profile sections" });
    const connect = page.getByRole("button", { name: /^Connect eBay/ });
    const disconnect = page.getByRole("button", { name: "Disconnect eBay", exact: true });

    // The marketplaces sit side by side; the first is picked when the address names none.
    const bsc = sites.getByRole("tab", { name: "BuySportsCards", exact: true });
    const ebay = sites.getByRole("tab", { name: "eBay", exact: true });
    await expect(sites.getByRole("tab", { name: "SportLots", exact: true })).toBeVisible();
    await expect(bsc).toHaveAttribute("aria-selected", "true");
    await expect(ebay).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("heading", { level: 2, name: "BuySportsCards Credentials", exact: true })).toBeVisible();

    // eBay's tab: its own setup in place, not a pointer to another page.
    await ebay.click();
    await expect(page).toHaveURL(/\/profile\/credentials\?platform=ebay$/);
    await expect(ebay).toHaveAttribute("aria-selected", "true");
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeVisible();
    // The connection has arrived: every state carries a Connect or a Disconnect.
    await expect(connect.or(disconnect).first()).toBeVisible();
    // None of the password sign-in controls, and no hand-off to another page.
    await expect(panel.getByRole("button", { name: "Test Credentials" })).toBeHidden();
    await expect(panel.getByRole("button", { name: "Connect", exact: true })).toBeHidden();
    await expect(panel.getByRole("button", { name: "Clear Credentials" })).toBeHidden();
    await expect(panel.getByLabel(/Username/)).toBeHidden();
    await expect(page.getByRole("link", { name: "Set up eBay on its own page", exact: true })).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: "BuySportsCards Credentials", exact: true })).toBeHidden();
    await expectAccessible(page, { label: "Profile, Credentials, eBay tab" });

    // eBay has no Profile tab of its own; Credentials is the lit one.
    await expect(nav.getByRole("link", { name: "Credentials", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "eBay", exact: true })).toHaveCount(0);

    // Back steps to the tab the collector came from.
    await page.goBack();
    await expect(page).toHaveURL(/\/profile\/credentials$/);
    await expect(bsc).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { level: 2, name: "BuySportsCards Credentials", exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeHidden();

    // The address picks the marketplace: a full load of ?platform=ebay opens eBay's tab.
    await page.goto("/profile/credentials?platform=ebay");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(sites.getByRole("tab", { name: "eBay", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeVisible();
    await expect(connect.or(disconnect).first()).toBeVisible();

    // /profile/ebay (where eBay's trip home lands) opens Credentials with eBay picked.
    await page.goto("/profile/ebay");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page).toHaveURL(/\/profile\/credentials\?platform=ebay$/);
    await expect(sites.getByRole("tab", { name: "eBay", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Credentials", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "eBay", exact: true })).toHaveCount(0);
    await expectAccessible(page, { label: "Profile, /profile/ebay lands on Credentials, eBay" });
  },
);
