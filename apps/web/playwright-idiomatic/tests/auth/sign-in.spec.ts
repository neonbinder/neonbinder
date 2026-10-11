// Spec: .maestro/flows/auth/sign-in.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("Sign In", { tag: ["@smoke", "@auth"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");

  // Gate on "Sign out", not the header: the "Neon Binder" header also renders
  // on the signed-out landing page, so it would prove nothing about sign-in.
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: LAUNCH_GATE });
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();
});
