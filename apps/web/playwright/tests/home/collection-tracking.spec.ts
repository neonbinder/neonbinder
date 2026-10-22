// Origin: .maestro/flows/home/collection-tracking.yaml (Maestro suite retired in NEO-341; see git history)
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible } from "../../support/fixtures";

test("Collection Tracking Feature Page", { tag: ["@marketing", "@home"] }, async ({ page, isMobile }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();

  // The Collection Tracking card in the landing grid leads to its feature page.
  await page.getByRole("button", { name: /Collection Tracking/ }).click();

  // Four feature sections.
  await expect(page.getByText("Snap & Upload")).toBeVisible();
  await expect(page.getByText("We Find Your Cards")).toBeVisible();
  await expect(page.getByText("Build It Your Way")).toBeVisible();
  await expect(page.getByText("Track Everything")).toBeVisible();
  // Heading outline: h1, each section an h2, its cards h3 (they were h4).
  await expect(page.getByRole("heading", { level: 1, name: "Track Your Collection Like It's 1995" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Snap & Upload" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Quick & Dirty" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Search & Filter" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4 })).toHaveCount(0);
  await expectAccessible(page, { label: "collection-tracking feature page" });

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
