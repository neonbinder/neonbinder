// Spec: .maestro/flows/admin/player-management-add-and-career-history.yaml
// Add a player by hand, create a team from the career editor, record two
// stints at ONE team out of order, edit the pending stint with Enter, save,
// reload: both stints survive in year order.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand, expectPlayersLoaded } from "../../support/batch1/players";

test(
  "Player Management — add a player by hand and record two stints at one team",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN;
    const player = `PM${token}`;
    const team = `PMT${token}`;

    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    await addPlayerByHand(page, player, "Baseball");
    await expect(page.getByText("No stints recorded yet.")).toBeVisible();

    // A team nothing matches opens the New Team dialog on Enter.
    await page.getByRole("button", { name: "Add team" }).click();
    const search = page.getByRole("textbox", { name: "Search teams" });
    await search.fill(team);
    await expect(page.getByText("No matches.")).toBeVisible();
    await search.press("Enter");
    const dialog = page.getByRole("dialog", { name: `New team: ${team}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("New team name")).toHaveValue(team);
    await dialog.getByRole("button", { name: `Create team ${team}` }).click();
    await expect(page.getByRole("button", { name: `Remove team ${team}` })).toBeVisible();

    // Stint 1, the LATER one, added first so the ordering assert means something.
    await page.getByRole("heading", { name: "Career history" }).click(); // closes the typeahead
    await page.getByLabel(/Stint from year/).fill("2010");
    await page.getByLabel(/Stint to year/).fill("2012");
    await page.getByRole("button", { name: "Add stint" }).click();
    const later = page.getByRole("link", { name: new RegExp(`${team} · 2010–2012`) });
    await expect(later).toBeVisible();

    // Stint 2 at the SAME team: pick it again, then type the years.
    await page.getByRole("button", { name: "Add team" }).click();
    await page.getByRole("textbox", { name: "Search teams" }).fill(team);
    await page.getByRole("option", { name: new RegExp(`^Add ${team}`) }).click();
    await page.getByRole("heading", { name: "Career history" }).click();

    const toYear = page.getByLabel(/Stint to year/);
    const fromYear = page.getByLabel(/Stint from year/);
    await toYear.fill("2005");
    await toYear.press("Enter");
    // Enter is "Add stint": the end year is recorded, the picked team is consumed,
    // and the form refuses nothing.
    await expect(toYear).toHaveValue("2005");
    await expect(page.getByRole("button", { name: new RegExp(`^Remove team ${team}`) })).toBeVisible();
    await expect(page.getByText("Pick a team and a whole start year.")).toBeHidden();

    await fromYear.fill("2001");
    await fromYear.press("Enter");
    await expect(toYear).toHaveAttribute("placeholder", "present");
    await expect(toYear).toHaveValue("");
    await expect(page.getByRole("button", { name: new RegExp(`^Remove team ${team}`) })).toBeHidden();
    await expect(page.getByText("Pick a team and a whole start year.")).toBeHidden();
    await expect(page.getByText(/already has a stint starting in/)).toBeHidden();

    // Both stints, in YEAR order (2001 first although 2010 was added first).
    const earlier = page.getByRole("link", { name: new RegExp(`${team} · 2001–2005`) });
    await expect(earlier).toBeVisible();
    const stints = page.getByRole("list", { name: "Career history" }).getByRole("listitem");
    await expect(stints).toHaveCount(2);
    await expect(stints.nth(0)).toContainText(`${team} · 2001–2005`);
    await expect(stints.nth(1)).toContainText(`${team} · 2010–2012`);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(new RegExp(`Saved ${player}`))).toBeVisible({ timeout: 15_000 });

    // Reload: both stints survive, still in order.
    await page.goto("/admin/players");
    await expectPlayersLoaded(page, 30_000);
    await page.getByLabel("Filter players").fill(player);
    await expect(page.getByText(/matches/)).toBeVisible();
    await page.getByRole("button", { name: player }).click();
    const reloaded = page.getByRole("list", { name: "Career history" }).getByRole("listitem");
    await expect(reloaded).toHaveCount(2);
    await expect(reloaded.nth(0)).toContainText(`${team} · 2001–2005`);
    await expect(reloaded.nth(1)).toContainText(`${team} · 2010–2012`);
  },
);
