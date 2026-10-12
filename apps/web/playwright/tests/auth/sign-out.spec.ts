// Origin: .maestro/flows/auth/sign-out.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Sign Out", { tag: ["@auth"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");
  // The header's "Sign out" button is on screen at phone width too.
  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible({ timeout: LAUNCH_GATE });
  await signOut.click();
  await expect(page.getByText("Get Started").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  await expectAccessible(page, { label: "Landing page, signed out" });
});
