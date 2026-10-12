// Origin: .maestro/flows/home/easypost-setup.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect } from "../../support/fixtures";

test("EasyPost Setup Guide Page", { tag: ["@marketing", "@home"] }, async ({ page }) => {
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

  await page.getByRole("button", { name: "Get Started" }).click();
  const signUp = page.getByText("Create your account");
  await expect(signUp).toBeVisible();
  const size = page.viewportSize()!;
  await page.mouse.click(size.width * 0.05, size.height * 0.5);
  await expect(signUp).toBeHidden();
});
