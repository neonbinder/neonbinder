// Origin: .maestro/flows/set-selector/checklist-wizard-link-commits.yaml (Maestro suite retired in NEO-341; see git history)
// Sole writer of the 1995 San Antonio Iguanas CHL set (SET-REGISTRY.md), BSC
// only; fresh-only (it commits the checklist). Approved by Jason 2026-10-10
// (NEO-330), replacing Topps Brooklyn Collection: the reference catalogue
// knows that set's players, so its wizard no longer opened. MEASURED on PR
// #314's preview: 18 cards, 16 unknown names, all players, 0 teams.
//
// The in-sport link target must share the SET'S sport (the link search is
// scoped to the row's sport), so it is a HOCKEY player from the catalogue:
// Wayne Gretzky. Verified read-only on the preview's catalogue 2026-10-10:
// exactly ONE "Wayne Gretzky", home sport Hockey ("Gretzky" also finds Brent
// Gretzky, a different accessible name). If a bundle refresh drops him or adds
// a second one, change the literals to another single-row Hockey player. The
// cross-sport target is MINTED (the catalogue's Football names would crowd any
// search).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand, expectPlayersLoaded, PLAYERS_MATCHES, playersCounter } from "../../support/players";
import { fetchOneMarketplaceSetChecklistToWizard, openDecidedList, reviewedLine, reviewWizard, walkToPlayerRow } from "../../support/wizard";

test(
  "Entity review — Link to Existing decisions, including one to a player of another sport, are carried through Confirm & Save into the committed checklist",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const gw = `Gw${env.ATTEMPT_TOKEN}`;

    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);
    // A Football player to link a Hockey name to, across sports.
    await addPlayerByHand(page, gw, "Football");

    await fetchOneMarketplaceSetChecklistToWizard(page, env, { set: "San Antonio Iguanas CHL" });
    const wizard = reviewWizard(page);
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);

    // Row 1: link to an existing player by search.
    await walkToPlayerRow(page);
    await wizard.getByRole("button", { name: "Link to existing instead" }).click();
    await wizard.getByRole("textbox", { name: "Search existing players" }).fill("Gretzky");
    const linkGretzky = wizard.getByRole("option", { name: "Link to Wayne Gretzky" });
    await expect(linkGretzky).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, link search results" });
    await linkGretzky.click();
    // The history collapses past five decided names, so open it first. The
    // auto-add of settled rows can push the count past five a moment later and
    // fold an open list shut again (only the operator's own toggle latches it
    // open), so re-open and re-check together until the line is on screen.
    await expect(async () => {
      const decidedNames = await openDecidedList(page);
      await expect(decidedNames.getByText("Linked to Wayne Gretzky")).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 7_000 });

    // Row 2: change the sport this name belongs to, Hockey -> Football.
    await walkToPlayerRow(page);
    const sportHockey = wizard.getByRole("button", { name: "Sport for this name: Hockey" });
    await expect(sportHockey).toBeVisible();
    await sportHockey.click();
    const chooser = wizard.getByRole("listbox", { name: "Choose a sport" });
    await expect(chooser).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, sport chooser open" });
    await chooser.getByRole("option", { name: "Football" }).click();
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeVisible();

    // Row 2 again (still undecided, now Football): link it to the Football player we made.
    await walkToPlayerRow(page);
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeVisible();
    await wizard.getByRole("button", { name: "Link to existing instead" }).click();
    await wizard.getByRole("textbox", { name: "Search existing players" }).fill(gw);
    await wizard.getByRole("option", { name: `Link to ${gw}` }).click();
    // The next row opens on the default sport again.
    await expect(wizard.getByRole("button", { name: "Sport for this name: Football" })).toBeHidden();
    await expect(wizard.getByRole("button", { name: "Sport for this name: Hockey" })).toBeVisible();

    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    await expect(confirmSave).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, summary" });
    await confirmSave.click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible();

    // The cross-sport link is on the player's committed card list.
    await page.goto("/admin/players");
    await expectPlayersLoaded(page, 20_000);
    await page.getByRole("textbox", { name: "Filter players" }).fill(gw);
    await expect(playersCounter(page, PLAYERS_MATCHES)).toBeVisible();
    await page.getByRole("button", { name: gw }).click();
    const cards = page.getByRole("list", { name: `Cards for ${gw}` });
    await expect(cards).toContainText("San Antonio Iguanas CHL");
    // Linked across sports: the card keeps its own sport.
    await expect(cards).toContainText("Hockey");
    await expectAccessible(page, { label: "Player detail with the cross-sport linked card" });
  },
);
