// Origin: .maestro/flows/admin/admin-franchises-link-teams.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-254: franchise MEMBERSHIP. Team Management's Franchise type-ahead STARTS
// a thread and puts team A on it, the same field puts team B on the SAME thread
// by picking its option, Franchise Management shows both, and "Remove <team>"
// takes one back off. All names are single search tokens.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectPlayersLoaded, expectTeamsLoaded, teamsCounter } from "../../support/players";

test(
  "Franchises — two team rows are strung onto one franchise from the team side, and taken off again from the franchise side",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN;
    const player = `Frp${token}`;
    const teamA = `Loc${token} Fr${token}A`;
    const teamB = `Loc${token} Fr${token}B`;
    const franchise = `Fran${token}F`;

    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // Scaffolding: a player (empty list first, so "Baseball" is the picker's).
    await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption("Baseball");
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add player" }).click();
    await page.getByLabel("New player name").fill(player);
    await page.getByRole("button", { name: `Create player ${player}` }).click();
    await expect(page.getByText(new RegExp(`Added ${player}`))).toBeVisible();
    await expect(page.getByText("No stints recorded yet.")).toBeVisible();

    // Two brand-new teams from the typeahead, through the New Team dialog.
    const createTeam = async (name: string, locationName: string) => {
      await page.getByRole("button", { name: "Add team" }).click();
      const search = page.getByRole("textbox", { name: "Search teams" });
      await search.fill(name);
      await expect(page.getByText("No matches.")).toBeVisible();
      await search.press("Enter");
      await expect(page.getByRole("dialog", { name: `New team: ${name}` })).toBeVisible();
      await expectAccessible(page, { within: page.getByRole("dialog", { name: `New team: ${name}` }), label: "New Team dialog" });
      await page.getByLabel(/^New team location \(optional\)/).fill(`Loc${token}`);
      await page.getByRole("button", { name: `Create team ${locationName}` }).click();
      await expect(page.getByRole("button", { name: `Remove team ${locationName}` })).toBeVisible();
    };
    await createTeam(`Fr${token}A`, teamA);
    // Unlink A from the player so the editor offers "Add team" again.
    await page.getByRole("button", { name: `Remove team ${teamA}` }).click();
    await createTeam(`Fr${token}B`, teamB);

    // Team Management: both teams are listed.
    await page.goto("/admin/teams");
    await expectTeamsLoaded(page, 30_000);
    await page.getByRole("textbox", { name: "Filter teams" }).fill(`Fr${token}`);
    // NEO-330: the filtered counter reads "2 matches" (no "of N").
    await expect(teamsCounter(page, "2 matches")).toBeVisible();
    await expectAccessible(page, { label: "Team Management" });
    const franchiseField = page.getByRole("combobox", { name: "Franchise" });
    const saved = (team: string) => page.getByText(new RegExp(`Saved ${team}`));

    // Team A: typing a name nothing matches offers `Start "<typed>"`.
    await page.getByRole("button", { name: teamA, exact: true }).click();
    await franchiseField.fill(franchise);
    await page.getByRole("option", { name: new RegExp(`^Start .${franchise}.`) }).click();
    await expect(franchiseField).toHaveValue(franchise);
    await expect(
      page.getByText(`Started the ${franchise} franchise. Save the team to put it on there.`),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(saved(teamA)).toBeVisible();
    await expectAccessible(page, { label: "Team Management, team saved on a franchise" });

    // Team B: the same field puts it on the SAME thread by picking its option.
    await page.getByRole("button", { name: teamB, exact: true }).click();
    await franchiseField.fill(`${token}F`);
    await page.getByRole("option", { name: franchise, exact: true }).click();
    await expect(franchiseField).toHaveValue(franchise);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(saved(teamB)).toBeVisible();

    // Franchise Management shows both teams on the thread.
    await page.getByRole("link", { name: "See the franchise" }).click();
    await expect(page.getByText(/of .* franchises/).first()).toBeVisible();
    await expect(page.getByText(/2 teams on this thread/)).toBeVisible();
    await expect(page.getByText(teamA, { exact: true })).toBeVisible();
    await expect(page.getByText(teamB, { exact: true })).toBeVisible();

    await expectAccessible(page, { label: "Franchise Management, two teams on a thread" });

    // Taken off again from the franchise side.
    await page.getByRole("button", { name: `Remove ${teamB}` }).click();
    await expect(page.getByText(/1 team on this thread/)).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove ${teamA}` })).toBeVisible();
    await expect(page.getByText(teamA, { exact: true })).toBeVisible();
    await expect(page.getByText(teamB, { exact: true })).toBeHidden();
  },
);
