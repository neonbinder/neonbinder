// Origin: .maestro/flows/home/landing-marketing.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible } from "../../support/fixtures";

test("Landing Page Marketing Content", { tag: ["@marketing", "@home"] }, async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  await expect(page.getByText(/Free Tier/).first()).toBeVisible();

  // The six-up feature grid.
  for (const card of [
    /Collection Tracking/,
    /AI-Based Card Identification/,
    /Inventory/,
    /Shipping Labels/,
    /Spine Labels in Team Colors/,
    /9-Pocket Placeholder Sheets/,
  ]) {
    await expect(page.getByText(card).first()).toBeVisible();
  }

  await expect(page.getByText("How It Works", { exact: true }).first()).toBeVisible();
  // The feature-card titles sit inside the cards' buttons and are h2s (they
  // were h3, under an h1 with no h2 between). Chromium's accessibility tree
  // keeps a heading inside a button, so the level is a real, perceivable one.
  await expect(page.getByRole("heading", { level: 1, name: "Neon Binder" })).toBeVisible();
  for (const title of [
    "Check it Out",
    "Card Show Sales",
    "Fill Binders for Collection Tracking",
    "AI-Based Card Identification",
    "Manage Multiple Inventory Sites",
    "Shipping Labels & PWE Postage",
    "Spine Labels in Team Colors",
    "9-Pocket Placeholder Sheets",
  ]) {
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }
  await expect(page.getByRole("heading", { level: 2, name: "How It Works" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Take Pictures of Your Cards" })).toBeVisible();
  await expectAccessible(page, { label: "landing page, marketing grid" });
});
