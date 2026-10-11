// Spec: .maestro/flows/dashboard/view-collection.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("View Collection (Dashboard)", { tag: ["@smoke", "@dashboard"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");

  // Gate on the dashboard's own content, not the header (which also renders
  // on the signed-out landing page).
  await expect(page.getByText("COMING SOON")).toBeVisible({ timeout: LAUNCH_GATE });
  await expect(page.getByRole("banner").getByText("Neon Binder", { exact: true })).toBeVisible();
});
