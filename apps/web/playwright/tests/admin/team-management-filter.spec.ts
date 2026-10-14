// Origin: .maestro/flows/admin/team-management-filter.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectTeamsLoaded, teamsCounter } from "../../support/players";

test(
  "Team Management — filtering to a name nothing matches reports no matches",
  { tag: ["@smoke", "@admin"] },
  async ({ page, signIn }) => {
    await signIn("/admin/teams");
    await expect(page.getByText("Team Management", { exact: true })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    // NEO-330: the unfiltered "{N} teams" counter belongs to the loaded screen alone.
    await expectTeamsLoaded(page);
    const noSelection = page.getByText("Select a team to see and edit everything we know about it.");
    await expect(noSelection).toBeVisible();
    await expectAccessible(page, { label: "Team Management" });

    const filter = page.getByRole("textbox", { name: "Filter teams" });
    await filter.fill("zzzznotateam");
    await expect(filter).toHaveValue("zzzznotateam");

    await expect(page.getByText("No teams match that filter.")).toBeVisible();
    // With a filter typed the counter reads "{N} matches", so "0 matches" can only
    // mean the filter was applied (unfiltered it would read "{N} teams").
    await expect(teamsCounter(page, "0 matches")).toBeVisible();
    await expect(noSelection).toBeVisible();
    await expectAccessible(page, { label: "Team Management, no matches" });
  },
);
