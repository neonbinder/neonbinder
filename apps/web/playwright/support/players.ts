/**
 * /admin/players helpers. Origin: .maestro/flows/admin/util-add-player-by-hand.yaml
 * (Maestro suite retired in NEO-341; the YAML is in git history).
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The Players list counter (NEO-330: bare counts). Browsing it reads
 * "2,000 players" / "1 player"; with anything in the filter box "12 matches",
 * "1 match", "10+ matches", "0 matches". One element, so no live-region twin.
 */
export const PLAYERS_BROWSING = /^[\d,]+ players?$/;

/** Any filtered count: "12 matches", "1 match", "10+ matches", "0 matches". */
export const PLAYERS_MATCHES = /^[\d,]+\+? match(es)?$/;

export function playersCounter(page: Page, pattern: RegExp | string): Locator {
  return page.getByText(pattern, typeof pattern === "string" ? { exact: true } : undefined);
}

/** The unfiltered counter is on screen, i.e. the list query has answered. */
export async function expectPlayersLoaded(page: Page, timeout?: number): Promise<void> {
  await expect(playersCounter(page, PLAYERS_BROWSING)).toBeVisible({ timeout });
}

/**
 * The Teams list counter (NEO-330): "2,000 teams" browsing, "12 matches" /
 * "50+ matches" filtering, plus " · K need attention" on the visible line when
 * K > 0 (data, so optional here). The visible line is followed in the DOM by
 * an sr-only role=status twin carrying the same sentence WITHOUT the suffix,
 * so a text match resolves to two elements: `.first()` is the visible one.
 */
export const TEAMS_BROWSING = /^[\d,]+ teams?( · [\d,]+ need attention)?$/;

export function teamsCounter(page: Page, sentence: string): Locator {
  return page.getByText(new RegExp(`^${sentence}( · [\\d,]+ need attention)?$`)).first();
}

/** The unfiltered Teams counter is on screen, i.e. the list query has answered. */
export async function expectTeamsLoaded(page: Page, timeout?: number): Promise<void> {
  await expect(page.getByText(TEAMS_BROWSING).first()).toBeVisible({ timeout });
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
 * `otherNames` fills the form's "Other names (optional)" box (comma-separated),
 * so the player is filed with an alias.
 */
export async function addPlayerByHand(
  page: Page,
  name: string,
  sport: string,
  { otherNames }: { otherNames?: string } = {},
): Promise<void> {
  await emptyListAndPickSport(page, sport);
  await page.getByRole("button", { name: "Add player" }).click();
  await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
  await page.getByRole("textbox", { name: "New player name" }).fill(name);
  // NEO-254's "Other names (optional)": a former name the player's cards also use.
  if (otherNames) await page.getByRole("textbox", { name: "Other names (optional)" }).fill(otherNames);
  await page.getByRole("button", { name: `Create player ${name}` }).click();

  // The detail panel replaces the form: heading, the "Added" confirmation and
  // the sport read back (which can also show elsewhere on the page).
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText(`Added ${name}`)).toBeVisible();
  await expect(page.getByText(`Sport: ${sport}`).first()).toBeVisible();
}
