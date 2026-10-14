// Origin: .maestro/flows/home/print-shop.yaml (Maestro suite retired in NEO-341; see git history)
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible } from "../../support/fixtures";

test("Print Shop Feature Page", { tag: ["@marketing", "@home"] }, async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Spine Labels in Team Colors/ }).click();
  await expect(page.getByRole("heading", { name: "The Print Shop" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spine Labels In Team Colors" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hold Their Spot In The Binder" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Print, Cut, Slide In" })).toBeVisible();
  await expectAccessible(page, { label: "print-shop feature page" });

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
