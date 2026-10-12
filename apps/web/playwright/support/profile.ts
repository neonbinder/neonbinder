/**
 * Origin: .maestro/flows/profile/util-fill-public-profile.yaml (Maestro suite
 * retired in NEO-341; see git history). Fill and save the public profile
 * (username / display name / tagline + payment handles) on /profile/public.
 * Assumes the page is already open on a fresh (reset) account.
 */
import { expect, type Page } from "@playwright/test";

export async function fillPublicProfile(page: Page, username: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible();

  await page.getByLabel(/^Username/).fill(username);
  await page.getByLabel("Display Name").fill(username);
  await page.getByLabel("Tagline").fill("Buying and Selling all kinds of Sports Cards");

  await page.getByLabel(/PayPal username/).fill(`${username}-pp`);
  await expect(page.getByText(`→ paypal.me/${username}-pp`)).toBeVisible();
  await page.getByLabel(/PayPal email \(Goods & Services\)/).fill(`${username}@example.com`);
  await page.getByLabel(/Venmo username/).fill(`${username}-venmo`);
  await expect(page.getByText(`→ venmo.com/${username}-venmo`)).toBeVisible();
  await page.getByLabel(/Cash App username/).fill(`${username}-cashapp`);
  await expect(page.getByText(`→ cash.app/$${username}-cashapp`)).toBeVisible();

  await page.getByRole("button", { name: "Save Public Profile" }).click();
  await expect(page.getByText(/^Profile saved/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`View your profile at /u/${username}`)).toBeVisible();
}
