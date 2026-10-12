// Origin: .maestro/flows/admin/admin-section-navigation.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test("Admin — the hub and its Set Builder / Teams sub-tabs", { tag: ["@smoke", "@admin"] }, async ({ page, signIn }) => {
  await signIn("/admin");
  await expect(page.getByText(/Build set parameters from marketplace data/)).toBeVisible({
    timeout: LAUNCH_GATE,
  });

  // The hub's Teams card leads to Team Management.
  await page.getByRole("link", { name: /Resolve team colors, confirm ambiguous matches/ }).click();
  await expect(page.getByRole("heading", { name: "Team Management" })).toBeVisible();

  // The sub-tabs switch sections without bouncing through the hub.
  await page.getByRole("link", { name: "Set Builder" }).click();
  await expect(page.getByText(/Build set parameters using marketplace APIs/)).toBeVisible();
  await expect(page.getByText("Admin Tools")).toBeHidden();

  await page.getByRole("link", { name: "Teams", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Team Management" })).toBeVisible();
});
