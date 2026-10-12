// Origin: .maestro/flows/spine-label/player-team-colors-default-to-longest-tenure.yaml (Maestro suite retired in NEO-341; see git history)
// The fixture is built through the product's own admin screens: ONE player with
// a 10-year stint at team A and a 2-year stint at team B, the two teams given
// deliberately different colours. The asymmetry is the whole point: a designer
// that defaulted to the wrong team (or none) fails on the hex.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Spine Labels — a player's colours default to their longest-tenure team",
  { tag: ["@spine-label"] },
  async ({ page, signIn, env }) => {
    // One alphanumeric search token per name (teams.search / players.search
    // tokenize at non-alphanumerics).
    const token = env.ATTEMPT_TOKEN;
    const player = `SLP${token}`;
    const teamA = `SLA${token}`;
    const teamB = `SLB${token}`;

    await signIn("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: LAUNCH_GATE });

    // Filtering to a name nothing matches clears the list, so "Baseball" then
    // belongs to the sport picker alone.
    await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption("Baseball");
    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByText("Add a player")).toBeVisible();
    await page.getByLabel("New player name").fill(player);
    await page.getByRole("button", { name: `Create player ${player}` }).click();
    await expect(page.getByText(new RegExp(`Added ${player}`))).toBeVisible();

    // Career history: a new team from the team typeahead, then its stint.
    const addTeamWithStint = async (team: string, from: string, to: string) => {
      await page.getByRole("button", { name: "Add team" }).click();
      const search = page.getByRole("textbox", { name: "Search teams" });
      await search.fill(team);
      await expect(page.getByText("No matches.")).toBeVisible();
      await search.press("Enter");
      await expect(page.getByRole("dialog", { name: `New team: ${team}` })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "New team name" })).toHaveValue(team);
      await page.getByRole("button", { name: `Create team ${team}` }).click();
      await expect(page.getByRole("button", { name: `Remove team ${team}` })).toBeVisible();

      await page.getByText("Career history", { exact: true }).click();
      await page.getByLabel(/Stint from year/).fill(from);
      await page.getByLabel(/Stint to year/).fill(to);
      await page.getByRole("button", { name: "Add stint" }).click();
      await expect(page.getByText(new RegExp(`${team} · ${from}–${to}`))).toBeVisible();
    };
    await addTeamWithStint(teamA, "2000", "2010");
    await addTeamWithStint(teamB, "2012", "2014");

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(new RegExp(`Saved ${player}`))).toBeVisible({ timeout: 15_000 });

    // A team born from a typeahead has no colour; the spine designer reads
    // teams.colors, so give each team its own primary.
    const colourTeam = async (team: string, hex: string) => {
      await page.goto("/admin/teams");
      await expect(page.getByText(/of .* teams/)).toBeVisible({ timeout: 30_000 });
      await page.getByRole("textbox", { name: "Filter teams" }).fill(team);
      await expect(page.getByText(/^1 of .* teams/)).toBeVisible({ timeout: 15_000 });
      await page.getByText(team, { exact: true }).click();
      await page.getByRole("textbox", { name: /Primary/ }).first().fill(hex);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText(new RegExp(`Saved ${team}`))).toBeVisible({ timeout: 15_000 });
    };
    await colourTeam(teamA, "#132448");
    await colourTeam(teamB, "#002d72");

    // The feature: pick the player and the colours default to the longest tenure.
    await page.goto("/print/spine-label");
    await expect(page.getByRole("heading", { name: "Spine Labels" }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("combobox", { name: "Find a player" }).fill("SLP");
    await page.getByRole("option", { name: player }).click();
    await expect(
      page.getByText(new RegExp(`Defaults to the team ${player} spent longest with`)),
    ).toBeVisible({ timeout: 15_000 });

    // Both career teams surface as chips; the team search is gone.
    const chipA = page.getByRole("button", { name: new RegExp(teamA) });
    const chipB = page.getByRole("button", { name: new RegExp(teamB) });
    await expect(chipA).toBeVisible();
    await expect(chipB).toBeVisible();
    await expect(page.getByText("Find a team")).toBeHidden();

    // Team A's colour is the default; team B's is not on screen.
    const background = page.getByRole("textbox", { name: "Background" });
    await expect(background).toHaveValue("#132448");
    await expect(background).not.toHaveValue("#002d72");

    // Choosing team B's chip switches to its colour.
    await chipB.click();
    await expect(background).toHaveValue("#002d72", { timeout: 10_000 });
  },
);
