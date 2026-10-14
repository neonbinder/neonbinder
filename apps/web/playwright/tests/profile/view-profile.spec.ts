// Origin: .maestro/flows/profile/view-profile.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("View Profile", { tag: ["@smoke", "@profile"] }, async ({ page, signIn }) => {
  await signIn("/profile/public");
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: LAUNCH_GATE,
  });
  await expect(page.getByText("Public Profile").first()).toBeVisible();
  await expectAccessible(page, { label: "Profile settings, Public Profile tab" });
});
