// Spec: .maestro/flows/profile/fill-profile-data.yaml
// Dedicated `new-profile` account: reset on the way in, so every field starts empty.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("Fill Profile Data", { tag: ["@profile"] }, async ({ page, signIn, env }) => {
  const u = env.TEST_USERNAME;
  await signIn("/testing/reset?redirect=/profile/public", { account: "new-profile" });
  await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
    timeout: LAUNCH_GATE,
  });

  // Basic Info.
  await expect(page.getByText("Basic Info", { exact: true })).toBeVisible();
  await page.getByLabel(/^Username/).fill(u);
  await page.getByLabel("Display Name").fill(u);
  await page.getByLabel("Tagline").fill("Buying and Selling all kinds of Sports Cards");

  // Marketplace Links.
  await expect(page.getByText("Marketplace Links", { exact: true })).toBeVisible();
  await page.getByLabel("eBay Store URL").fill(`https://www.ebay.com/str/${u}`);
  await page
    .getByLabel("BuySportsCards URL")
    .fill(`https://www.buysportscards.com/Seller/1d8570d204/${u}`);
  await page.getByLabel("Sportlots URL").fill(`https://sportlots.com/dealers/?dealer=${u}`);
  await page.getByLabel("MySlabs URL").fill("http://myslabs.to/e8c447c0-5917-4326-be26-be2201e36d4a");

  // Payment Handles: each shows the link it will become as it is typed.
  await expect(page.getByText("Payment Handles", { exact: true })).toBeVisible();
  await page.getByLabel(/PayPal username/).fill(`${u}-pp`);
  await expect(page.getByText(`→ paypal.me/${u}-pp`)).toBeVisible();
  await page.getByLabel(/Venmo username/).fill(`${u}-venmo`);
  await expect(page.getByText(`→ venmo.com/${u}-venmo`)).toBeVisible();
  await page.getByLabel(/Cash App username/).fill(`${u}-cashapp`);
  await expect(page.getByText(`→ cash.app/$${u}-cashapp`)).toBeVisible();

  // Social Media.
  await expect(page.getByText("Social Media", { exact: true })).toBeVisible();
  await page.getByLabel("Twitter / X URL").fill(`https://x.com/${u}-twit`);
  await page.getByLabel("Instagram URL").fill(`https://instagram.com/${u}-ig`);
  await page.getByLabel("TikTok URL").fill(`https://tiktok.com/@${u}-tt`);

  await page.getByRole("button", { name: "Save Public Profile" }).click();
  await expect(page.getByText(/^Profile saved/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`View your profile at /u/${u}`)).toBeVisible();

  // The public page shows everything that was entered.
  await page.goto(`/u/${u}`);
  await expect(page.getByText("Buying and Selling all kinds of Sports Cards")).toBeVisible();
  await expect(page.getByRole("heading", { name: u })).toBeVisible();
  await expect(page.getByText(new RegExp(`ebay\\.com/str/${u}`))).toBeVisible();
  await expect(page.getByText(new RegExp(`buysportscards\\.com/Seller/1d8570d204/${u}`))).toBeVisible();
  await expect(page.getByText(new RegExp(`sportlots\\.com/dealers.*${u}`))).toBeVisible();
  await expect(page.getByText(/myslabs\.to\//)).toBeVisible();
  await expect(page.getByText(new RegExp(`paypal\\.me/${u}-pp`))).toBeVisible();
  await expect(page.getByText(new RegExp(`venmo\\.com/${u}-venmo`))).toBeVisible();
  await expect(page.getByText(new RegExp(`cash\\.app.*${u}-cashapp`))).toBeVisible();
  await expect(page.getByText(new RegExp(`x\\.com/${u}-twit`))).toBeVisible();
  await expect(page.getByText(new RegExp(`instagram\\.com/${u}-ig`))).toBeVisible();
  await expect(page.getByText(new RegExp(`tiktok\\.com.*${u}-tt`))).toBeVisible();
});
