// Origin: .maestro/flows/auth/sign-out.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("Sign Out", { tag: ["@auth"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible({ timeout: LAUNCH_GATE });
  await signOut.click();
  await expect(page.getByText("Get Started").first()).toBeVisible();
});
