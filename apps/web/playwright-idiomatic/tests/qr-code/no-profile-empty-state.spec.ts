// Spec: .maestro/flows/qr-code/no-profile-empty-state.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("QR Code — no profile empty state", { tag: ["@smoke", "@qr-code"] }, async ({ page, signIn }) => {
  await signIn("/testing/reset?redirect=/print/qr", { account: "new-profile" });
  await expect(
    page.getByText("Set up your public profile first to generate sale QR codes."),
  ).toBeVisible({ timeout: LAUNCH_GATE });
  await expect(page.getByRole("link", { name: "Go to Profile" })).toBeVisible();
});
