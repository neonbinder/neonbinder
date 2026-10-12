/**
 * /admin/players helpers shared by batch 1 specs.
 *
 * `addPlayerByHand` is util-add-player-by-hand.yaml: add a player on
 * /admin/players under a chosen sport, ending with the new player's detail
 * panel open on their row.
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
  await page.getByLabel("Filter players").fill("zzzznotaplayer");
  await expect(page.getByText("No players match that filter.")).toBeVisible();
  await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
  await page.getByLabel("Sport", { exact: true }).selectOption({ label: sport });
  await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
}

export async function addPlayerByHand(page: Page, name: string, sport: string): Promise<void> {
  await emptyListAndPickSport(page, sport);
  await page.getByRole("button", { name: "Add player" }).click();
  await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
  await page.getByLabel("New player name").fill(name);
  await page.getByRole("button", { name: `Create player ${name}` }).click();

  // The detail panel replaces the form: heading, the "Added" confirmation and
  // the sport read back.
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(`Added ${name}`)).toBeVisible();
  await expect(page.getByText(`Sport: ${sport}`)).toBeVisible();
}
