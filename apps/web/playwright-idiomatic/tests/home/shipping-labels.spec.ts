// Spec: .maestro/flows/home/shipping-labels.yaml
import { test, expect } from "../../support/fixtures";

test("Shipping Labels Feature Page", { tag: ["@marketing", "@home"] }, async ({ page }) => {
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

  await page.getByRole("button", { name: "Get Started" }).click();
  const signUp = page.getByText("Create your account");
  await expect(signUp).toBeVisible();
  const size = page.viewportSize()!;
  await page.mouse.click(size.width * 0.05, size.height * 0.5);
  await expect(signUp).toBeHidden();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});
