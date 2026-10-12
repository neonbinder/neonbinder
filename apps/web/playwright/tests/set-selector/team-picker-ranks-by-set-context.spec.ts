// Origin: .maestro/flows/set-selector/team-picker-ranks-by-set-context.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-331: on a card in a set, the TeamPicker orders its candidates by the SET
// (the set's League feature and year), not by the alphabet. Four tiers:
//   1. in the set's league AND active in the set's year
//   2. in a league whose level is "minor" AND active in the set's year
//   3. in the set's league but NOT active that year (closed era)
//   4. everything else
// Within a tier: prefix match first, then A-Z.
//
// The fixture is four teams whose A-Z order is the REVERSE of their tier order,
// sharing one prefix that ENDS IN A LETTER (`TPR<token>Q`, so no other
// attempt's longer token can prefix-match and interleave):
//   QZ  Major League Baseball, active from 1958            -> tier 1
//   QY  a new MINOR league (created inline), from 2000    -> tier 2
//   QX  Major League Baseball, 1900-1957                   -> tier 3
//   QW  no league, from 1958                               -> tier 4
// "Major League Baseball" is the seed's row (no sport default since NEO-331,
// so Z and X PICK it; this spec never creates it). Writes NO card: everything
// runs in the quick-add form's picker (chips are local state) and the form is
// cancelled. The set (Baseball > 2024 > Topps > tpr-<worker> > Insert > Base)
// and the minted teams/league stand; per-worker only (SET-REGISTRY.md `tpr-`).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom } from "../../support/set-builder";
import type { Locator, Page } from "@playwright/test";

test(
  "Team picker ranks by the set's league and year — active league teams, then active minor-league teams, then the league's other eras, then the rest (NEO-331)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const P = `TPR${T}Q`;
    const LEAGUE = `TPRLg${T}M`;
    const MLB = "Major League Baseball";

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `tpr-${env.WORKER_INDEX}`,
      variantType: "Insert",
      variant: "Base",
    });

    await page.getByRole("button", { name: "Open add card form" }).click();
    const cardName = page.getByRole("textbox", { name: "Card name", exact: true });
    await expect(cardName).toBeVisible();

    const search = page.getByRole("textbox", { name: "Search teams" });
    const addTeam = page.getByRole("button", { name: "Add team" });
    const chip = (name: string) => page.getByRole("button", { name: `Remove team ${name}` });
    const option = (suffix: string, era: RegExp) =>
      page.getByRole("option", { name: new RegExp(`^Add ${P}${suffix} . ${era.source}$`) });

    /** Create team `P+suffix` through the picker's New Team dialog; `answer` fills Active to / League. */
    async function createTeam(
      suffix: string,
      from: string,
      to: string | null,
      leagueStep: (dialog: Locator) => Promise<void>,
    ) {
      const name = `${P}${suffix}`;
      await addTeam.click();
      await search.fill(name);
      await page.getByRole("button", { name: `New team ${name}`, exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `New team: ${name}` });
      await expect(dialog.getByRole("textbox", { name: "New team name" })).toHaveValue(name);
      await dialog.getByRole("spinbutton", { name: "New team active from (optional)" }).fill(from);
      if (to) await dialog.getByRole("spinbutton", { name: "New team active to" }).fill(to);
      await leagueStep(dialog);
      await dialog.getByRole("button", { name: `Create team ${name}` }).click();
      await expect(chip(name)).toBeVisible();
    }

    async function pickExistingMlb(dialog: Locator) {
      const league = dialog.getByRole("combobox", { name: "League" });
      await league.fill("Major League Baseb");
      await dialog.getByRole("option", { name: new RegExp(`^${MLB}$`) }).click();
      await expect(league).toHaveValue(MLB);
    }

    // Tier 1 (Z): Major League Baseball, active from 1958.
    await createTeam("Z", "1958", null, pickExistingMlb);

    // Tier 2 (Y): a NEW minor league, created inline from the League combobox.
    // Level is required and none is pre-pressed; "Minor" is load-bearing, it is
    // what puts Y in tier 2.
    await createTeam("Y", "2000", null, async (dialog) => {
      const league = dialog.getByRole("combobox", { name: "League" });
      await league.fill(LEAGUE);
      await dialog.getByRole("option", { name: `Create “${LEAGUE}”` }).click();
      await expect(dialog.getByRole("textbox", { name: "New league name" })).toHaveValue(LEAGUE);
      const addLeague = dialog.getByRole("button", { name: "Add league" });
      await expect(addLeague).toBeDisabled();
      await expectAccessible(page, { within: dialog, label: "New team dialog, new league form with no level yet" });
      await dialog.getByRole("radio", { name: "Minor", exact: true }).click();
      await expect(dialog.getByRole("radio", { name: "Minor", exact: true })).toBeChecked();
      await addLeague.click();
      await expect(league).toHaveValue(LEAGUE);
    });

    // Tier 3 (X): Major League Baseball, closed before the set's year.
    await createTeam("X", "1900", "1957", pickExistingMlb);

    // Tier 4 (W): no league.
    await createTeam("W", "1958", null, async (dialog) => {
      const league = dialog.getByRole("combobox", { name: "League" });
      await league.fill("No lea");
      await dialog.getByRole("option", { name: "No league" }).click();
      await expect(league).toHaveValue("No league");
    });

    // Put all four back in the candidate pool (the form's chips are local state).
    await cardName.click();
    for (const s of ["Z", "Y", "X", "W"]) await chip(`${P}${s}`).click();

    /**
     * Search the shared prefix and read the order the rows are listed in. Gated
     * on the LAST-created team's row: any search window that contains the newest
     * row contains all four, so the order is tier-fixed even while the picker
     * still shows held rows. The pointer is never left resting on an option
     * (hover moves the highlight), so the search box is focused first.
     */
    async function listedOrder(expectedLast: string, expected: string[]) {
      await addTeam.click();
      await search.click();
      await search.fill(P);
      await expect(option(expectedLast, /.*/)).toBeVisible();
      const ys: number[] = [];
      for (const s of expected) {
        const box = await option(s, /.*/).boundingBox();
        expect(box, `row ${P}${s} is listed`).not.toBeNull();
        ys.push(box!.y);
      }
      expect([...ys].sort((a, b) => a - b), `rows listed in tier order ${expected.join("")}`).toEqual(ys);
    }

    // Round 1: Z (tier 1), Y (tier 2), X (tier 3), W (tier 4); Enter takes row 0.
    await listedOrder("W", ["Z", "Y", "X", "W"]);
    await expect(option("W", /1958.present/)).toBeVisible();
    await expect(option("Y", /2000.present/)).toBeVisible();
    await expect(option("X", /1900.1957/)).toBeVisible();
    await expectAccessible(page, { label: "Team picker ranked by the set's league and year" });
    await search.press("Enter");
    await expect(chip(`${P}Z`)).toBeVisible();

    // Round 2: with Z taken, Y leads.
    await listedOrder("W", ["Y", "X", "W"]);
    await search.press("Enter");
    await expect(chip(`${P}Y`)).toBeVisible();

    // Round 3: X leads W.
    await listedOrder("W", ["X", "W"]);
    await search.press("Enter");
    await expect(chip(`${P}X`)).toBeVisible();

    // Round 4: W is the last.
    await listedOrder("W", ["W"]);
    await search.press("Enter");
    await expect(chip(`${P}W`)).toBeVisible();

    // Leave without writing a card.
    await cardName.click();
    await page.getByRole("button", { name: "Cancel new card" }).click();
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
  },
);
