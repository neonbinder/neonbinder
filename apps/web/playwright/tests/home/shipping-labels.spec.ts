// Origin: .maestro/flows/home/shipping-labels.yaml (Maestro suite retired in NEO-341; see git history)
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible } from "../../support/fixtures";

test("Shipping Labels Feature Page", { tag: ["@marketing", "@home"] }, async ({ page, isMobile }) => {
  // Signed out on purpose: "Get Started" only opens the sign-up modal for a
  // visitor with no account.
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  // The card's heading is "Print 4×6 Shipping Labels" (multiplication sign).
  await page.getByRole("button", { name: /Shipping Labels/ }).click();

  // The page's promise, then its feature sections.
  await expect(page.getByText("Print the Label, Ship the Card")).toBeVisible();
  await expect(page.getByText("Your Address, Saved Once")).toBeVisible();
  await expect(page.getByText("Type The Buyer, Hit Print")).toBeVisible();
  await expect(page.getByText(/Fits Any 4.6 Label Printer/)).toBeVisible();
  // NEO-207: the postage section.
  await expect(page.getByText("Buy The Postage Too")).toBeVisible();
  // Heading outline: h1, each section an h2, its cards h3 (they were h4).
  await expect(page.getByRole("heading", { level: 1, name: "Print the Label, Ship the Card" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Your Address, Saved Once" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Set It And Forget It" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Reprint Without Re-Buying" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4 })).toHaveCount(0);
  await expectAccessible(page, { label: "shipping-labels feature page" });

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
