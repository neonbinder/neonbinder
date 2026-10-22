// R1: the Prize Pool tab renders its coming-soon state while the
// "prize-images-enabled" feature flag is off, and the screen is accessible.
//
// Why only this state: the prize form (its two image inputs and the "Remove
// sports image N" buttons) renders only when PostHog evaluates that flag, and
// PostHogProvider never initialises under E2E (VITE_CLERK_TESTING_ENABLED), so
// the flag is always off here and the form cannot be reached by a user in this
// suite. Reported as a product/harness gap, not worked around. Read-only (R7).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Prize Pool tab shows its coming-soon state", { tag: ["@profile"] }, async ({ page, signIn }) => {
  await signIn("/profile/prizes");
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });

  await expect(page.getByRole("link", { name: "Prize Pool" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: "Prize Pool" })).toBeVisible();
  await expect(page.getByText("Coming Soon!")).toBeVisible();
  await expect(page.getByText("Prize pool management with image uploads is coming in a future update.")).toBeVisible();
  await expectAccessible(page, { label: "Profile, Prize Pool tab (coming soon)" });
});
