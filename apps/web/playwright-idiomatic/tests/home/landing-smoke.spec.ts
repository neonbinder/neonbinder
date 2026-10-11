// Spec: .maestro/flows/home/landing-smoke.yaml
import { test, expect } from "../../support/fixtures";

test("Landing Page Smoke Test", { tag: ["@smoke", "@home"] }, async ({ page }) => {
  // Signed out: every test starts in a fresh browser context.
  await page.goto("/");

  // Header: logo text and Sign In button.
  const header = page.getByRole("banner");
  await expect(header.getByText("Neon Binder", { exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: "Sign In" })).toBeVisible();

  // Hero CTA.
  await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();

  // Bottom CTA, at the end of a long marketing page. The flow's 25 s is a
  // signed-off TRAVEL budget for Maestro's swipes; kept as stated.
  const createAccount = page.getByRole("button", { name: "Create Free Account" });
  await createAccount.scrollIntoViewIfNeeded({ timeout: 25_000 });
  await expect(createAccount).toBeInViewport();
});
