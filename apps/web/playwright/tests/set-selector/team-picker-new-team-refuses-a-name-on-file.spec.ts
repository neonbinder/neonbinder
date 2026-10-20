// NEO-339 (R1): the New Team dialog CREATES. A team already on file under the name is refused
// with a sentence and a "Use <team>" button, never silently handed back, and one press on that
// button puts the team on file on the card, so the sport still holds ONE row for the name.
//
// Reachable by hand because the team picker keeps its "New team <name>" row on offer beside the
// existing team's own "Add <name>" option (NEO-254: a sport can hold two eras of one name).
//
// FIXTURE (R7a): the team `RfT<token>`, created through the dialog in-flow (the fixture comes
// from the UI; never deleted: no affordance deletes a team). The set `tpx-<worker>` is a
// hand-made Baseball > 2024 > Topps > Insert > Base set that gives the card form a Baseball
// picker. WRITES NO CARD: the form's chips are local state and the form is cancelled.
// Registered in SET-REGISTRY.md (`tpx-`, `RfT`).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom } from "../../support/set-builder";

test(
  "Team picker — a New team dialog on a name already on file is refused, and \"Use\" puts that team on the card with no second row (NEO-339)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const TEAM = `RfT${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `tpx-${env.WORKER_INDEX}`,
      variantType: "Insert",
      variant: "Base",
    });
    await page.getByRole("button", { name: "Open add card form" }).click();
    const cardName = page.getByRole("textbox", { name: "Card name", exact: true });
    await expect(cardName).toBeVisible();

    const addTeam = page.getByRole("button", { name: "Add team" });
    const search = page.getByRole("textbox", { name: "Search teams" });
    const chip = page.getByRole("button", { name: `Remove team ${TEAM}` });
    const existingRow = page.getByRole("option", { name: new RegExp(`^Add ${TEAM}( · .*)?$`) });
    const newTeamRow = page.getByRole("button", { name: `New team ${TEAM}`, exact: true });
    const dialog = page.getByRole("dialog", { name: `New team: ${TEAM}` });

    // ── The team on file: created through the dialog, then taken off the card again.
    await addTeam.click();
    await search.fill(TEAM);
    await expect(newTeamRow).toBeVisible();
    await newTeamRow.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: `Create team ${TEAM}` }).click();
    await expect(chip).toBeVisible();
    await cardName.click();
    await chip.click();
    await expect(chip).toBeHidden();

    // ── The same name again: the team on file is offered AND so is a new one.
    await addTeam.click();
    await search.fill(TEAM);
    await expect(existingRow).toHaveCount(1);
    await expect(newTeamRow).toBeVisible();
    await newTeamRow.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "New team name" })).toHaveValue(TEAM);
    await dialog.getByRole("button", { name: `Create team ${TEAM}` }).click();

    // ── Refused: the sentence, the team on file offered, still in the dialog, nothing on the card.
    await expect(
      dialog.getByRole("alert").filter({
        hasText: `${TEAM} is already a team in this sport. Use it instead of adding a second one.`,
      }),
    ).toBeVisible();
    const use = dialog.getByRole("button", { name: new RegExp(`^Use ${TEAM}( · .+)?, already on file$`) });
    await expect(use).toBeVisible();
    // Focus lands on the first "Use": taking the team on file is the likely next move.
    await expect(use).toBeFocused();
    // Rides on the positives above (R2): no chip, so the refused create linked nobody.
    await expect(chip).toHaveCount(0);
    await expectAccessible(page, { within: dialog, label: "New Team dialog, create refused with a Use button" });

    // ── One press puts the team on file on the card and closes the dialog.
    await use.click();
    await expect(dialog).toBeHidden();
    await expect(chip).toHaveCount(1);

    // ── The sport still holds ONE row for the name: take it off and search it again.
    await cardName.click();
    await chip.click();
    await expect(chip).toBeHidden();
    await addTeam.click();
    await search.fill(TEAM);
    await expect(existingRow).toHaveCount(1);

    // Leave without writing a card.
    await cardName.click();
    await page.getByRole("button", { name: "Cancel new card" }).click();
    await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
  },
);
