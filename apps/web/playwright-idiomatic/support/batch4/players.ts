/** admin/util-add-player-by-hand.yaml: add a player on /admin/players under a chosen sport. */
import { expect, type Page } from "@playwright/test";

export async function addPlayerByHand(page: Page, name: string, sport: string): Promise<void> {
  // Empty the list with a filter nothing matches, then pick the list's sport
  // so the add form opens with it already chosen.
  await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
  await expect(page.getByText("No players match that filter.")).toBeVisible();
  const sportPicker = page.getByRole("combobox", { name: "Sport", exact: true });
  await sportPicker.selectOption(sport);
  await expect(sportPicker.getByRole("option", { selected: true })).toHaveText(sport);
  await expect(page.getByText("0 matches", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add player" }).click();
  await expect(page.getByText("Add a player")).toBeVisible();
  await page.getByRole("textbox", { name: "New player name" }).fill(name);
  await page.getByRole("button", { name: `Create player ${name}` }).click();

  // The detail panel replaces the form: heading, "Added" confirmation, sport read back.
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText(`Added ${name}`)).toBeVisible();
  await expect(page.getByText(`Sport: ${sport}`)).toBeVisible();
}
