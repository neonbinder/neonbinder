// NEO-490 (R1): a publisher's checklist whose card numbers match NONE of the
// marketplace's still reaches its cards, by player name. Panini numbers its
// 2026 Donruss "Retro 1997 Donruss Signature Series Autographs" 1-17 and BSC
// numbers the same 14 cards SIG-AM..SIG-RL, so no number meets another. The
// publisher's checklist is Panini's own (fixtures/checklists, SET-REGISTRY.md):
// BSC names a team on none of these cards, so every team on screen comes from
// the checklist.
//
// BSC and an uploaded checklist are two sources (NEO-496, D10/NQ1), so every fetch
// below opens Match Cards with Keep controls, as two marketplaces always did: a
// card or row left in a column is discarded unless kept. Four parts, in the order
// the operator would meet them:
//   PHASE A, the counts differ (13 rows against 14 cards: Mike Lowell's row is
//     left out). The fetch applies nothing by itself; the 13 unique name pairs
//     come pre-linked in Matched. Mike Lowell's card is "BSC only (1)". One pair
//     is unlinked by the Unlink inside its "Checklist #n" chip (the row returns
//     to "Checklist only", the card waits on the keep shelf) and linked again by
//     the buttons; Lowell is kept; Confirm takes the 13 teams to the wizard, and
//     "Cards with no team" lists Mike Lowell ONLY. Back to Match Cards keeps the
//     links and keeps. Nothing is committed: Cancel, Discard.
//   PHASE A2, the counts match but one name is misspelled (14 rows, row 11 reads
//     "Rhett Lowdr"). The fetch pairs all 14 itself, Lowder by a near name with
//     its percentage chip; every source lines up. The operator unlinks that pair
//     and makes it again by the buttons, and Confirms; the two spellings
//     disagree, so the wizard opens on "Checklist says otherwise" and the
//     operator keeps the card's. No "Cards with no team" follows: all 14 reach
//     the save. Nothing is committed: Cancel, Discard.
//   PHASE B, the counts match (14 rows). The fetch pairs every row to its card
//     by player itself; Match Cards says every card lines up and shows
//     "Teams from your checklist: 14 of 14 cards" while open; no "Cards with no
//     team" step. Panini writes "Oakland A's" for Jacob Wilson; NB holds no club
//     of that name (the checklist's claim is never rewritten, rule 8), so the
//     wizard asks, and the operator links it to the club the checklist means,
//     Oakland Athletics (1968-2024), with the remember-box OFF so no alias is
//     saved. Frank Thomas is two players on file; the Hall of Famer is linked and
//     shown as a decided row. The save reads back: numbers stay SIG-xx, #SIG-BW is
//     Kansas City Royals, #SIG-JW is Oakland Athletics.
//   PHASE C (NEO-496 plan decision 4), the SET's own checklist in Panini's
//     spreadsheet layout (an xlsx with the credit line above the header, built
//     in memory): Map Base Set links Base and Base Rated Prospects; Parallels'
//     first visit rides "Base Red" and "Base Rated Prospects Red" on BSC's bare
//     "Red"; Sync Inserts pairs "Donruss Ballpark Stars Signatures" with BSC's
//     "Donruss Ballparks Stars Signatures" (near name); Unleashed's fetch leaves
//     BSC's two football cards (SG-CO, SG-TB) unkept, keeps the file's two
//     checklist-only rows with Keep all, and commits the file's 22;
//     the same checklist as a CSV replaces it with Unleashed's 20 cards unchanged;
//     Remove.
//
// FIXTURE (SET-REGISTRY.md -> "Baseball -> 2026 -> Donruss"): Baseball > 2026 >
// All Brands > Donruss (brand "Unknown") > Insert > Retro 1997 Donruss Signature
// Series Autographs, BSC only (SportLots is paused), and, in PHASE C, the set's
// Base, Parallel and Insert types (approved by Jason 2026-11-11, Q8/N4). SOLE
// WRITER of the set; FRESH-ONLY (it commits in PHASE B and C), so a re-run fails
// at "No cards in this checklist yet." by name: re-seed first. In PHASES A-B every player and
// club but Oakland A's is on the catalogue, so no player is minted and no live lookup is waited
// on; PHASE C skips every name Unleashed's wizard asks, so it mints nothing either.
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
  columnSelection,
  INSERT_FETCH,
  setBuilderReady,
  syncChecklistButton,
  VARIANT_TYPES_SYNC,
} from "../../support/set-builder";
import { editCardButton } from "../../support/cards";
import { buildDonrussCsv, buildDonrussXlsx } from "../../fixtures/checklists/build-fixtures.mjs";
import {
  advanceToSave,
  cancelAndDiscard,
  confirmSaveButton,
  expectChecklistDisagreementFirst,
  nextStepButton,
  openDecidedList,
  pickDisagreementSide,
  readBackDecision,
  reviewWizard,
} from "../../support/wizard";

const INSERT = "Retro 1997 Donruss Signature Series Autographs";
const SET = "Donruss";
const UNLEASHED = "Unleashed";
/** Panini's name for the insert BSC lists as "Donruss Ballparks Stars Signatures" (the near miss). */
const BALLPARK = "Donruss Ballpark Stars Signatures";
const BALLPARK_BSC = "Donruss Ballparks Stars Signatures";
/**
 * PHASE C's whole-set checklist, in Panini's spreadsheet layout (fixtures/checklists/build-fixtures.mjs),
 * cut down from Panini's published 2026 Donruss sheet to the sections this spec reads: the Base and
 * its Rated Prospects (both the base, Map Base Set), their Red runs (BSC's one bare "Red" parallel),
 * Ballpark Stars Signatures (the near-miss insert) and Unleashed's 20 cards plus two rows BSC does not
 * list (21, 22); BSC lists 22, two of them (SG-CO, SG-TB) football cards the file does not.
 */
const DONRUSS = {
  credit: "Spreadsheet made available by Panini America.",
  sections: [
    {
      name: "Base",
      rows: [
        { number: "1", player: "Ken Griffey Jr.", team: "Seattle Mariners" },
        { number: "2", player: "Johnny Bench", team: "Cincinnati Reds" },
        { number: "3", player: "Chase DeLauter", team: "Cleveland Guardians" },
      ],
    },
    {
      name: "Base Rated Prospects",
      rows: [
        { number: "101", player: "Konnor Griffin", team: "Pittsburgh Pirates" },
        { number: "102", player: "Andrew Fischer", team: "Milwaukee Brewers" },
        { number: "103", player: "Mike Sirota", team: "Los Angeles Dodgers" },
      ],
    },
    {
      name: "Base Red",
      rows: [
        { number: "1", player: "Ken Griffey Jr.", team: "Seattle Mariners", seq: "250" },
        { number: "2", player: "Johnny Bench", team: "Cincinnati Reds", seq: "250" },
        { number: "3", player: "Chase DeLauter", team: "Cleveland Guardians", seq: "250" },
      ],
    },
    {
      name: "Base Rated Prospects Red",
      rows: [
        { number: "101", player: "Konnor Griffin", team: "Pittsburgh Pirates", seq: "250" },
        { number: "102", player: "Andrew Fischer", team: "Milwaukee Brewers", seq: "250" },
        { number: "103", player: "Mike Sirota", team: "Los Angeles Dodgers", seq: "250" },
      ],
    },
    {
      name: BALLPARK,
      rows: [
        { number: "1", player: "Paige Bueckers", team: "Texas Rangers" },
        { number: "2", player: "VJ Edgecombe", team: "Philadelphia Phillies" },
        { number: "3", player: "Angel Reese", team: "Chicago Cubs" },
        { number: "4", player: "Caitlin Clark", team: "Chicago Cubs" },
        { number: "5", player: "Azzi Fudd", team: "Washington Nationals" },
      ],
    },
    {
      name: UNLEASHED,
      rows: [
        { number: "1", player: "Bobby Witt Jr.", team: "Kansas City Royals" },
        { number: "2", player: "Andrew Painter", team: "Philadelphia Phillies" },
        { number: "3", player: "Bubba Chandler", team: "Pittsburgh Pirates" },
        { number: "4", player: "Dylan Crews", team: "Washington Nationals" },
        { number: "5", player: "Eli Willits", team: "Washington Nationals" },
        { number: "6", player: "Luke Keaschall", team: "Minnesota Twins" },
        { number: "7", player: "Spencer Jones", team: "New York Yankees" },
        { number: "8", player: "Bryce Eldridge", team: "San Francisco Giants" },
        { number: "9", player: "Aaron Judge", team: "New York Yankees" },
        { number: "10", player: "Travis Bazzana", team: "Cleveland Guardians" },
        { number: "11", player: "Jacob Misiorowski", team: "Milwaukee Brewers" },
        { number: "12", player: "Jacob Wilson", team: "Oakland A's" },
        { number: "13", player: "Charlie Condon", team: "Colorado Rockies" },
        { number: "14", player: "Paul Skenes", team: "Pittsburgh Pirates" },
        { number: "15", player: "Jackson Chourio", team: "Milwaukee Brewers" },
        { number: "16", player: "Colt Emerson", team: "Seattle Mariners" },
        { number: "17", player: "Trey Yesavage", team: "Toronto Blue Jays" },
        { number: "18", player: "Chase DeLauter", team: "Cleveland Guardians" },
        { number: "19", player: "Matt Shaw", team: "Chicago Cubs" },
        { number: "20", player: "Nick Kurtz", team: "Oakland A's" },
        // Two rows BSC does not list: checklist-only cards, kept with "Keep all" (C4).
        { number: "21", player: "Roman Anthony", team: "Boston Red Sox" },
        { number: "22", player: "Kristian Campbell", team: "Boston Red Sox" },
      ],
    },
  ],
};
const DONRUSS_CARDS = DONRUSS.sections.reduce((n, s) => n + s.rows.length, 0);
/** Unleashed's rows in the file: the cards its fetch saves (its two checklist-only rows kept with Keep all,
 * BSC's two football cards left unkept). */
const UNLEASHED_ROWS = DONRUSS.sections.find((s) => s.name === UNLEASHED)?.rows.length ?? 0;
/** Match Cards' subtitle when a column holds anything (NEO-496). */
const CHECKLIST_SOURCES_SUBTITLE =
  "No cards save until you confirm. Anything left below gets tossed. Keep it to save it.";
/** Match Cards' subtitle when every source lines up (NEO-496). */
const CHECKLIST_ALL_LINED_UP = "Every card lines up across your sources. Review and confirm — no cards are saved until you do.";
const CLUB = "Oakland A's";
const WITHOUT_LOWELL = nameFallbackFacts(CHECKLISTS.signatureSeries2026WithoutLowell, CHECKLISTS.signatureSeries2026);
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

    // NEO-496 (D10, NQ1): BSC and the checklist are two sources, so Match Cards opens with Keep
    // controls like two marketplaces (before NEO-496 a one-marketplace dialog was "solo": no Keep,
    // every card saved). One live BSC round trip (measured 2026-11-11: about 1.3 s press to dialog):
    // our 7 s plus the seconds the screen says it is waiting on BSC.
    await expectAfterMarketplace(page, matchCards, {
      platform: "BuySportsCards",
      what: "Match Cards after the fetch of the Signature Series insert",
    });
    await expect(matchCards.getByText(CHECKLIST_SOURCES_SUBTITLE)).toBeVisible();
    // Confirm is usable once the batch has streamed in whole and the teams have landed.
    await expect(matchCards.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
    // The 13 name pairs come pre-linked; Mike Lowell's card has no row, so it is BSC's alone and is
    // discarded unless kept; no row is left over.
    const lowellKeep = matchCards.getByRole("button", { name: "Keep #SIG-ML Mike Lowell as BSC-only" });
    await expect(matchCards.getByRole("heading", { name: "BSC only (1)" })).toBeVisible();
    await expect(lowellKeep).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (0)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Keeping (0)" })).toBeVisible();
    // The 13 name pairs sit in the collapsed Matched list, each with its "Checklist #n" chip.
    await matchCards.getByRole("button", { name: "Expand matched cards" }).click();
    await expect(matchCards.getByText(`Matched (${WITHOUT_LOWELL.suggested})`)).toBeVisible();
    const thomasUnlink = matchCards.getByRole("button", { name: /^Unlink card #SIG-FT Frank Thomas from checklist row / });
    await expect(thomasUnlink).toBeVisible();
    // The Unlink sits inside the chip; on a phone (e2e-mobile, 412 px) it must still be reachable on screen.
    await thomasUnlink.scrollIntoViewIfNeeded();
    await expect(thomasUnlink).toBeInViewport();
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog, checklist name pairs linked" });

    // Unlink one pair: its row returns to "Checklist only" and the card, BSC's alone now, waits on the
    // keep shelf; the row is linked to it again by buttons.
    await thomasUnlink.click();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (1)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Keeping (1)" })).toBeVisible();
    await expect(matchCards.getByText(`Matched (${WITHOUT_LOWELL.suggested - 1})`)).toBeVisible();
    const pickRow = matchCards.getByRole("radio", { name: /^Select #1 Frank Thomas/ });
    await expect(pickRow).toHaveAttribute("aria-checked", "false");
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog, one checklist row unlinked" });
    await pickRow.click();
    await expect(pickRow).toHaveAttribute("aria-checked", "true");
    await matchCards.getByRole("button", { name: "Link selected checklist row to #SIG-FT Frank Thomas" }).click();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (0)" })).toBeVisible();
    await expect(matchCards.getByRole("button", { name: /^Unlink card #SIG-FT Frank Thomas from checklist row / })).toBeVisible();
    // Keep Mike Lowell's card, so all 14 go on to the wizard.
    await lowellKeep.click();
    await expect(matchCards.getByRole("heading", { name: "BSC only (0)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Keeping (2)" })).toBeVisible();

    // Confirm: the 13 linked rows' teams reach the wizard. It opens on Oakland A's (NB has no club of
    // that name): the first question about a name.
    await matchCards.getByRole("button", { name: "Confirm card matches" }).click();
    await expect(matchCards).toBeHidden();
    const clubStep = wizard.getByRole("heading", { level: 3, name: `New Team: ${CLUB}` });
    await expect(clubStep).toBeVisible();

    // Back to Match Cards keeps every link and keep the operator made.
    await wizard.getByRole("button", { name: "Back to Match Cards" }).click();
    await expect(matchCards).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (0)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "BSC only (0)" })).toBeVisible();
    await matchCards.getByRole("button", { name: "Confirm card matches", disabled: false }).click();
    await expect(clubStep).toBeVisible();

    // Link the club to the one the checklist names, the 1968-2024 Oakland Athletics. Remember-box
    // OFF first, while the combobox is closed: no alias is saved (PHASE B reads the decision back).
    await answerClubStep(page);

    // "Cards with no team" holds Mike Lowell ONLY: the other 13 took their team from the checklist.
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeVisible();
    await expect(wizard.getByRole("radiogroup", { name: /^Team for / })).toHaveCount(1);
    await expect(wizard.getByRole("radiogroup", { name: "Team for Mike Lowell" })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "wizard after a two-source confirm" });
    await cancelAndDiscard(page);
    await expect(matchCards).toBeHidden();

    // ══ PHASE A2: 14 rows, one misspelled, against 14 cards ══
    // Equal counts, so the fetch pairs the unique names itself: 13 exactly, and "Rhett Lowdr" to
    // Rhett Lowder's card by a near name (NEO-496), shown with its percentage.
    expect(MIXED.equalCounts).toBe(true);
    expect(MIXED.matched).toBe(MIXED.cards - 1);
    await page.getByRole("button", { name: "Remove the official checklist" }).click();
    await expect(publishersChecklistChip(page, WITHOUT_LOWELL.rows)).toBeHidden();
    await expect(publishersChecklistButton(page)).toBeVisible();
    await usePublishersChecklist(page, CHECKLISTS.signatureSeries2026MisspelledLowder);
    await syncChecklistButton(page).click();
    await expectAfterMarketplace(page, matchCards, {
      platform: "BuySportsCards",
      what: "Match Cards after the fetch of the misspelled Signature Series checklist",
    });
    await expect(matchCards.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
    await expect(matchCards.getByText(CHECKLIST_ALL_LINED_UP)).toBeVisible();
    await expect(matchCards.getByText(`Matched (${MIXED.cards})`)).toBeVisible();
    const lowder = matchCards.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Edit name for #SIG-RL Rhett Lowder" }) });
    await expect(lowder.getByText("Checklist: #11", { exact: true })).toBeVisible();
    await expect(lowder.getByText(/^Name match [0-9]{2}%$/)).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog, a near-name pair" });

    // The operator undoes the near pair and makes it again with the buttons.
    await lowder.getByRole("button", { name: /^Unlink card #SIG-RL Rhett Lowder from checklist row / }).click();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (1)" })).toBeVisible();
    const leftoverRows = matchCards.getByRole("list", { name: "Leftover checklist rows" }).getByRole("listitem");
    await expect(leftoverRows).toHaveCount(1);
    await expect(leftoverRows).toContainText("#11 Rhett Lowdr");
    await matchCards.getByRole("radio", { name: /^Select #11 Rhett Lowdr/ }).click();
    await matchCards.getByRole("button", { name: /^Link selected checklist row to #SIG-RL/ }).click();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (0)" })).toBeVisible();
    await expect(leftoverRows).toContainText("Linked to #SIG-RL Rhett Lowder");
    await matchCards.getByRole("button", { name: "Confirm card matches" }).click();
    await expect(matchCards).toBeHidden();

    // The pair reads "Rhett Lowder" on the card and "Rhett Lowdr" on the row, so the wizard opens on
    // its "Checklist says otherwise" step (a disagreement is asked, never settled silently). The
    // operator keeps the marketplace's spelling.
    await expectChecklistDisagreementFirst(page);
    await pickDisagreementSide(page, "SIG-RL", "Keep the marketplace's");
    await wizard.getByRole("button", { name: "Next (Enter)", exact: true }).click();

    // Then the one club question, then no "Cards with no team": all 14 cards took their team from the
    // checklist, and all 14 reach the save.
    await expect(clubStep).toBeVisible();
    await answerClubStep(page);
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeHidden();
    await advanceToSave(page);
    await expect(wizard.getByText(`Save ${MIXED.cards} cards?`)).toBeVisible();
    await cancelAndDiscard(page);
    await expect(matchCards).toBeHidden();

    // ══ PHASE B: 14 rows against 14 cards ══
    await page.getByRole("button", { name: "Remove the official checklist" }).click();
    await expect(publishersChecklistChip(page, MIXED.rows)).toBeHidden();
    await expect(publishersChecklistButton(page)).toBeVisible();
    expect(WHOLE.equalCounts).toBe(true);
    expect(WHOLE.matched).toBe(WHOLE.cards);
    await usePublishersChecklist(page, CHECKLISTS.signatureSeries2026);
    await syncChecklistButton(page).click();

    // Equal counts: the fetch pairs every row to its card by player. Two sources, so Match Cards
    // still opens (NQ1), with nothing left in any column; the line says what the checklist gave.
    await expectAfterMarketplace(page, matchCards, { platform: "BuySportsCards", what: "Match Cards for the whole checklist" });
    await expect(matchCards.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
    await expect(matchCards.getByText(CHECKLIST_ALL_LINED_UP)).toBeVisible();
    await expect(matchCards.getByText(`Matched (${WHOLE.cards})`)).toBeVisible();
    await expect(page.getByText(new RegExp(`Teams from your checklist: ${WHOLE.matched} of ${WHOLE.cards} cards`)).first()).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog, every card lined up" });
    await matchCards.getByRole("button", { name: "Confirm card matches" }).click();
    await expect(matchCards).toBeHidden();
    await expect(wizard).toBeVisible();

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
    // ══ PHASE C: the set's own checklist, in Panini's spreadsheet ══
    // NEO-496 (plan decision 4). Uploaded on the SET once PHASE B has committed, so the Inserts
    // column above was filled by BSC alone, and every sync from here on reads the file too.
    // The drill lives in the URL and Back steps through it (re-picking the selected set would keep
    // the insert below it): Back once is the Insert type with its column open, Back again the set.
    await page.goBack();
    await expect(columnSelection(page, "Variant Types", "Insert")).toBeVisible();
    await expect(columnOption(page, "Inserts", INSERT)).toBeVisible();
    await page.goBack();
    await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible();
    const editAttributes = page.getByRole("button", { name: "Edit attributes" });
    const hideAttributes = page.getByRole("button", { name: "Hide attributes" });
    await expect(editAttributes.or(hideAttributes)).toBeVisible();
    if (await editAttributes.isVisible()) await editAttributes.click();
    const panel = page.getByRole("region", { name: "Official checklist" });
    await expect(panel.getByText(/^Got the official checklist\?/)).toBeVisible();
    await panel.getByLabel("Upload checklist").setInputFiles({
      name: "2026-donruss-baseball-checklist.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildDonrussXlsx(DONRUSS),
    });
    const preview = page.getByRole("dialog", { name: "Checklist preview" });
    await expect(preview).toBeVisible();
    await expect(preview.getByText(`${DONRUSS.sections.length} sections`, { exact: true })).toBeVisible();
    await expect(preview.getByText(`${DONRUSS_CARDS} cards`, { exact: true })).toBeVisible();
    // Panini's credit line sits above the header: read and set aside, said by reason.
    await expect(preview.getByText(/^Above the column headings \(1\)$/)).toBeVisible();
    await expectAccessible(page, { within: preview, label: "Checklist preview of a Donruss spreadsheet" });
    await preview.getByRole("button", { name: "Save checklist" }).click();
    await expect(preview).toBeHidden();
    await expect(panel.getByText("2026-donruss-baseball-checklist.xlsx", { exact: true })).toBeVisible();

    // ── C1. Map Base Set: the checklist's Base and Base Rated Prospects are both the base ──
    await columnOption(page, "Variant Types", "Base").click();
    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    await expect(picker).toBeVisible();
    await expectAfterMarketplace(page, picker.getByRole("option", { name: /^BSC base candidate: / }).first(), {
      platform: "BuySportsCards",
      what: "the Donruss base picker's BSC candidates",
    });
    const checklistBase = picker.getByRole("listbox", { name: "Checklist base" });
    // Exact names: "Base" is a prefix of every other section's name here.
    await expect(checklistBase.getByRole("option", { name: "Checklist base section: Base", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      checklistBase.getByRole("option", { name: "Checklist base section: Base Rated Prospects", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    // Their Red runs are parallels of the base, never the base itself.
    await expect(checklistBase.getByRole("option", { name: /^Checklist base section: .* Red$/ })).toHaveCount(0);
    // It is a multi-select the operator can work, on a phone too: take Base Rated Prospects off and
    // put it back, and both are selected again.
    const ratedProspects = checklistBase.getByRole("option", { name: "Checklist base section: Base Rated Prospects", exact: true });
    await ratedProspects.scrollIntoViewIfNeeded();
    await expect(ratedProspects).toBeInViewport();
    await ratedProspects.click();
    await expect(ratedProspects).toHaveAttribute("aria-selected", "false");
    await expect(checklistBase.getByRole("option", { name: "Checklist base section: Base", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await ratedProspects.click();
    await expect(ratedProspects).toHaveAttribute("aria-selected", "true");
    await expectAccessible(page, { within: picker, label: "Select Base Set with two checklist base sections" });
    await picker.getByRole("button", { name: "Confirm Base Set" }).click();
    await expect(picker).toBeHidden();

    // ── C2. Parallels, first visit: the Base's Red runs ride on BSC's bare "Red" ──
    await columnSelection(page, "Variant Types", "Base").click();
    await columnOption(page, "Variant Types", "Parallel").click();
    const reconcileParallels = page.getByRole("dialog", { name: "Reconcile Parallels" });
    await expectAfterMarketplace(page, reconcileParallels, { platform: "BuySportsCards", what: "Reconcile Parallels on the first visit" });
    await expect(reconcileParallels.getByRole("textbox", { name: "NeonBinder set name for Red" })).toBeVisible();
    await expect(reconcileParallels.getByRole("button", { name: "Remove checklist section Base Red from Red" })).toBeVisible();
    await expect(
      reconcileParallels.getByRole("button", { name: "Remove checklist section Base Rated Prospects Red from Red" }),
    ).toBeVisible();
    await expectAccessible(page, { within: reconcileParallels, label: "Reconcile Parallels with the Base's checklist runs" });
    await reconcileParallels.getByRole("button", { name: /^Save [0-9]+ sets$/ }).click();
    await expect(reconcileParallels).toBeHidden();

    // ── C3. Sync Inserts: a near-miss section name still finds its insert ──
    await columnSelection(page, "Variant Types", "Parallel").click();
    await columnOption(page, "Variant Types", "Insert").click();
    await expect(columnHeading(page, "Inserts")).toBeVisible();
    await page.getByRole("button", { name: "Sync Inserts" }).click();
    const reconcileInserts = page.getByRole("dialog", { name: "Reconcile Inserts" });
    await expectAfterMarketplace(page, reconcileInserts, { platform: "BuySportsCards", what: "Reconcile Inserts on Sync Inserts" });
    // Panini's "Donruss Ballpark Stars Signatures" is BSC's "Donruss Ballparks Stars Signatures".
    await expect(
      reconcileInserts.getByRole("button", {
        name: `Remove checklist section ${BALLPARK} from ${BALLPARK_BSC}`,
      }),
    ).toBeVisible();
    await expect(reconcileInserts.getByRole("button", { name: `Remove checklist section ${UNLEASHED} from ${UNLEASHED}` })).toBeVisible();
    await expect(reconcileInserts.getByText("Nothing pending on the checklist")).toBeVisible();
    await expectAccessible(page, { within: reconcileInserts, label: "Reconcile Inserts with a near-miss checklist section" });
    await reconcileInserts.getByRole("button", { name: /^Save [0-9]+ sets$/ }).click();
    await expect(reconcileInserts).toBeHidden();

    // ── C4. Unleashed: BSC lists two football cards the checklist does not ──
    await columnSearch(page, "Inserts").fill(UNLEASHED);
    await columnOption(page, "Inserts", UNLEASHED).click();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await syncChecklistButton(page).click();
    await expectAfterMarketplace(page, matchCards, { platform: "BuySportsCards", what: "Match Cards for Unleashed" });
    await expect(matchCards.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "BSC only (2)" })).toBeVisible();
    await expect(matchCards.getByRole("button", { name: "Keep #SG-CO Chris Olave as BSC-only" })).toBeVisible();
    await expect(matchCards.getByRole("button", { name: "Keep #SG-TB Treylon Burks as BSC-only" })).toBeVisible();
    // The file's rows 21 and 22 have no BSC card: two checklist-only rows, each with its own Keep.
    await expect(matchCards.getByRole("heading", { name: "Checklist only (2)" })).toBeVisible();
    const keepAnthony = matchCards.getByRole("button", { name: /^Keep #21 Roman Anthony.* as checklist-only$/ });
    await expect(keepAnthony).toBeVisible();
    await expect(matchCards.getByRole("button", { name: /^Keep #22 Kristian Campbell.* as checklist-only$/ })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Keeping (0)" })).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards for Unleashed, BSC-only and checklist-only cards" });
    // Phone width (e2e-mobile, 412 px) too: a row's Keep and the column's Keep all are on screen.
    await keepAnthony.scrollIntoViewIfNeeded();
    await expect(keepAnthony).toBeInViewport();
    const keepAllRows = matchCards.getByRole("button", { name: "Keep all checklist-only cards" });
    await keepAllRows.scrollIntoViewIfNeeded();
    await expect(keepAllRows).toBeInViewport();
    // Keep all keeps both rows; BSC's two football cards stay unkept.
    await keepAllRows.click();
    await expect(matchCards.getByRole("heading", { name: "Checklist only (0)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "Keeping (2)" })).toBeVisible();
    await expect(matchCards.getByRole("heading", { name: "BSC only (2)" })).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards for Unleashed, two checklist rows kept" });
    // Left unkept: confirming discards the football cards and saves the kept rows.
    await matchCards.getByRole("button", { name: "Confirm card matches" }).click();
    await expect(matchCards).toBeHidden();
    // The wizard: every name is skipped (no player or team is minted), then Save. The 20 paired cards
    // and the 2 kept rows save (22); neither football card is among them.
    await expect(wizard).toBeVisible();
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    await expect(skipRemaining.or(nextStepButton(page)).or(confirmSaveButton(page)).first()).toBeVisible();
    if (await skipRemaining.isVisible()) await skipRemaining.click();
    await advanceToSave(page);
    await expect(wizard.getByText(`Save ${UNLEASHED_ROWS} cards?`)).toBeVisible();
    await confirmSaveButton(page).click();
    await expect(page.getByText(new RegExp(`Saved ${UNLEASHED_ROWS} cards`)).first()).toBeVisible();
    await expect(editCardButton(page, "1")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Edit card SG-(CO|TB)(, .*)?$/ })).toHaveCount(0);
    // The two kept rows are cards of their own, found by number the way a collector would.
    for (const [number, player] of [["21", "Roman Anthony"], ["22", "Kristian Campbell"]] as const) {
      await search.fill(player);
      await expect(page.getByRole("button", { name: `Edit card ${number}, ${player}` })).toBeVisible();
    }
    await search.fill("");

    // ── C5. Replace with the same checklist as a plain CSV: nothing changes ──
    // Back through the picks to the set (Unleashed -> the Insert type -> Parallel -> Base -> the set),
    // each step the view it was.
    await page.goBack();
    await expect(columnSelection(page, "Variant Types", "Insert")).toBeVisible();
    await expect(columnOption(page, "Inserts", UNLEASHED)).toBeVisible();
    await page.goBack();
    await expect(columnSelection(page, "Variant Types", "Parallel")).toBeVisible();
    await page.goBack();
    await expect(columnSelection(page, "Variant Types", "Base")).toBeVisible();
    await page.goBack();
    await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible();
    await expect(editAttributes.or(hideAttributes)).toBeVisible();
    if (await editAttributes.isVisible()) await editAttributes.click();
    await panel.getByLabel("Replace checklist").setInputFiles({
      name: "2026-donruss-baseball-checklist.csv",
      mimeType: "text/csv",
      buffer: buildDonrussCsv(DONRUSS),
    });
    await expect(preview).toBeVisible();
    await expect(preview.getByText(`${DONRUSS.sections.length} sections`, { exact: true })).toBeVisible();
    await expect(preview.getByText(`${DONRUSS_CARDS} cards`, { exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "Save checklist" }).click();
    await expect(preview).toBeHidden();
    await expect(panel.getByText("2026-donruss-baseball-checklist.csv", { exact: true })).toBeVisible();
    await expect(panel.getByText(new RegExp(`^${DONRUSS.sections.length} sections, ${DONRUSS_CARDS} cards\\. Saved `))).toBeVisible();
    // Nothing changed for the cards it gave: Unleashed still holds the 20 it committed, and neither
    // football card. (Sync Inserts after the replace opens no Reconcile: every section is already
    // linked, so there is nothing to reconcile.)
    await columnOption(page, "Variant Types", "Insert").click();
    await expect(columnHeading(page, "Inserts")).toBeVisible();
    await columnSearch(page, "Inserts").fill(UNLEASHED);
    await columnOption(page, "Inserts", UNLEASHED).click();
    await expect(page.getByRole("heading", { name: `Cards (${UNLEASHED_ROWS})` })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Edit card SG-(CO|TB)(, .*)?$/ })).toHaveCount(0);

    // ── C6. Remove the set's checklist (self-cleaning: the next run starts with none) ──
    // Back through the two picks above: the Insert type, then the set.
    await page.goBack();
    await expect(columnSelection(page, "Variant Types", "Insert")).toBeVisible();
    await page.goBack();
    await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible();
    await expect(editAttributes.or(hideAttributes)).toBeVisible();
    if (await editAttributes.isVisible()) await editAttributes.click();
    await panel.getByRole("button", { name: "Remove checklist" }).click();
    const removeConfirm = page.getByRole("dialog", { name: "Remove this set's checklist?" });
    await expect(removeConfirm).toBeVisible();
    await removeConfirm.getByRole("button", { name: "Yes, remove it" }).click();
    await expect(removeConfirm).toBeHidden();
    await expect(page.getByText("Checklist removed.")).toBeVisible();
    await expect(panel.getByText(/^Got the official checklist\?/)).toBeVisible();
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
