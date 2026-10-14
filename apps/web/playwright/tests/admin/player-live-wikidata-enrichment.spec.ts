// Origin: .maestro/flows/admin/player-live-wikidata-enrichment.yaml (Maestro suite retired in NEO-341; see git history)
// The one LIVE proof of Wikidata enrichment (the seed answers from a
// recording). Fresh-only by design: re-running against the same preview finds
// the player the last run created, and the form offers "Open …" instead of
// "Create player …". Re-seed before re-running.
//
// The name (NEO-330): every CI preview loads prod's reference catalogue right
// after the reset, so "the reset clears players" no longer makes a name new.
// "Vladislav Tretiak" (CSKA Moscow / USSR, retired 1984, HoF 1989; Jason's
// pick, 2026-10-10) meets four constraints: (1) NOT in the catalogue, whose
// Hockey players are NHL-only (checked read-only against the preview's
// players and playerAliases, key "tretiak vladislav"; re-check after every
// bundle refresh), because a catalogue row would demote `Create player <name>`
// to `Open <name>`; (2) NOT in the enrichment recording, which is
// Baseball-only and which enrichmentFixtureFile.test.ts keeps free of this
// name under any sport; (3) NOT created by any other spec (no suite-committed
// checklist can carry a goaltender who retired in 1984); (4) stable on
// Wikidata: one Q5 human with P641 = ice hockey (Q41466), exactly one binding
// under the adapter's SPARQL shape (Q316864 at probe time, not pinned). Close
// names exist in the catalogue but only fill the near-match panel; the primary
// stays `Create player <name>` unless the match is EXACT.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectPlayersLoaded } from "../../support/players";

const PLAYER = "Vladislav Tretiak";
const SPORT = "Hockey";

test(
  "Player Management — a player added by hand is enriched from LIVE Wikidata (the lane the seed no longer exercises)",
  { tag: ["@admin", "@players"] },
  async ({ page, signIn }) => {
    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // Narrow the list to nothing, in Hockey, so the add form opens with
    // that sport preselected.
    await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
    const sport = page.getByRole("combobox", { name: "Sport" });
    await sport.selectOption(SPORT);
    await expect(sport.getByRole("option", { selected: true })).toHaveText(SPORT);
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
    await page.getByRole("textbox", { name: "New player name" }).fill(PLAYER);
    await page.getByRole("button", { name: `Create player ${PLAYER}` }).click();

    // The new row opens in the detail panel.
    await expect(page.getByRole("heading", { name: PLAYER, exact: true })).toBeVisible();
    await expect(page.getByText(`Added ${PLAYER}`)).toBeVisible();
    await expect(page.getByText(`Sport: ${SPORT}`)).toBeVisible();

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
