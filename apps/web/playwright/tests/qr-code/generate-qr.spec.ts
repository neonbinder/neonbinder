// Origin: .maestro/flows/qr-code/generate-qr.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { fillPublicProfile } from "../../support/profile";

test("QR Code — generate sale QR", { tag: ["@smoke", "@qr-code"] }, async ({ page, signIn, env }) => {
  await signIn("/testing/reset?redirect=/profile/public", { account: "new-profile" });
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: LAUNCH_GATE,
  });
  await fillPublicProfile(page, env.TEST_USERNAME);

  await page.goto("/print/qr");
  await expect(page.getByText("QR Code Generator")).toBeVisible();
  await page.getByLabel("Sale Amount").fill("8");
  await page.getByRole("button", { name: "Generate QR Code" }).click();

  await expect(page.getByText(new RegExp(`neonbinder\\.io/u/${env.TEST_USERNAME}/sale\\?amt=8`))).toBeVisible();
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print", exact: true })).toBeVisible();
});
