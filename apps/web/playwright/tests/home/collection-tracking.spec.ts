// Origin: .maestro/flows/home/collection-tracking.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect } from "../../support/fixtures";

test("Collection Tracking Feature Page", { tag: ["@marketing", "@home"] }, async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  // The Collection Tracking card in the landing grid leads to its feature page.
  await page.getByRole("button", { name: /Collection Tracking/ }).click();

  // Four feature sections.
  await expect(page.getByText("Snap & Upload")).toBeVisible();
  await expect(page.getByText("We Find Your Cards")).toBeVisible();
  await expect(page.getByText("Build It Your Way")).toBeVisible();
  await expect(page.getByText("Track Everything")).toBeVisible();

  // The CTA opens the sign-up dialog; clicking beside it dismisses it.
  await page.getByRole("button", { name: "Get Started" }).click();
  const signUp = page.getByText("Create your account");
  await expect(signUp).toBeVisible();
  const size = page.viewportSize()!;
  await page.mouse.click(size.width * 0.05, size.height * 0.5);
  await expect(signUp).toBeHidden();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});
