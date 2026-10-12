/**
 * /admin/players helpers. Origin: .maestro/flows/admin/util-add-player-by-hand.yaml
 * (Maestro suite retired in NEO-341; the YAML is in git history).
 */
import { expect, type Page } from "@playwright/test";

/** The list counter, e.g. "123 of 4,567 players" or "0 matches". */
export async function expectPlayersLoaded(page: Page, timeout?: number): Promise<void> {
  await expect(page.getByText(/ of .* players/)).toBeVisible({ timeout });
}

/**
 * Empty the list with a filter nothing can match, then choose the list's
 * sport. Done on the LIST's picker while the add form is closed, so the form
 * opens with this sport already chosen.
 */
export async function emptyListAndPickSport(page: Page, sport: string): Promise<void> {
  await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
  await expect(page.getByText("No players match that filter.")).toBeVisible();
  await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
  const sportPicker = page.getByRole("combobox", { name: "Sport", exact: true });
  await sportPicker.selectOption({ label: sport });
  await expect(sportPicker.getByRole("option", { selected: true })).toHaveText(sport);
  await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
}

/**
 * util-add-player-by-hand.yaml: on /admin/players (already loaded), add a
 * player under `sport`, ending with the new player's detail panel open.
 */
export async function addPlayerByHand(page: Page, name: string, sport: string): Promise<void> {
  await emptyListAndPickSport(page, sport);
  await page.getByRole("button", { name: "Add player" }).click();
  await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
  await page.getByRole("textbox", { name: "New player name" }).fill(name);
  await page.getByRole("button", { name: `Create player ${name}` }).click();

  // The detail panel replaces the form: heading, the "Added" confirmation and
  // the sport read back (which can also show elsewhere on the page).
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText(`Added ${name}`)).toBeVisible();
  await expect(page.getByText(`Sport: ${sport}`).first()).toBeVisible();
}
