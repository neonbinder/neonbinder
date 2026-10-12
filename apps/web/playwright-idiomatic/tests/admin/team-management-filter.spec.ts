// Spec: .maestro/flows/admin/team-management-filter.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Team Management — filtering to a name nothing matches reports no matches",
  { tag: ["@smoke", "@admin"] },
  async ({ page, signIn }) => {
    await signIn("/admin/teams");
    await expect(page.getByText("Team Management", { exact: true })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await expect(page.getByText(/of .* teams/)).toBeVisible();
    const noSelection = page.getByText("Select a team to see and edit everything we know about it.");
    await expect(noSelection).toBeVisible();

    const filter = page.getByRole("textbox", { name: "Filter teams" });
    await filter.fill("zzzznotateam");
    await expect(filter).toHaveValue("zzzznotateam");

    await expect(page.getByText("No teams match that filter.")).toBeVisible();
    await expect(page.getByText(/^0 of .* teams/)).toBeVisible();
    await expect(noSelection).toBeVisible();
  },
);
