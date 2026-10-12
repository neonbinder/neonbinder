// Origin: .maestro/flows/auth/sign-in.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Sign In", { tag: ["@smoke", "@auth"] }, async ({ page, signIn, isMobile }) => {
  await signIn("/dashboard");

  // Gate on the signed-in account control, not the header: the "Neon Binder"
  // header also renders on the signed-out landing page, so it would prove
  // nothing about sign-in. The "Sign out" button is hidden below 640 px, where
  // the account menu (Clerk's user button) is the signed-in control.
  const signedIn = isMobile
    ? page.getByRole("button", { name: "Open user button" })
    : page.getByRole("button", { name: "Sign out" });
  await expect(signedIn).toBeVisible({ timeout: LAUNCH_GATE });
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();
  await expectAccessible(page, { label: "Dashboard, signed in" });
});
