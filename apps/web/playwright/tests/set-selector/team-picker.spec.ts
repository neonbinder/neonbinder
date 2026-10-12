// Origin: .maestro/flows/set-selector/team-picker.yaml (Maestro suite retired in NEO-341; see git history)
// TeamPicker in the card drawer: create a team from a typed name, remove its
// chip, the "No matches." state, add an existing team with Enter, and every
// change autosaved on the tap (it survives closing and reopening the drawer
// and a fresh load of the set).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom } from "../../support/set-builder";
import { confirmDeleteCardButton, deleteCardButton, editCardButton, openVariant } from "../../support/cards";

test(
  "TeamPicker — chip add, remove, keyboard Enter, 'No matches' state, autosaved on the tap",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const TEAM = `TPT${env.ATTEMPT_TOKEN}`;
    const card = `889-${A}`;
    const player = `Team Feature Player ${A}`;
    const target = {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `tp-${env.WORKER_INDEX}`,
      variantType: "Insert",
    };

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, target);
    await openVariant(page, "Insert", "Base");

    // Add a card to attach teams to.
    await page.getByRole("button", { name: "Open add card form" }).click();
    await page.getByRole("textbox", { name: "Card number" }).fill(card);
    await page.getByRole("textbox", { name: "Card name" }).fill(player);
    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(page.getByText(player)).toBeVisible();

    await editCardButton(page, card).click();
    const drawer = page.getByRole("dialog");
    const cardName = drawer.getByRole("textbox", { name: "Card name" });
    await expect(cardName).toBeVisible({ timeout: 15_000 });

    const addTeam = drawer.getByRole("button", { name: "Add team" });
    const search = page.getByRole("textbox", { name: "Search teams" });
    const removeChip = drawer.getByRole("button", { name: `Remove team ${TEAM}` });
    await expect(drawer.getByLabel("Team picker", { exact: true })).toBeVisible();
    await expect(addTeam).toBeVisible();

    // A typed name that matches nothing offers to create a team.
    await addTeam.click();
    await expect(search).toBeVisible();
    await search.fill(TEAM);
    // Opened with Enter (the highlighted create row), not a click: the popover is
    // fixed under its trigger with no flip or clamp, so a trigger near the fold
    // leaves the row below the viewport ("element is outside of the viewport").
    await expect(page.getByRole("button", { name: `New team ${TEAM}`, exact: true })).toBeVisible();
    await expectAccessible(page, { label: "Team picker open with a create row" });
    await search.press("Enter");
    const newTeam = page.getByRole("dialog", { name: `New team: ${TEAM}` });
    await expect(newTeam).toBeVisible();
    await expect(newTeam.getByRole("textbox", { name: "New team name" })).toHaveValue(TEAM);
    await expectAccessible(page, { within: newTeam, label: "New Team dialog" });
    await newTeam.getByRole("button", { name: `Create team ${TEAM}` }).click();

    // The chip lands (focus returns to the drawer).
    await cardName.click();
    await expect(removeChip).toBeVisible();

    // Remove it.
    await removeChip.click();
    await expect(removeChip).toBeHidden();

    // A name nothing matches says so.
    await addTeam.click();
    await expect(search).toBeVisible();
    await search.fill("ZZZZNOTATEAM");
    await expect(page.getByText("No matches.")).toBeVisible();
    await expectAccessible(page, { label: "Team picker with no matches" });
    await cardName.click();

    // Re-add the (now existing) team with the keyboard.
    await addTeam.click();
    await expect(search).toBeVisible();
    await search.fill(TEAM);
    await expect(page.getByRole("option", { name: new RegExp(`^Add ${TEAM}( · .*)?$`) })).toBeVisible();
    await search.press("Enter");
    await expect(page.getByText(/Saved Teams/)).toBeVisible();
    await cardName.click();
    await expect(removeChip).toBeVisible();

    // Autosaved: survives closing and reopening the drawer.
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
    await editCardButton(page, card).click();
    await expect(cardName).toBeVisible({ timeout: 15_000 });
    await expect(removeChip).toBeVisible();
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(page.getByText(player)).toBeVisible();
    await expect(page.getByText(new RegExp(TEAM)).first()).toBeVisible();

    // ... and a fresh load of the set shows the team on the row.
    await drillToCustom(page, target);
    await openVariant(page, "Insert", "Base");
    await expect(page.getByText(player)).toBeVisible();
    await expect(page.getByText(new RegExp(TEAM)).first()).toBeVisible();

    // Clean up the card.
    await deleteCardButton(page, card).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, card).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
