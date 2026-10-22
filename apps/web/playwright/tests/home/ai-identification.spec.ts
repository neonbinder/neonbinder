// Origin: .maestro/flows/home/ai-identification.yaml (Maestro suite retired in NEO-341; see git history)
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible } from "../../support/fixtures";

test("AI Card Identification Feature Page", { tag: ["@marketing", "@home"] }, async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  // The landing page's feature card leads to the feature page.
  await page.getByRole("button", { name: /AI-Based/ }).click();
  await expect(page.getByText("Instant Recognition")).toBeVisible();
  await expect(page.getByText("Complete Card Data")).toBeVisible();
  await expect(page.getByText("Accuracy & Verification")).toBeVisible();
  await expect(page.getByText("Machine Learning")).toBeVisible();
  // Heading outline: h1, then each section an h2, then its cards h3 (they were
  // h4, which skipped a level). No h4 is left to skip to.
  await expect(page.getByRole("heading", { level: 1, name: "Identify Cards Like a Pro" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Instant Recognition" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Lightning-Fast Speed" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Learns From You" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4 })).toHaveCount(0);
  await expectAccessible(page, { label: "ai-identification feature page" });

  // Get Started opens the sign-up modal; dismissing it returns to the page.
  await page.getByRole("button", { name: "Get Started" }).click();
  const signUp = page.getByText("Create your account");
  await expect(signUp).toBeVisible();
  await dismissSignUp(page, isMobile);
  await expect(signUp).toBeHidden();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});

// Clicking beside the dialog dismisses it on a desktop viewport; on a phone the
// sign-up card spans nearly the whole width, so there is no "beside": Escape is
// the dismissal there.
async function dismissSignUp(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.keyboard.press("Escape");
    return;
  }
  const size = page.viewportSize()!;
  await page.mouse.click(size.width * 0.05, size.height * 0.5);
}
