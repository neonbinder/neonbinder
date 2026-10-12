// Origin: .maestro/flows/home/landing-marketing.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect } from "../../support/fixtures";

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
});
