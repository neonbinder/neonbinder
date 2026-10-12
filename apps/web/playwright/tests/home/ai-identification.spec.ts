// Origin: .maestro/flows/home/ai-identification.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect } from "../../support/fixtures";

test("AI Card Identification Feature Page", { tag: ["@marketing", "@home"] }, async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  // The landing page's feature card leads to the feature page.
  await page.getByRole("button", { name: /AI-Based/ }).click();
  await expect(page.getByText("Instant Recognition")).toBeVisible();
  await expect(page.getByText("Complete Card Data")).toBeVisible();
  await expect(page.getByText("Accuracy & Verification")).toBeVisible();
  await expect(page.getByText("Machine Learning")).toBeVisible();

  // Get Started opens the sign-up modal; dismissing it returns to the page.
  await page.getByRole("button", { name: "Get Started" }).click();
  const signUp = page.getByText("Create your account");
  await expect(signUp).toBeVisible();
  // Clicking the backdrop (far left edge) dismisses the modal.
  const size = page.viewportSize()!;
  await page.mouse.click(size.width * 0.05, size.height * 0.5);
  await expect(signUp).toBeHidden();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});
