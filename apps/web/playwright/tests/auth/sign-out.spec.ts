// Origin: .maestro/flows/auth/sign-out.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Sign Out", { tag: ["@auth"] }, async ({ page, signIn, isMobile }) => {
  await signIn("/dashboard");
  if (isMobile) {
    // Below 640 px the header's "Sign out" button is hidden; signing out is
    // the account menu's item.
    const menu = page.getByRole("button", { name: "Open user button" });
    await expect(menu).toBeVisible({ timeout: LAUNCH_GATE });
    await menu.click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
  } else {
    const signOut = page.getByRole("button", { name: "Sign out" });
    await expect(signOut).toBeVisible({ timeout: LAUNCH_GATE });
    await signOut.click();
  }
  await expect(page.getByText("Get Started").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  await expectAccessible(page, { label: "Landing page, signed out" });
});
