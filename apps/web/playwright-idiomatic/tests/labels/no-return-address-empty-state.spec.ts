// Spec: .maestro/flows/labels/no-return-address-empty-state.yaml
// Self-contained: the isolated `new-profile` account is reset on the way in,
// which deletes its userProfiles row, so no return address exists.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Shipping Labels — no return address empty state",
  { tag: ["@labels"] },
  async ({ page, signIn }) => {
    await signIn("/testing/reset?redirect=/print/shipping", { account: "new-profile" });

    // Identifies the empty-state branch: the heading below renders in both.
    await expect(page.getByText(/Add your return address on your profile first/)).toBeVisible({
      timeout: LAUNCH_GATE,
    });

    await expect(page.getByRole("heading", { name: "Shipping Labels" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go to Profile" })).toBeVisible();

    // No half-usable label form is offered.
    await expect(page.getByText("Ship To", { exact: true })).toBeHidden();
  },
);
