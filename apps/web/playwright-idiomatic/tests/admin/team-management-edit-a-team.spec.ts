// Spec: .maestro/flows/admin/team-management-edit-a-team.yaml
// A team is born from the team typeahead on /admin/players (Team Management has
// no "add a team"). Its Location and colour are then typed in Team Management,
// must survive a reload, and the FULL composed name must find the team again in
// the typeahead (so an operator typing "San Diego Padres" never makes a second
// Padres). "Discover" is never pressed: it is a live fetch of a third party.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Team Management — select a team and edit it",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN;
    const player = `TME${token}`;
    const team = `TMT${token}`;
    const location = `Loc${env.WORKER_INDEX}`;
    const fullName = `${location} ${team}`;

    await signIn("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: LAUNCH_GATE });

    // Scaffolding: a player, so there is a career editor to create a team in.
    // Empty the list first so "Baseball" belongs to the sport picker alone.
    await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption("Baseball");
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByText("Add a player")).toBeVisible();
    await page.getByLabel("New player name").fill(player);
    await page.getByRole("button", { name: `Create player ${player}` }).click();
    await expect(page.getByText(new RegExp(`Added ${player}`))).toBeVisible();

    // The team under test, created from the typeahead: nothing matches the
    // name, and Enter opens the New Team dialog seeded with what was typed.
    await page.getByRole("button", { name: "Add team" }).click();
    const search = page.getByRole("textbox", { name: "Search teams" });
    await search.fill(team);
    await expect(page.getByText("No matches.")).toBeVisible();
    await search.press("Enter");
    await expect(page.getByRole("dialog", { name: `New team: ${team}` })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New team name" })).toHaveValue(team);
    await page.getByRole("button", { name: `Create team ${team}` }).click();
    await expect(page.getByRole("button", { name: `Remove team ${team}` })).toBeVisible();

    // Team Management: select the team; it carries a name and nothing else.
    // The master row prints the short name but is labelled with the full one.
    const openTeam = async (name: string, rowLabel: string) => {
      await page.goto("/admin/teams");
      await expect(page.getByText(/of .* teams/)).toBeVisible({ timeout: 30_000 });
      await page.getByRole("textbox", { name: "Filter teams" }).fill(name);
      await expect(page.getByText(/^1 of .* teams/)).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: rowLabel, exact: true }).click();
    };
    await openTeam(team, team);

    const locationBox = page.getByPlaceholder("San Diego");
    const colourBox = page.getByPlaceholder("#01214b");
    await expect(locationBox).toHaveValue("");
    await expect(colourBox).toHaveValue("");
    await locationBox.fill(location);
    await colourBox.fill("#132448");
    await expect(page.getByRole("button", { name: "Discover" })).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(new RegExp(`Saved ${fullName}`))).toBeVisible({ timeout: 15_000 });

    // A full reload and re-selection: the split persisted. The panel heading
    // says the FULL name, the master row answers to it, and the Location box
    // holds only what was typed.
    await openTeam(team, fullName);
    await expect(page.getByRole("heading", { name: fullName })).toBeVisible();
    await expect(locationBox).toHaveValue(location);
    await expect(colourBox).toHaveValue("#132448");

    // Back in the typeahead, the FULL name finds the same team.
    await page.goto("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("textbox", { name: "Filter players" }).fill(player);
    const row = page.getByRole("button", { name: player });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await page.getByRole("button", { name: "Add team" }).click();
    const search2 = page.getByRole("textbox", { name: "Search teams" });
    await search2.fill(fullName);
    await expect(
      page.getByRole("option", { name: new RegExp(`^Add ${fullName}( · .*)?$`) }),
    ).toBeVisible();
    await search2.press("Enter");
    await expect(page.getByRole("button", { name: `Remove team ${fullName}` })).toBeVisible();
  },
);
