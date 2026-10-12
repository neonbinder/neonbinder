// Origin: .maestro/flows/labels/get-postage-rate.yaml (Maestro suite retired in NEO-341; see git history)
// The "new-profile" account is reset and handed a sandbox EasyPost key; the
// flow saves a return address, then prices a letter before buying it.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("Shipping Labels — price a letter before buying it", { tag: ["@postage"] }, async ({ page, signIn }) => {
  await signIn("/testing/reset?redirect=/testing/seed-credentials?redirect=/profile/shipping", {
    account: "new-profile",
  });
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: LAUNCH_GATE,
  });
  await expect(page.getByText("Your return address for printed shipping labels")).toBeVisible({
    timeout: 10_000,
  });

  // Save the return address.
  await page.getByLabel("Name", { exact: true }).fill("Neon Seller");
  await page.getByLabel("Street Address").fill("100 Binder Way");
  await page.getByLabel("City").fill("Austin");
  await page.getByLabel("State").fill("TX");
  await page.getByLabel("ZIP").fill("78701");
  await page.getByRole("button", { name: "Save Return Address" }).click();
  await expect(page.getByText("Return address saved.")).toBeVisible();

  // The seeded sandbox key is on file.
  await page.goto("/profile/postage");
  await expect(page.getByText("EasyPost key saved.")).toBeVisible({ timeout: 30_000 });

  // Address a letter...
  await page.goto("/print/shipping");
  await expect(page.getByRole("heading", { name: "Ship To" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Dana Reyes");
  await page.getByLabel("Street Address").fill("1600 Pennsylvania Ave NW");
  await page.getByLabel("City").fill("Washington");
  await page.getByLabel("State").fill("DC");
  await page.getByLabel("ZIP").fill("20500");

  // ...and see the price before buying.
  await expect(page.getByText("1 oz")).toBeVisible();
  await expect(page.getByRole("button", { name: "Print Label" })).toBeVisible();
  await expect(page.getByText(/\$0\.\d\d/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Buy postage — \$0\.\d\d/ })).toBeVisible();
});
