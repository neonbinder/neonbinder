// R1: the public, signed-out Privacy Policy at /privacy (NEO-421) is reachable
// from the landing page footer and from the About page, and reads as a policy:
// one h1, an eBay section, a contact address, and it passes axe in light and dark.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Privacy policy: reachable from the landing footer and About, with its eBay section and contact address",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/");

    // The landing footer carries the site links.
    const siteNav = page.getByRole("navigation", { name: "Site" });
    await expect(siteNav).toBeVisible();
    await expect(siteNav.getByRole("link", { name: "About", exact: true })).toBeVisible();
    await siteNav.getByRole("link", { name: "Privacy", exact: true }).click();

    // The policy page: exactly one h1.
    await expect(page).toHaveURL(/\/privacy$/);
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Privacy Policy");
    await expect(h1).toHaveCount(1);

    // The eBay section, and the in-page nav reaching it.
    const ebay = page.getByRole("region", { name: "eBay", exact: true });
    await expect(ebay.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Policy sections" })
      .getByRole("link", { name: "eBay", exact: true })
      .click();
    await expect(page).toHaveURL(/\/privacy#ebay$/);
    await expect(ebay.getByRole("heading", { level: 2, name: "eBay", exact: true })).toBeInViewport();

    // Where privacy questions and deletion requests go.
    const contact = page.getByRole("region", { name: "Contact us", exact: true });
    await expect(contact.getByRole("heading", { level: 2, name: "Contact us", exact: true })).toBeVisible();
    await expect(contact.getByRole("link", { name: "support@neonbinder.io", exact: true })).toHaveAttribute(
      "href",
      "mailto:support@neonbinder.io",
    );

    // The whole policy passes WCAG 2.2 A/AA, light and dark.
    await expectAccessible(page, { label: "Privacy policy" });

    // Back steps to the page the visitor came from, and the footer's About
    // link opens the About page.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(siteNav).toBeVisible();
    await siteNav.getByRole("link", { name: "About", exact: true }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole("heading", { level: 1, name: "About Neon Binder" })).toBeVisible();

    // About links to the policy.
    await page.getByRole("link", { name: "Privacy Policy", exact: true }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();

    // Browser Back steps through the URL: the previous view is About.
    await page.goBack();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole("heading", { level: 1, name: "About Neon Binder" })).toBeVisible();
  },
);
