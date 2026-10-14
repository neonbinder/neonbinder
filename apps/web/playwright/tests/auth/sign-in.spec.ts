// Origin: .maestro/flows/auth/sign-in.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Sign In", { tag: ["@smoke", "@auth"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");

  // Gate on the signed-in account control, not the header: the "Neon Binder"
  // header also renders on the signed-out landing page, so it would prove
  // nothing about sign-in. The header's "Sign out" button is on screen at
  // phone width too (the snapshot shows it beside "Open user menu").
  const signedIn = page.getByRole("button", { name: "Sign out" });
  await expect(signedIn).toBeVisible({ timeout: LAUNCH_GATE });
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();
  await expectAccessible(page, { label: "Dashboard, signed in" });
});
