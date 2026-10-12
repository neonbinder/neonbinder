// Origin: .maestro/flows/home/managing-inventory.yaml (Maestro suite retired in NEO-341; see git history)
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible } from "../../support/fixtures";

test("Managing Inventory Feature Page", { tag: ["@marketing", "@home"] }, async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  // The Inventory card in the landing grid leads to its feature page. The
  // flow's 11 s was Maestro swipe travel; a click scrolls to it itself.
  await page.getByRole("button", { name: /Multiple Inventory/ }).click();

  // Four feature sections.
  await expect(page.getByText("One Upload, Multiple Platforms")).toBeVisible();
  await expect(page.getByText("Real-Time Inventory Control")).toBeVisible();
  await expect(page.getByText("Sales Intelligence")).toBeVisible();
  await expect(page.getByText("Dominate the Card Show")).toBeVisible();
  await expectAccessible(page, { label: "managing-inventory feature page" });

  // The CTA opens the sign-up dialog; clicking beside it dismisses it.
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
