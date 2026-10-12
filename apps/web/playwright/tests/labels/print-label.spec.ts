// Origin: .maestro/flows/labels/print-label.yaml (Maestro suite retired in NEO-341; see git history)
// Dedicated `new-profile` account, reset on the way in: no return address yet.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Shipping Labels — type a recipient and the label preview follows",
  { tag: ["@smoke", "@labels"] },
  async ({ page, signIn }) => {
    await signIn("/testing/reset?redirect=/profile/shipping", { account: "new-profile" });
    await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await expect(page.getByText("Your return address for printed shipping labels")).toBeVisible({
      timeout: 10_000,
    });

    // Save the return address on the profile.
    await page.getByLabel("Name", { exact: true }).fill("Neon Seller");
    await page.getByLabel("Street Address").fill("100 Binder Way");
    await page.getByLabel("City").fill("Austin");
    await page.getByLabel("State").fill("TX");
    await page.getByLabel("ZIP").fill("78701");
    await page.getByRole("button", { name: "Save Return Address" }).click();
    await expect(page.getByText("Return address saved.")).toBeVisible();

    // The Print Shop form now offers a label.
    await page.goto("/print/shipping");
    await expect(page.getByRole("heading", { name: "Shipping Labels" })).toBeVisible();
    await expect(page.getByText("Ship To", { exact: true })).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("Jane Buyer");
    await page.getByLabel("Street Address").fill("742 Evergreen Ter");
    await page.getByLabel("City").fill("Springfield");
    await page.getByLabel("State").fill("IL");
    await page.getByLabel("ZIP").fill("62704");
    await expect(page.getByRole("button", { name: "Print Label" })).toBeVisible();

    // The preview follows what was typed: buyer's line, and the saved return address.
    await expect(page.getByText("SPRINGFIELD IL 62704")).toBeVisible();
    await expect(page.getByText("AUSTIN TX 78701")).toBeVisible();
  },
);
