// Origin: .maestro/flows/admin/admin-players-same-name-birth-year.yaml (Maestro suite retired in NEO-341; see git history)
// players.createByAdmin -> adoptOrForkOnCreate, driven through the add form:
//   no birth year, one row on file        -> ADOPT ("already exists")
//   a birth year no row on file carries   -> FORK  ("Added <name>.")
//   a birth year exactly one row carries  -> ADOPT
// The name is one search token (no hyphens): players.search tokenizes.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Player Management — a birth year is bounded, shows on the row, and is what lets a repeated name become a genuinely second player",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const name = `Samename${env.ATTEMPT_TOKEN}`;
    await signIn("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: LAUNCH_GATE });

    // Empty the list, so "Baseball" belongs to the sport picker alone; pick the
    // sport with the add form closed.
    const filter = page.getByRole("textbox", { name: "Filter players" });
    await filter.fill("zzzznotaplayer");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption("Baseball");

    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByText("Add a player")).toBeVisible();
    await expectAccessible(page, { label: "Player Management, add form" });
    const newName = page.getByLabel("New player name");
    const birthYear = page.getByLabel(/^Birth year \(optional\)/);
    const created = page.getByText(new RegExp(`Added ${name}`));

    // (a) A year out of bounds is refused: the form stays open holding the
    // typed name, and "Added ..." is never said.
    await newName.fill(name);
    await birthYear.fill("1700");
    await expect(page.getByText(/Use a whole year between 1850 and 2\d{3}\./)).toBeVisible();
    await expect(page.getByRole("button", { name: `Create player ${name}` })).toBeDisabled();
    await expect(page.getByText("Add a player")).toBeVisible();
    await expect(newName).toHaveValue(name);
    await expect(created).toBeHidden();

    // (b) A valid year lets the same create through; "Added" is said only for
    // an INSERTED row.
    await birthYear.fill("1960");
    await expect(
      page.getByText("Tells this player apart from anyone else with the same name."),
    ).toBeVisible();
    await page.getByRole("button", { name: `Create player ${name}` }).click();
    await expect(created).toBeVisible();

    // (c) The year is stored: a fresh search re-reads the row.
    await filter.fill(name);
    await expect(page.getByText("1 matches", { exact: true })).toBeVisible();
    const list = page.getByRole("main");
    await expect(list.getByText(/b\. 1960/)).toBeVisible();

    // (d)+(e) Repeating the name demotes creation to "Create anyway"; with no
    // year it ADOPTS the player already on file.
    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByText("Add a player")).toBeVisible();
    await newName.fill(name);
    await page.getByRole("button", { name: `Create player ${name} anyway` }).click();
    await expect(page.getByText("That player already exists — opened it.")).toBeVisible();
    await expect(page.getByText("1 matches", { exact: true })).toBeVisible();
    await expect(list.getByText(/b\. 1960/)).toBeVisible();

    // (f) "Create anyway" with a year nobody carries FORKS a second player.
    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByText("Add a player")).toBeVisible();
    await newName.fill(name);
    await birthYear.fill("1975");
    await page.getByRole("button", { name: `Create player ${name} anyway` }).click();
    await expect(created).toBeVisible();
    await expect(page.getByText("2 matches", { exact: true })).toBeVisible();
    await expect(list.getByText(/b\. 1960/)).toBeVisible();
    await expect(list.getByText(/b\. 1975/)).toBeVisible();
  },
);
