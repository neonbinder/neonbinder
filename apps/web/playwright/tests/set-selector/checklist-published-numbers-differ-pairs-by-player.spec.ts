// NEO-490 (R1): a publisher's checklist whose card numbers match NONE of the
// marketplace's still reaches its cards, by player name. Panini numbers its
// 2026 Donruss "Retro 1997 Donruss Signature Series Autographs" 1-17 and BSC
// numbers the same 14 cards SIG-AM..SIG-RL, so no number meets another. The
// publisher's checklist is Panini's own (fixtures/checklists, SET-REGISTRY.md):
// BSC names a team on none of these cards, so every team on screen comes from
// the checklist.
//
// Two runs of one set, in the order the operator would meet them:
//   PHASE A, the counts differ (13 rows against 14 cards: Mike Lowell's row is
//     left out). The fetch applies nothing by itself; the unique name pairs are
//     SUGGESTED. One marketplace answered, so Match Cards opens in solo mode: no
//     Keep controls, every BSC card saved, the checklist as a column of rows. 13
//     rows come pre-linked, Mike Lowell's card is listed as saved with no row,
//     one row is unlinked and linked again by its buttons, Confirm takes the 13
//     teams to the wizard, and "Cards with no team" lists Mike Lowell ONLY. A
//     Back to Match Cards keeps the links. Nothing is committed: Cancel, Discard.
//   PHASE A2, the counts match but one name is misspelled (14 rows, row 11 reads
//     "Rhett Lowdr"). The fetch pairs the 13 unique names itself and applies them,
//     so those cards are not listed; Rhett Lowder's card and row 11 are the only
//     leftovers, so Match Cards still opens, in solo mode, and says the 13 are
//     saved too. The operator links the one pair by its buttons and Confirms; the
//     two spellings disagree, so the wizard opens on "Checklist says otherwise"
//     and the operator keeps the card's. It asks no "Cards with no team" after
//     that: the 13 cards the dialog never listed still reach the save, with the
//     14th. Nothing is committed: Cancel, Discard.
//   PHASE B, the counts match (14 rows). The fetch pairs every row to its card
//     by player itself: no Match Cards, "Teams from your checklist: 14 of 14
//     cards", no "Cards with no team" step. Panini writes "Oakland A's" for
//     Jacob Wilson; NB holds no club of that name (the checklist's claim is never
//     rewritten, rule 8), so the wizard asks, and the operator links it to the
//     club the checklist means, Oakland Athletics (1968-2024), with the
//     remember-box OFF so no alias is saved. Frank Thomas is two players on file;
//     the Hall of Famer is linked and shown as a decided row. The save reads back:
//     numbers stay SIG-xx, #SIG-BW is Kansas City Royals, #SIG-JW is Oakland
//     Athletics.
//
// The "Teams from your checklist: N of M cards" line is on screen before the
// commit only when no dialog stands between the fetch and the wizard (PHASE B);
// after Match Cards it is said on the line the save lands with, which PHASE A
// never reaches. PHASE A proves its 13 teams by what is NOT asked: only Mike
// Lowell is left teamless.
//
// FIXTURE (SET-REGISTRY.md -> "Baseball -> 2026 -> Donruss"): Baseball > 2026 >
// All Brands > Donruss (brand "Unknown") > Insert > Retro 1997 Donruss Signature
// Series Autographs, BSC only (SportLots is paused). SOLE WRITER of that insert;
// FRESH-ONLY (it commits in PHASE B), so a re-run fails at "No cards in this
// checklist yet." by name: re-seed first. Every player and club but Oakland A's
// is on the catalogue, so no player is minted and no live lookup is waited on.
//
// Not a hand-rolled drill by choice (R9): the helpers drill a Base or a brand's
// set; this set is an INSERT under the year's Unknown brand, reached through the
// pinned All Brands view like the other one-marketplace real sets.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import type { Page } from "@playwright/test";
import { expectAfterMarketplace } from "../../support/marketplace-wait";
import {
  CHECKLISTS,
  nameFallbackFacts,
  publishersChecklistButton,
  publishersChecklistChip,
  usePublishersChecklist,
} from "../../support/published-checklist";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToColdManufacturer,
  INSERT_FETCH,
  setBuilderReady,
  syncChecklistButton,
  VARIANT_TYPES_SYNC,
} from "../../support/set-builder";
import { editCardButton } from "../../support/cards";
import {
  advanceToSave,
  cancelAndDiscard,
  confirmSaveButton,
  expectChecklistDisagreementFirst,
  openDecidedList,
  pickDisagreementSide,
  readBackDecision,
  reviewWizard,
} from "../../support/wizard";

const INSERT = "Retro 1997 Donruss Signature Series Autographs";
const CLUB = "Oakland A's";
const WITHOUT_LOWELL = nameFallbackFacts(CHECKLISTS.signatureSeries2026WithoutLowell, CHECKLISTS.signatureSeries2026);
/** The checklist column's heading: how many rows still wait for a card ("all linked!" when none). */
const yourChecklist = (unlinked: number) => (unlinked === 0 ? "Your checklist (all linked!)" : `Your checklist (${unlinked} to link)`);
const WHOLE = nameFallbackFacts(CHECKLISTS.signatureSeries2026, CHECKLISTS.signatureSeries2026);
const MIXED = nameFallbackFacts(CHECKLISTS.signatureSeries2026MisspelledLowder, CHECKLISTS.signatureSeries2026);

test(
  "Published checklist — rows whose numbers match no card pair to the cards by player name, and the card's own player settles the club",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const wizard = reviewWizard(page);
    const matchCards = page.getByRole("dialog", { name: /^Match Cards/ });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── DRILL: the insert, through All Brands ──
    // The year, the Sets and the Variant Types are warm or sync from BSC on first use; the helper pays
    // those waits. Under paused SportLots the Insert column fills straight from BSC (no reconcile).
    await drillToColdManufacturer(page, env, { sport: "Baseball", year: "2026", manufacturer: "All Brands" });
    await expect(page.getByRole("listbox", { name: "Sets" })).toBeVisible();
    await columnSearch(page, "Sets").fill("Donruss");
    await columnOption(page, "Sets", "Donruss").click();
    await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible({ timeout: VARIANT_TYPES_SYNC });
    await columnOption(page, "Variant Types", "Insert").click();
    await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: INSERT_FETCH });
    await columnSearch(page, "Inserts").fill("Retro 1997");
    await columnOption(page, "Inserts", INSERT).click();
    // R2 precondition: nothing is fetched yet (a re-run fails here, by name: re-seed first).
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();

    // ══ PHASE A: 13 rows against 14 cards ══
    // The file's own arithmetic, not typed here: counts differ, so the fetch applies NOTHING and
    // suggests every unique name pair.
    expect(WITHOUT_LOWELL.equalCounts).toBe(false);
    expect(WITHOUT_LOWELL.matched).toBe(0);
    expect(WITHOUT_LOWELL.suggested).toBe(WITHOUT_LOWELL.rows);
    await usePublishersChecklist(page, CHECKLISTS.signatureSeries2026WithoutLowell);
    await syncChecklistButton(page).click();

    // One live BSC round trip (measured 2026-11-11: about 1.3 s press to dialog): our 7 s plus the
    // seconds the screen says it is waiting on BSC.
    await expectAfterMarketplace(page, matchCards, {
      platform: "BuySportsCards",
      what: "Match Cards after the fetch of the Signature Series insert",
    });
    await expect(matchCards.getByText(/^Line up each card with its checklist row\. Every card here gets saved/)).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: `BuySportsCards cards (${WITHOUT_LOWELL.cards})` })).toBeVisible();
    // Confirm is usable once the batch has streamed in whole and the teams have landed.
    await expect(matchCards.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();

    // Solo mode: the one marketplace's cards are all kept, so no control keeps, unkeeps or removes one.
    await expect(matchCards.getByRole("button", { name: /^(Keep|Unkeep|Remove)\b/ })).toHaveCount(0);

    // The suggestions: every unique name pair is pre-linked once Confirm unblocks.
    const linked = matchCards.getByRole("button", { name: /^Unlink checklist row / });
    const rows = matchCards.getByRole("list", { name: /checklist rows$/i }).getByRole("listitem");
    await expect(rows).toHaveCount(WITHOUT_LOWELL.rows);
    await expect(linked).toHaveCount(WITHOUT_LOWELL.suggested);
    await expect(matchCards.getByRole("heading", { name: yourChecklist(WITHOUT_LOWELL.rows - WITHOUT_LOWELL.suggested) })).toBeVisible();
    // Mike Lowell has no row: his card is listed, saved, and carries no "Checklist #" chip.
    const lowell = matchCards.getByRole("listitem").filter({ hasText: /^#SIG-ML/ });
    await expect(lowell).toContainText("Mike Lowell");
    await expect(lowell).not.toContainText("Checklist #");
    await expect(matchCards.getByText(`${WITHOUT_LOWELL.cards} cards will be saved`)).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog, checklist suggestions linked" });

    // Unlink one row: it returns to the list, its card loses the chip, and both can be linked by buttons.
    const thomas = matchCards.getByRole("listitem").filter({ hasText: /^#SIG-FT/ });
    await expect(thomas).toContainText("Checklist #1");
    await matchCards.getByRole("button", { name: /^Unlink checklist row .*Frank Thomas.* from #SIG-FT/ }).click();
    await expect(linked).toHaveCount(WITHOUT_LOWELL.suggested - 1);
    await expect(matchCards.getByRole("heading", { name: yourChecklist(WITHOUT_LOWELL.rows - WITHOUT_LOWELL.suggested + 1) })).toBeVisible();
    await expect(thomas).not.toContainText("Checklist #");
    const pickRow = matchCards.getByRole("button", { name: /^Select .*Frank Thomas/ });
    await expect(pickRow).toHaveAttribute("aria-pressed", "false");
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog, one checklist row unlinked" });
    await pickRow.click();
    await expect(pickRow).toHaveAttribute("aria-pressed", "true");
    await matchCards.getByRole("button", { name: /^Link selected checklist row to #SIG-FT/ }).click();
    await expect(linked).toHaveCount(WITHOUT_LOWELL.suggested);
    await expect(thomas).toContainText("Checklist #1");

    // Confirm: the 13 linked rows' teams reach the wizard. It opens on Oakland A's (NB has no club of
    // that name): the first question about a name.
    await matchCards.getByRole("button", { name: "Confirm card matches" }).click();
    await expect(matchCards).toBeHidden();
    const clubStep = wizard.getByRole("heading", { level: 3, name: `New Team: ${CLUB}` });
    await expect(clubStep).toBeVisible();

    // Back to Match Cards keeps every link the operator made.
    await wizard.getByRole("button", { name: "Back to Match Cards" }).click();
    await expect(matchCards).toBeVisible();
    await expect(linked).toHaveCount(WITHOUT_LOWELL.suggested);
    await matchCards.getByRole("button", { name: "Confirm card matches", disabled: false }).click();
    await expect(clubStep).toBeVisible();

    // Link the club to the one the checklist names, the 1968-2024 Oakland Athletics. Remember-box
    // OFF first, while the combobox is closed: no alias is saved (PHASE B reads the decision back).
    await answerClubStep(page);

    // "Cards with no team" holds Mike Lowell ONLY: the other 13 took their team from the checklist.
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeVisible();
    await expect(wizard.getByRole("radiogroup", { name: /^Team for / })).toHaveCount(1);
    await expect(wizard.getByRole("radiogroup", { name: "Team for Mike Lowell" })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "wizard after checklist-solo confirm" });
    await cancelAndDiscard(page);
    await expect(matchCards).toBeHidden();

    // ══ PHASE A2: 14 rows, one misspelled, against 14 cards ══
    // Equal counts, so the fetch applies the unique name pairs itself: 13 of them, and the misspelled
    // row and Rhett Lowder's card are left for the operator.
    expect(MIXED.equalCounts).toBe(true);
    expect(MIXED.matched).toBe(MIXED.cards - 1);
    await page.getByRole("button", { name: "Remove the publisher's checklist" }).click();
    await expect(publishersChecklistChip(page, WITHOUT_LOWELL.rows)).toBeHidden();
    await expect(publishersChecklistButton(page)).toBeVisible();
    await usePublishersChecklist(page, CHECKLISTS.signatureSeries2026MisspelledLowder);
    await syncChecklistButton(page).click();
    await expectAfterMarketplace(page, matchCards, {
      platform: "BuySportsCards",
      what: "Match Cards after the fetch of the misspelled Signature Series checklist",
    });
    // The 13 the server paired are not listed: the dialog only says they are saved too.
    await expect(matchCards.getByText(`${MIXED.matched} cards already matched to your checklist — they're saved too`)).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "BuySportsCards cards (1)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: yourChecklist(1) })).toBeVisible();
    // Only the one card and the one row are on screen as leftovers.
    const leftoverCards = matchCards.getByRole("listitem").filter({ hasText: /^#SIG-/ });
    await expect(leftoverCards).toHaveCount(1);
    await expect(leftoverCards).toContainText("#SIG-RL Rhett Lowder");
    const leftoverRows = matchCards.getByRole("list", { name: "Leftover checklist rows" }).getByRole("listitem");
    await expect(leftoverRows).toHaveCount(1);
    await expect(leftoverRows).toContainText("#11 Rhett Lowdr");
    await expect(matchCards.getByRole("button", { name: /^Unlink checklist row / })).toHaveCount(0);
    await expect(matchCards.getByRole("button", { name: /^(Keep|Unkeep|Remove)\b/ })).toHaveCount(0);
    await expect(matchCards.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog, one leftover pair" });

    // The operator links the pair with the buttons.
    await matchCards.getByRole("button", { name: /^Select .*Rhett Lowdr/ }).click();
    await matchCards.getByRole("button", { name: /^Link selected checklist row to #SIG-RL/ }).click();
    await expect(matchCards.getByRole("heading", { name: yourChecklist(0) })).toBeVisible();
    await expect(leftoverRows).toContainText("Linked to #SIG-RL Rhett Lowder");
    await matchCards.getByRole("button", { name: "Confirm card matches" }).click();
    await expect(matchCards).toBeHidden();

    // The pair the operator made reads "Rhett Lowder" on the card and "Rhett Lowdr" on the row, so the
    // wizard opens on its "Checklist says otherwise" step (a disagreement is asked, never settled
    // silently). The operator keeps the marketplace's spelling.
    await expectChecklistDisagreementFirst(page);
    await pickDisagreementSide(page, "SIG-RL", "Keep the marketplace's");
    await wizard.getByRole("button", { name: "Next (Enter)", exact: true }).click();

    // Then the one club question, then no "Cards with no team": all 14 cards, the 13 the dialog never
    // listed included, took their team from the checklist, and all 14 reach the save.
    await expect(clubStep).toBeVisible();
    await answerClubStep(page);
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeHidden();
    await advanceToSave(page);
    await expect(wizard.getByText(`Save ${MIXED.cards} cards?`)).toBeVisible();
    await cancelAndDiscard(page);
    await expect(matchCards).toBeHidden();

    // ══ PHASE B: 14 rows against 14 cards ══
    await page.getByRole("button", { name: "Remove the publisher's checklist" }).click();
    await expect(publishersChecklistChip(page, MIXED.rows)).toBeHidden();
    await expect(publishersChecklistButton(page)).toBeVisible();
    expect(WHOLE.equalCounts).toBe(true);
    expect(WHOLE.matched).toBe(WHOLE.cards);
    await usePublishersChecklist(page, CHECKLISTS.signatureSeries2026);
    await syncChecklistButton(page).click();

    // Equal counts: the fetch pairs every row to its card by player, so nothing is left to match and
    // no dialog opens; the line says what the checklist gave.
    await expectAfterMarketplace(page, page.getByText(new RegExp(`Kept all ${WHOLE.cards} cards from BSC`)), {
      platform: "BuySportsCards",
      what: "the kept-cards line of the Signature Series insert",
    });
    await expect(page.getByText(new RegExp(`Teams from your checklist: ${WHOLE.matched} of ${WHOLE.cards} cards`)).first()).toBeVisible();
    await expect(wizard).toBeVisible();
    await expect(matchCards).toBeHidden();

    // Frank Thomas: two on file, the Hall of Famer is linked and shown as a decided row.
    const decided = await openDecidedList(page);
    await expect(decided.getByRole("listitem").filter({ hasText: "Frank Thomas" })).toContainText(
      "Linked to Frank Thomas · the Hall of Famer",
    );

    await expect(clubStep).toBeVisible();
    await answerClubStep(page);
    // Every card has its team, so the walk goes straight past the teams step.
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeHidden();
    await advanceToSave(page);
    await expect(wizard.getByText(`Save ${WHOLE.cards} cards?`)).toBeVisible();
    await confirmSaveButton(page).click();
    await expect(
      page.getByText(new RegExp(`Saved ${WHOLE.cards} cards\\. .*Teams from your checklist: ${WHOLE.matched} of ${WHOLE.cards} cards`)).first(),
    ).toBeVisible();

    // ── READ BACK: the saved cards ──
    // Card numbers stay the marketplace's (a name pairing never rewrites one), found by number the way
    // a collector would. The sub-line is the team's full name; the player search narrows to one card.
    await expect(page.getByRole("button", { name: /^Edit card SIG-/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Edit card [0-9]+(, .*)?$/ })).toHaveCount(0);
    const search = page.getByRole("searchbox", { name: "Search cards" });
    await search.fill("SIG-BW");
    await expect(editCardButton(page, "SIG-BW")).toBeVisible();
    await expect(page.getByText(/^Kansas City Royals( · .*)?$/)).toBeVisible();
    await search.fill("SIG-JW");
    await expect(editCardButton(page, "SIG-JW")).toBeVisible();
    await expect(page.getByText(/^Oakland Athletics( · .*)?$/)).toBeVisible();
    await expectAccessible(page, { label: "Signature Series checklist, saved by player name" });
  },
);

/**
 * The "New Team: Oakland A's" step, answered as an operator who knows the club: Link to existing,
 * the 1968-2024 Oakland Athletics (the club the checklist names; the 2025-on "Athletics" row is
 * not), the remember-box unticked so no alias is saved. Reads the decision back: a link with no
 * "remembered as" tail.
 *
 * Contract: ENTRY the wizard is on the "New Team: Oakland A's" step. EXIT that name is decided and
 * the wizard has moved on (its decision read back, then resumed).
 */
async function answerClubStep(page: Page): Promise<void> {
  const wizard = reviewWizard(page);
  const remember = wizard.getByRole("checkbox", { name: `Remember “${CLUB}” as a name for this team` });
  await remember.uncheck();
  await expect(remember).not.toBeChecked();
  await wizard.getByRole("combobox", { name: "Search all teams" }).click();
  // Empty and focused, the combobox lists the step's near matches by label: the era is in the name.
  await page.getByRole("option", { name: /^Oakland Athletics .*1968.2024/ }).click();
  await expect(wizard.getByRole("heading", { level: 3, name: `New Team: ${CLUB}` })).toBeHidden();
  const panel = await readBackDecision(page, /^Linked to Oakland Athletics(?!.*remembered as)/, { resume: true });
  await expect(panel).toBeHidden();
}
