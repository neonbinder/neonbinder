// NEO-463: a NEW one-word player name that is the first or last word of a
// fuller-named player in the same sport is never written silently. The
// operator is asked: pick one of the fuller names, or say it is a genuine
// one-name player.
//   1. Player Management: "Create player W<token>" (the surname of "Devin
//      W<token>") stops on the panel; "Add as a one-name player" creates it.
//   2. The card drawer's player picker: "Create player Devin" (the first name
//      of the same player) stops on the same panel; picking the fuller name
//      puts that player on the card and mints no "Devin" row.
//
// The sport is the worker's own custom sport (support/set-builder.ts
// customSport): it has no Wikidata mapping, so none of these creates reaches
// a lookup (GUIDE "Enrichment fixtures"), and no real player's name can clash.
// Minted names are single tokens (the fuller name is two words, its second
// word the minted token). Nothing here is fresh-only: the token changes every
// attempt, and the one-word name "Devin" is never created.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand } from "../../support/players";
import { setBuilderReady, customSport } from "../../support/set-builder";
import {
  addCustomCard,
  confirmDeleteCardButton,
  deleteCardButton,
  editCardButton,
  escapeRe,
} from "../../support/cards";

test(
  "Player name fragment — a one-word name that is part of a fuller player's name asks the operator, in Player Management and in the card drawer picker",
  { tag: ["@smoke", "@admin"] },
  async ({ page, signIn, env }) => {
    const sport = customSport(env);
    const surname = `W${env.ATTEMPT_TOKEN}`;
    const fuller = `Devin ${surname}`;
    const card = `463-${env.ATTEMPT_ID}`;
    const cardTitle = `FragmentCard${env.ATTEMPT_TOKEN}`;
    const set = { set: `pp-${env.WORKER_INDEX}` };

    // The worker's custom sport exists once a card has been added under it.
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await addCustomCard(page, env, { ...set, cardNumber: card, playerName: cardTitle });

    // 1. Player Management: the fuller name, then its surname alone.
    await page.goto("/admin/players");
    await expect(page.getByText(/^[\d,]+ players?$/)).toBeVisible({ timeout: LAUNCH_GATE });
    await addPlayerByHand(page, fuller, sport);

    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
    await page.getByRole("textbox", { name: "New player name" }).fill(surname);
    await page.getByRole("button", { name: `Create player ${surname}` }).click();

    const panel = page.getByRole("group", { name: new RegExp(`^Just ${escapeRe(surname)}\\?`) });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(`We've got ${fuller}.`);
    await expect(panel.getByRole("button", { name: `Open ${fuller}` })).toBeVisible();
    await expect(page.getByText(`Added ${surname}`)).toBeHidden();
    await expectAccessible(page, { label: "Player Management, one-word name that is part of a fuller name" });

    await panel.getByRole("button", { name: "Add as a one-name player" }).click();
    await expect(page.getByText(`Added ${surname}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: surname, exact: true })).toBeVisible();
    await expect(panel).toBeHidden();

    // 2. The card drawer's picker: the first name alone is refused too. Back
    // steps out of Player Management to the set builder, on the card's list.
    await page.goBack();
    await expect(editCardButton(page, card)).toBeVisible();
    await editCardButton(page, card).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("textbox", { name: "Card name", exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Add player" }).click();
    await page.getByRole("textbox", { name: "Search players" }).fill("Devin");
    await page.getByRole("option", { name: "Create player Devin" }).click();

    const pickerPanel = page.getByRole("group", { name: /^Just Devin\?/ });
    await expect(pickerPanel).toBeVisible();
    // Earlier attempts' "Devin W..." players share the first name, so the
    // sentence may name others (or "and N more"): the choice is the proof.
    await expect(pickerPanel.getByRole("button", { name: `Add ${fuller}` })).toBeVisible();
    await expect(pickerPanel.getByRole("button", { name: "Add as a one-name player" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /^Remove player / })).toHaveCount(0);
    await expectAccessible(page, { label: "Card drawer picker, one-word name that is part of a fuller name" });

    await pickerPanel.getByRole("button", { name: `Add ${fuller}` }).click();
    await expect(drawer.getByRole("button", { name: `Remove player ${fuller}` })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Remove player Devin", exact: true })).toHaveCount(0);
    // NEO-531: the chip is optimistic; wait for the server-confirmed save before leaving, or the goto below can drop the write.
    await expect(page.getByText(/Saved Players/)).toBeVisible();
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(drawer.getByRole("textbox", { name: "Card name", exact: true })).toBeHidden();

    // The card is on the fuller player's own row, and "Devin" was never made.
    await page.goto("/admin/players");
    await expect(page.getByText(/^[\d,]+ players?$/)).toBeVisible();
    await page.getByRole("combobox", { name: "Sport", exact: true }).selectOption({ label: sport });
    await page.getByRole("textbox", { name: "Filter players" }).fill("Devin");
    // Rows read "<name> <sport> ...". Earlier attempts' "Devin W..." rows are
    // on the list too, so a made "Devin" is the row whose name ends at the sport.
    const hisRow = page.getByRole("main").getByRole("button", { name: new RegExp(`^${escapeRe(fuller)}\\s*${escapeRe(sport)}`) });
    const bareDevin = page.getByRole("main").getByRole("button", { name: new RegExp(`^Devin\\s*${escapeRe(sport)}`) });
    await expect(hisRow).toHaveCount(1);
    await expect(bareDevin).toHaveCount(0);
    await hisRow.click();
    await expect(
      page.getByLabel(`Cards for ${fuller}`, { exact: true }).getByText(`#${card}`),
    ).toBeVisible();

    // Clean up the card (players have no delete affordance).
    await page.goBack();
    await deleteCardButton(page, card).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, card).click();
    await expect(editCardButton(page, card)).toBeHidden();
  },
);
