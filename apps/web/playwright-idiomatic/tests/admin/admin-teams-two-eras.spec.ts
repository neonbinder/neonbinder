// Spec: .maestro/flows/admin/admin-teams-two-eras.yaml
// One location + nickname can be two teams when their eras differ; the second
// is created only after the operator confirms ("Create again").
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand, expectPlayersLoaded } from "../../support/batch1/players";

test(
  "Teams — one location and nickname can be two teams when their eras differ, and the second is only created once the operator confirms it",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN;
    const player = `Erp${token}`;
    const nickname = `Era${token}`;
    const location = `Loc${token}`;
    const fullName = `${location} ${nickname}`;

    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // A player to hang the teams on.
    await addPlayerByHand(page, player, "Baseball");
    await expect(page.getByText("No stints recorded yet.")).toBeVisible();

    // First team: 1972-1996.
    await page.getByRole("button", { name: "Add team" }).click();
    const search = page.getByRole("textbox", { name: "Search teams" });
    await search.fill(nickname);
    await expect(page.getByText("No matches.")).toBeVisible();
    await search.press("Enter");
    const dialog = page.getByRole("dialog", { name: `New team: ${nickname}` });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("New team location (optional)").fill(location);
    await dialog.getByLabel("New team active from (optional)").fill("1972");
    await dialog.getByLabel("New team active to").fill("1996");
    await dialog.getByRole("button", { name: `Create team ${fullName}` }).click();
    const chip = page.getByRole("button", { name: `Remove team ${fullName}` });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(chip).toBeHidden();

    // Second team: same location + nickname, 2011-present. The first Create is
    // refused with the era of the team that already exists...
    await page.getByRole("button", { name: "Add team" }).click();
    await search.fill(`Zzz${token}`);
    await expect(page.getByText("No matches.")).toBeVisible();
    await search.press("Enter");
    const secondDialog = page.getByRole("dialog", { name: `New team: Zzz${token}` });
    await expect(secondDialog).toBeVisible();
    await secondDialog.getByLabel("New team name").fill(nickname);
    await secondDialog.getByLabel("New team location (optional)").fill(location);
    await secondDialog.getByLabel("New team active from (optional)").fill("2011");
    const create = secondDialog.getByRole("button", { name: `Create team ${fullName}` });
    await create.click();
    await expect(
      page.getByText(/already exists for 1972–1996\. Create again to add this as a second era\./),
    ).toBeVisible();
    // ...and only a second, confirming Create makes the team.
    await create.click();
    await expect(page.getByRole("button", { name: `Remove team ${fullName}` })).toBeVisible();

    // Teams admin: both eras are listed as separate teams.
    await page.goto("/admin/teams");
    await expect(page.getByText(/ of .* teams/)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Filter teams").fill(nickname);
    await expect(page.getByText(/^2 of .* teams/)).toBeVisible();
    const first = page.getByRole("button", { name: /1972–1996/ });
    const second = page.getByRole("button", { name: /2011–present/ });
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();

    await first.click();
    await expect(page.getByRole("spinbutton", { name: "Active from" })).toHaveValue("1972");
    await expect(page.getByRole("spinbutton", { name: "to", exact: true })).toHaveValue("1996");

    await second.click();
    await expect(page.getByRole("spinbutton", { name: "Active from" })).toHaveValue("2011");
    await expect(page.getByRole("spinbutton", { name: "to", exact: true })).toHaveValue("");
  },
);
