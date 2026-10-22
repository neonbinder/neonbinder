// Origin: .maestro/flows/home/easypost-setup.yaml (Maestro suite retired in NEO-341; see git history)
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible } from "../../support/fixtures";

test("EasyPost Setup Guide Page", { tag: ["@marketing", "@home"] }, async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  // Landing grid -> shipping-labels marketing page.
  await page.getByRole("button", { name: /Shipping Labels/ }).click();
  await expect(page.getByText("Print the Label, Ship the Card")).toBeVisible();

  // The postage section's guide link leads to the setup guide.
  await page.getByRole("link", { name: /Follow the EasyPost setup guide/ }).click();

  // The guide: hero, the four steps in order, and the trust section.
  await expect(page.getByText("Get Your EasyPost Key")).toBeVisible();
  await expect(page.getByText("Four Steps, One Time")).toBeVisible();
  await expect(page.getByText("Create a free EasyPost account")).toBeVisible();
  await expect(page.getByText("Add a payment method")).toBeVisible();
  await expect(page.getByText("Copy your Production API key")).toBeVisible();
  await expect(page.getByText("Paste it into Neon Binder")).toBeVisible();
  await expect(page.getByText("Good To Know")).toBeVisible();
  // Heading outline: h1, each section an h2, its steps and notes h3 (they were h4).
  await expect(page.getByRole("heading", { level: 1, name: "Get Your EasyPost Key" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Four Steps, One Time" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Create a free EasyPost account" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Your Money Stays Yours" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4 })).toHaveCount(0);
  await expectAccessible(page, { label: "easypost-setup feature page" });

  await page.getByRole("button", { name: "Get Started" }).click();
  const signUp = page.getByText("Create your account");
  await expect(signUp).toBeVisible();
  await dismissSignUp(page, isMobile);
  await expect(signUp).toBeHidden();
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
