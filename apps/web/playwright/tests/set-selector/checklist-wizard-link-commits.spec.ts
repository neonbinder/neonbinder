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
import { advanceToSave, fetchOneMarketplaceSetChecklistToWizard, readBackDecision, reviewWizard, stepCounter, walkToPlayerRow } from "../../support/wizard";

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
    // Nothing decided: on a name step x is the decided count plus one (NEO-335).
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);

    // Row 1: link to an existing player by search.
    await walkToPlayerRow(page);
    await wizard.getByRole("button", { name: "Link to existing instead" }).click();
    await wizard.getByRole("textbox", { name: "Search existing players" }).fill("Gretzky");
    const linkGretzky = wizard.getByRole("option", { name: "Link to Wayne Gretzky" });
    await expect(linkGretzky).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, link search results" });
    await linkGretzky.click();
    // Read back off the row the link was made on (its "Already decided:" panel),
    // never off the "Decided (N)" history: batch-ordered and collapsed past five.
    // `resume` hands the walk back its own rule before the next walk.
    await readBackDecision(page, "Linked to Wayne Gretzky", { resume: true });

    // Row 2: change the sport this name belongs to, Hockey -> Football.
    await walkToPlayerRow(page);
    const sportHockey = wizard.getByRole("button", { name: "Sport for this name: Hockey" });
    await expect(sportHockey).toBeVisible();
    await sportHockey.click();
    const chooser = wizard.getByRole("listbox", { name: "Choose a sport" });
    await expect(chooser).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, sport chooser open" });
    await chooser.getByRole("option", { name: "Football" }).click();
    // The pick closes the sport list. NOT "Sport for this name: Football" yet:
    // the switch re-queues the row's lookup, and a lookup that stages career
    // teams makes the row wait on them, so the walk can leave it for its own
    // steps within a second or two and bring it back afterwards (the row carries
    // an edit, so the walk returns to it). The label is asserted after the walk
    // below, where it also proves the typeahead and the pick.
    await expect(chooser).toBeHidden();

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
    // Past the names the wizard may ask about teamless cards and card titles
    // (NEO-335); this spec's feature is the link, so those stay on their
    // defaults and the walk goes to the Save step.
    await advanceToSave(page);
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
