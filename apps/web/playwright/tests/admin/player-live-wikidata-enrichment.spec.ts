// Origin: .maestro/flows/admin/player-live-wikidata-enrichment.yaml (Maestro suite retired in NEO-341; see git history)
// The one LIVE proof of Wikidata enrichment (the seed answers from a
// recording). Fresh-only by design: re-running against the same preview finds
// the player the last run created, and the form offers "Open …" instead of
// "Create player …". Re-seed before re-running.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const PLAYER = "Harmon Killebrew";

test(
  "Player Management — a player added by hand is enriched from LIVE Wikidata (the lane the seed no longer exercises)",
  { tag: ["@admin", "@players"] },
  async ({ page, signIn }) => {
    await signIn("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: LAUNCH_GATE });

    // Narrow the list to nothing, in Baseball, so the add form opens with
    // that sport preselected.
    await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
    const sport = page.getByRole("combobox", { name: "Sport" });
    await sport.selectOption("Baseball");
    await expect(sport.getByRole("option", { selected: true })).toHaveText("Baseball");
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
    await page.getByRole("textbox", { name: "New player name" }).fill(PLAYER);
    await page.getByRole("button", { name: `Create player ${PLAYER}` }).click();

    // The new row opens in the detail panel.
    await expect(page.getByRole("heading", { name: PLAYER, exact: true })).toBeVisible();
    await expect(page.getByText(`Added ${PLAYER}`)).toBeVisible();
    await expect(page.getByText(/Sport: Baseball/)).toBeVisible();

    // R5 exception signed off at the flow's site (NEO-289): a live Wikidata
    // round trip through the pool's retry ladder, the flow's 600 s.
    // The link's name carries an sr-only "(opens in new tab)", so match the
    // start of it, not the whole.
    await expect(page.getByRole("link", { name: /^Wikidata Q[0-9]+/ })).toBeVisible({
      timeout: 600_000,
    });
    await expectAccessible(page, { label: "Player Management, enriched player panel" });
  },
);
