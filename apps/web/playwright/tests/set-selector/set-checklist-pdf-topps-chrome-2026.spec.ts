// NEO-496 (R1): a SET-level publisher checklist, uploaded once as the publisher's
// own PDF, is a source in every sync of the set: Map Base Set, the Inserts
// column's Reconcile, and an insert's card fetch (Match Cards).
//
// The file is built per attempt in Topps' layout (support: fixtures/checklists/
// build-fixtures.mjs): a title line, ALL-CAPS group headings (BASE, INSERT),
// ALL-CAPS section headings, number / player / team in three columns with
// Topps' (R) and (TM) marks after the club, an NNO line (player and team, no
// number) and a filler page of lone "Rookie" words. It carries:
//   - BASE CARDS, 5 rows: the section Map Base Set preselects.
//   - FUTURE STARS, 9 rows against BSC's 10 cards FS-1..FS-10: FS-1..FS-8 as
//     BSC lists them, Paul Skenes misspelled "Paul Skenns" and printed as
//     "109" (so no number pass can reach FS-9 and only the near-name pass
//     pairs it), and Carson Benge's FS-10 left out.
//   - "E2E <TOKEN>", a per-attempt section no marketplace lists: two catalogue
//     players and one NNO card. It is the section Reconcile leaves Pending and
//     the operator makes its own set from.
//
// The walk, in the order an operator meets it:
//   1. Upload on the SET (the attributes panel opens itself there, the
//      official checklist first, NEO-496): the preview shows the three
//      sections and the skipped lines; Save.
//   2. Base: the picker preselects BASE CARDS beside BSC's base listing.
//   3. Insert, FIRST visit: BSC and the stored checklist are two sources, so
//      the column's own first sync opens Reconcile Inserts (plan decision 1):
//      FUTURE STARS rides on BSC's Future Stars, the token section is Pending
//      and becomes its own set (renamed to the single-token name), Save.
//   4. The token set's fetch is checklist-only: no marketplace, so no Match
//      Cards; it keeps the 3 cards and, every name being on the catalogue,
//      commits them straight away (no wizard), with no marketplace link, the
//      teams from the checklist and the clubs without their marks. Proved, its
//      cards and row are deleted there and then.
//   5. Future Stars' fetch has two sources, so Match Cards opens: FS-9 is
//      matched by name with its "Checklist #109" chip and a percentage, FS-10
//      is BSC-only and is kept, no checklist row is left. Confirm reaches the
//      wizard on "Checklist says otherwise" (Skenns vs Skenes); Cancel (nothing
//      is decided yet, so it leaves at once) saves nothing.
//   6. Clean up: Back through the picks to the set, then Remove checklist.
//
// FIXTURE (SET-REGISTRY.md -> "Baseball -> 2026 -> Topps Chrome"): Baseball >
// 2026 > All Brands > Topps Chrome (brand "Unknown"). SOLE WRITER of that set's
// checklist and of its token rows; FRESH-ONLY (R7a): the Inserts column is
// synced and Future Stars linked by the first run, so a re-run fails at the
// "Upload checklist" precondition by name: re-seed first. Never commits a card
// of Future Stars (its commit would build the grouped parallels too).
//
// Not a hand-rolled drill by choice (R9): the helpers drill a Base or a brand's
// set; this set sits under the year's Unknown brand, reached through the pinned
// All Brands view like the other one-marketplace real sets.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectAfterMarketplace } from "../../support/marketplace-wait";
import {
  columnHeading,
  columnOption,
  columnSearch,
  columnSelection,
  drillToColdManufacturer,
  openAttributesPanel,
  setBuilderReady,
  syncChecklistButton,
  VARIANT_TYPES_SYNC,
} from "../../support/set-builder";
import { confirmDeleteCardButton, deleteCardButton, editCardButton } from "../../support/cards";
import { matchCardsDialog, removeSetChecklistUnderAllBrands } from "../../support/published-checklist";
import { expectChecklistDisagreementFirst, reviewWizard } from "../../support/wizard";
import { buildToppsPdf } from "../../fixtures/checklists/build-fixtures.mjs";

const SET = "Topps Chrome";
/** PublishedChecklistPanel's NO_SECTIONS_FOUND: a file with cards and no section has nothing to save. */
const NO_SECTIONS_FOUND =
  "No sections found. A set checklist needs a section heading (like FUTURE STARS) above its cards, or a set column.";
const INSERT = "Future Stars";

/** FUTURE STARS as BSC lists FS-1..FS-8 (identical to the PDF, plan decision 5). */
const FUTURE_STARS = [
  { number: "FS-1", player: "Munetaka Murakami", team: "Chicago White Sox®" },
  { number: "FS-2", player: "Colson Montgomery", team: "Chicago White Sox®" },
  { number: "FS-3", player: "JJ Wetherholt", team: "St. Louis Cardinals®" },
  { number: "FS-4", player: "Samuel Basallo", team: "Baltimore Orioles®" },
  { number: "FS-5", player: "Nick Kurtz", team: "Athletics™" },
  { number: "FS-6", player: "Kevin McGonigle", team: "Detroit Tigers®" },
  { number: "FS-7", player: "Jac Caglianone", team: "Kansas City Royals®" },
  { number: "FS-8", player: "Roman Anthony", team: "Boston Red Sox®" },
  // BSC's FS-9 Paul Skenes, misspelled and misnumbered: only the name pass reaches it.
  { number: "109", player: "Paul Skenns", team: "Pittsburgh Pirates®" },
  // BSC's FS-10 Carson Benge is left out: the card BSC alone lists.
];

test(
  "Set checklist — a Topps PDF on the set maps the base, reconciles the inserts and pairs an insert's cards",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const token = env.ATTEMPT_TOKEN;
    // A heading is ALL CAPS and two words: one word with a digit in it reads as a card number.
    const tokenHeading = `E2E ${token.toUpperCase()}`;
    // What Reconcile titles a set made from an ALL-CAPS section (checklistSetTitle).
    const tokenTitle = `E2e ${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`;
    const pdf = buildToppsPdf({
      title: "2026 Topps Chrome Baseball Checklist",
      groups: [
        {
          heading: "BASE",
          sections: [
            {
              heading: "BASE CARDS",
              rows: [
                { number: "1", player: "Shohei Ohtani", team: "Los Angeles Dodgers®" },
                { number: "2", player: "Cody Bellinger", team: "New York Yankees®" },
                { number: "3", player: "Yordan Alvarez", team: "Houston Astros®" },
                { number: "4", player: "Brice Turang", team: "Milwaukee Brewers™" },
                { number: "5", player: "Trea Turner", team: "Philadelphia Phillies®" },
              ],
            },
          ],
        },
        {
          heading: "INSERT",
          sections: [
            { heading: "FUTURE STARS", rows: FUTURE_STARS },
            {
              heading: tokenHeading,
              rows: [
                { number: "1", player: "Colt Keith", team: "Detroit Tigers®" },
                { number: "2", player: "Gunnar Henderson", team: "Baltimore Orioles®" },
                // An NNO card: Topps prints player and team, no number.
                { player: "Bobby Witt Jr.", team: "Kansas City Royals™" },
              ],
            },
          ],
        },
      ],
      fillerPages: 1,
      fillerWord: "Rookie",
    });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── DRILL: the set, through All Brands ──
    await drillToColdManufacturer(page, env, { sport: "Baseball", year: "2026", manufacturer: "All Brands" });
    await expect(page.getByRole("listbox", { name: "Sets" })).toBeVisible();
    await columnSearch(page, "Sets").fill(SET);
    await columnOption(page, "Sets", SET).click();
    // The set's variant types sync from BSC on first use (VARIANT_TYPES_SYNC, set-builder.ts).
    await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible({ timeout: VARIANT_TYPES_SYNC });

    // ══ 1. UPLOAD ON THE SET ══
    const editAttributes = page.getByRole("button", { name: "Edit attributes" });
    const hideAttributes = page.getByRole("button", { name: "Hide attributes" });
    // A fresh drill to a set opens the attributes panel by itself, the
    // official checklist first (NEO-496): no tap.
    await expect(hideAttributes).toBeVisible();
    await expect(editAttributes).toBeHidden();
    const panel = page.getByRole("region", { name: "Official checklist" });
    await expect(panel).toBeVisible();
    // R2 precondition: no checklist on the set yet (a re-run fails here, by name: re-seed first).
    await expect(panel.getByText(/^Got the official checklist\?/)).toBeVisible();
    await expectAccessible(page, { within: panel, label: "Official checklist, none on the set" });

    await panel.getByLabel("Upload checklist").setInputFiles({
      name: "2026-topps-chrome-checklist.pdf",
      mimeType: "application/pdf",
      buffer: pdf,
    });
    const preview = page.getByRole("dialog", { name: "Checklist preview" });
    await expect(preview).toBeVisible();
    await expect(preview.getByText("3 sections", { exact: true })).toBeVisible();
    await expect(preview.getByText("17 cards", { exact: true })).toBeVisible();
    const sections = preview.getByRole("table", { name: "Sections the checklist will save" });
    const sectionRow = (name: string) => sections.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(sectionRow("BASE CARDS")).toContainText("1 to 5");
    await expect(sectionRow("FUTURE STARS")).toContainText("FS-1 to 109");
    await expect(sectionRow(tokenHeading)).toContainText("1 to 2, plus 1 NNO");
    // The title line and the filler page's lone words are read and set aside, said by reason.
    await expect(preview.getByText(/^Looks like a title, not a card \(1\)$/)).toBeVisible();
    await expect(preview.getByText(/^Only one column here, so it isn't a card \([0-9]+\)$/)).toBeVisible();
    await expectAccessible(page, { within: preview, label: "Checklist preview of a Topps PDF" });
    // R7: from the save on, the set holds this run's checklist. A red body leaves it there, and the
    // next run would start with one (its precondition fails by name), so the `finally` removes it.
    let checklistOnSet = true;
    try {
      await preview.getByRole("button", { name: "Save checklist" }).click();
      await expect(preview).toBeHidden();
      await expect(page.getByText("Checklist saved: 3 sections, 17 cards.")).toBeVisible();
      await expect(panel.getByText("2026-topps-chrome-checklist.pdf", { exact: true })).toBeVisible();
      await expect(panel.getByText(/^3 sections, 17 cards\. Saved .*\. Syncs in this set read its sections\.$/)).toBeVisible();
      await expect(panel.getByRole("button", { name: "Remove checklist" })).toBeVisible();
      await expectAccessible(page, { within: panel, label: "Official checklist saved on the set" });

      // ══ 2. MAP BASE: the checklist's base section is preselected ══
      await columnOption(page, "Variant Types", "Base").click();
      const picker = page.getByRole("dialog", { name: "Select Base Set" });
      await expect(picker).toBeVisible();
      // The BSC candidates are one live BSC round trip (probed 2026-11-11: about 1 s).
      await expectAfterMarketplace(page, picker.getByRole("option", { name: /^BSC base candidate: / }).first(), {
        platform: "BuySportsCards",
        what: "the base picker's BSC candidates",
      });
      const checklistBase = picker.getByRole("listbox", { name: "Checklist base" });
      await expect(checklistBase.getByRole("option", { name: "Checklist base section: BASE CARDS" })).toHaveAttribute("aria-selected", "true");
      // Only base-like sections are listed; the other two wait behind the toggle.
      await expect(checklistBase.getByRole("option")).toHaveCount(1);
      await expect(picker.getByRole("checkbox", { name: "Show all checklist sections" })).toBeVisible();
      await expect(picker.getByText("Show all checklist sections (2 more)")).toBeVisible();
      await expectAccessible(page, { within: picker, label: "Select Base Set with a checklist base section" });
      await picker.getByRole("button", { name: "Confirm Base Set" }).click();
      await expect(picker).toBeHidden();
      await expect(columnSelection(page, "Variant Types", "Base")).toBeVisible();

      // ══ 3. INSERT, FIRST VISIT: Reconcile Inserts with BSC and the checklist ══
      await columnSelection(page, "Variant Types", "Base").click();
      await columnOption(page, "Variant Types", "Insert").click();
      const reconcile = page.getByRole("dialog", { name: "Reconcile Inserts" });
      // The column's first sync is one live BSC round trip (probed 2026-11-11: about 2 s).
      await expectAfterMarketplace(page, reconcile, { platform: "BuySportsCards", what: "Reconcile Inserts on the first visit" });
      // FUTURE STARS rides on BSC's Future Stars, auto-matched by name.
      await expect(reconcile.getByRole("textbox", { name: `NeonBinder set name for ${INSERT}` })).toBeVisible();
      await expect(reconcile.getByRole("button", { name: `Remove checklist section FUTURE STARS from ${INSERT}` })).toBeVisible();
      // The token section matches nothing: Pending, with its own "Make its own set".
      const ownSet = reconcile.getByRole("button", { name: `Make its own set from checklist section: ${tokenHeading}` });
      await expect(ownSet).toBeVisible();
      // BASE CARDS is the Base's own now: not offered here, even with every section shown.
      await reconcile.getByRole("checkbox", { name: "Show all checklist sections" }).check();
      await expect(reconcile.getByRole("button", { name: /^Make its own set from checklist section: BASE CARDS$/ })).toHaveCount(0);
      await expectAccessible(page, { within: reconcile, label: "Reconcile Inserts with a checklist source" });

      await ownSet.click();
      await expect(reconcile.getByText("Nothing pending on the checklist")).toBeVisible();
      const tokenTitleBox = reconcile.getByRole("textbox", { name: `NeonBinder set name for ${tokenTitle}` });
      await expect(tokenTitleBox).toHaveValue(tokenTitle);
      // R7: a minted name is the single token.
      await tokenTitleBox.fill(token);
      await tokenTitleBox.press("Enter");
      await expect(reconcile.getByRole("textbox", { name: `NeonBinder set name for ${token}` })).toHaveValue(token);
      await expectAccessible(page, { within: reconcile, label: "Reconcile Inserts with the checklist section made its own set" });
      await reconcile.getByRole("button", { name: /^Save [0-9]+ sets$/ }).click();
      await expect(reconcile).toBeHidden();

      // ══ 4. THE TOKEN SET: a checklist-only fetch ══
      await expect(columnHeading(page, "Inserts")).toBeVisible();
      await columnSearch(page, "Inserts").fill(token);
      await columnOption(page, "Inserts", token).click();
      await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
      await syncChecklistButton(page).click();
      // No marketplace is attached, so nothing is asked of one and nothing is matched: the fetch
      // keeps the three rows ("Kept all 3 cards from your checklist. Nothing to match, no
      // marketplace attached.") and, every name being on the catalogue, the commit goes straight
      // through, its "Saved" line replacing the kept one. Both lines are this fetch's (the set was
      // empty a step ago), so either is the sync point; the saved line, exactly, is the proof.
      const kept = page.getByText("Kept all 3 cards from your checklist. Nothing to match, no marketplace attached.");
      const saved = page.getByText("Saved 3 cards. Teams from your checklist: 3 of 3 cards.", { exact: true });
      await expect(kept.or(saved).first()).toBeVisible();
      await expect(saved).toBeVisible();
      await expect(matchCardsDialog(page)).toHaveCount(0);
      await expect(reviewWizard(page)).toHaveCount(0);

      for (const number of ["1", "2", "NNO"]) await expect(editCardButton(page, number)).toBeVisible();
      await expect(editCardButton(page, "1")).toHaveAccessibleName("Edit card 1, Colt Keith");
      await expect(editCardButton(page, "NNO")).toHaveAccessibleName("Edit card NNO, Bobby Witt Jr.");
      // The clubs as NB holds them: the publisher's marks are not part of a name.
      await expect(page.getByText(/^Detroit Tigers/).first()).toBeVisible();
      await expect(page.getByText(/[®™]/)).toHaveCount(0);
      // No marketplace link on any of the three (the badges BSC and SportLots cards carry).
      await expect(page.getByTitle(/^(Listable on |BSC source: |SL source: )/)).toHaveCount(0);
      await expectAccessible(page, { label: "Checklist-only set saved" });

      // Proved: clean the token set up now, its cards and then its row (a delete rewrites the
      // address in place, so the drill is the Insert type with its column open again).
      for (const number of ["1", "2", "NNO"]) {
        await deleteCardButton(page, number).click();
        await confirmDeleteCardButton(page, number).click();
        await expect(editCardButton(page, number)).toHaveCount(0);
      }
      await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
      await openAttributesPanel(page);
      await page.getByRole("button", { name: `Delete ${token}`, exact: true }).click();
      const deleteRow = page.getByRole("dialog", { name: new RegExp(`^Delete .*"${token}"\\?$`) });
      await expect(deleteRow).toBeVisible();
      await deleteRow.getByRole("button", { name: "Yes, delete" }).click();
      await expect(deleteRow).toBeHidden();
      await expect(columnOption(page, "Inserts", token)).toHaveCount(0);

      // ══ 5. FUTURE STARS: two sources, so Match Cards ══
      await columnSearch(page, "Inserts").fill(INSERT);
      await columnOption(page, "Inserts", INSERT).click();
      await expect(columnSelection(page, "Inserts", INSERT)).toBeVisible();
      // Navigation lives in the URL: Back is the Insert type with nothing picked, Forward is Future Stars.
      await page.goBack();
      await expect(columnOption(page, "Inserts", INSERT)).toBeVisible();
      await expect(columnSelection(page, "Inserts", INSERT)).toHaveCount(0);
      await page.goForward();
      await expect(columnSelection(page, "Inserts", INSERT)).toBeVisible();
      await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();

      await syncChecklistButton(page).click();
      const matchCards = matchCardsDialog(page);
      // One live BSC round trip (probed 2026-11-11: about 2.4 s).
      await expectAfterMarketplace(page, matchCards, { platform: "BuySportsCards", what: "Match Cards for Future Stars" });
      await expect(matchCards.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
      await expect(
        matchCards.getByText("No cards save until you confirm. Anything left below gets tossed. Keep it to save it."),
      ).toBeVisible();
      // The card the checklist left out is BSC's alone.
      await expect(matchCards.getByRole("heading", { name: "BSC only (1)" })).toBeVisible();
      const benge = matchCards.getByRole("button", { name: "Keep #FS-10 Carson Benge as BSC-only" });
      await expect(benge).toBeVisible();
      // Every checklist row found its card, FS-9 among them by name.
      await expect(matchCards.getByRole("heading", { name: "Checklist only (0)" })).toBeVisible();
      await expect(matchCards.getByText("Every checklist row found its card.")).toBeVisible();
      await matchCards.getByRole("button", { name: /^Expand matched cards/ }).click();
      await expect(matchCards.getByText("Matched (9)")).toBeVisible();
      const skenes = matchCards
        .getByRole("listitem")
        .filter({ has: page.getByRole("button", { name: "Edit name for #FS-9 Paul Skenes" }) });
      await expect(skenes.getByText("Checklist: #109", { exact: true })).toBeVisible();
      await expect(skenes.getByText(/^Name match [0-9]{2}%$/)).toBeVisible();
      await expectAccessible(page, { within: matchCards, label: "Match Cards with BSC and the set checklist" });

      await benge.click();
      await expect(matchCards.getByRole("heading", { name: "BSC only (0)" })).toBeVisible();
      await expect(matchCards.getByRole("heading", { name: "Keeping (1)" })).toBeVisible();
      await matchCards.getByRole("button", { name: "Confirm card matches" }).click();
      await expect(matchCards).toBeHidden();
      // The checklist's "Paul Skenns" against the card's "Paul Skenes": the operator decides.
      await expectChecklistDisagreementFirst(page);
      await expectAccessible(page, { within: reviewWizard(page), label: "Wizard opens on the checklist disagreement" });
      // Nothing was decided in the wizard (Match Cards' keep is not a wizard decision), so Cancel
      // leaves at once, with no "Discard N decisions?" to answer, and saves nothing.
      await reviewWizard(page).getByRole("button", { name: "Cancel (Esc)" }).click();
      await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
      await expect(reviewWizard(page)).toBeHidden();
      await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();

      // ══ 6. CLEAN UP: Back to the set itself, whose panel holds the checklist ══
      // Back steps through the picks: Future Stars -> the Insert type (the token set's entry, rewritten
      // in place by its delete) -> the Insert type as first picked -> Base -> the set.
      await page.goBack();
      await expect(columnOption(page, "Inserts", INSERT)).toBeVisible();
      await expect(columnSelection(page, "Inserts", INSERT)).toHaveCount(0);
      await page.goBack();
      await expect(columnSelection(page, "Variant Types", "Insert")).toBeVisible();
      await page.goBack();
      await expect(columnSelection(page, "Variant Types", "Base")).toBeVisible();
      await page.goBack();
      await expect(columnOption(page, "Variant Types", "Insert")).toBeVisible();
      await openAttributesPanel(page);
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "Remove checklist" }).click();
      const removeConfirm = page.getByRole("dialog", { name: "Remove this set's checklist?" });
      await expect(removeConfirm).toBeVisible();
      await expectAccessible(page, { within: removeConfirm, label: "Remove the set's checklist confirmation" });
      await removeConfirm.getByRole("button", { name: "Yes, remove it" }).click();
      await expect(removeConfirm).toBeHidden();
      await expect(page.getByText("Checklist removed.")).toBeVisible();
      checklistOnSet = false;
      await expect(panel.getByLabel("Upload checklist")).toBeAttached();

      // ══ 7. A FILE WITH CARDS BUT NO SECTION: nothing to save ══
      // A set checklist is read by sections, so a list of cards with no heading above them saves
      // nothing: the preview says why and Save is held.
      await expect(panel.getByText(/^Got the official checklist\?/)).toBeVisible();
      await panel.getByLabel("Upload checklist").setInputFiles({
        name: "no-sections.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("1 Colt Keith - Detroit Tigers\n2 Gunnar Henderson - Baltimore Orioles\n"),
      });
      await expect(preview).toBeVisible();
      await expect(preview.getByText(NO_SECTIONS_FOUND, { exact: true })).toBeVisible();
      await expect(preview.getByRole("button", { name: "Save checklist" })).toHaveAttribute("aria-disabled", "true");
      await expectAccessible(page, { within: preview, label: "Checklist preview of a file with no section" });
      await preview.getByRole("button", { name: "Cancel" }).click();
      await expect(preview).toBeHidden();
      await expect(panel.getByText(/^Got the official checklist\?/)).toBeVisible();

      // ══ 8. PASTE ONE INSTEAD: a pasted checklist saves on the set like a file ══
      await panel.getByRole("button", { name: "Paste one instead" }).click();
      await expect(preview).toBeVisible();
      // A pasted heading is ALL CAPS words with no digit (the token's digits read as a number here).
      await preview
        .getByRole("textbox", { name: "Paste the set's checklist" })
        .fill("ROOKIE DEBUT\n1 Colt Keith - Detroit Tigers\n2 Gunnar Henderson - Baltimore Orioles\n");
      await expect(preview.getByText("1 section", { exact: true })).toBeVisible();
      await expect(preview.getByText("2 cards", { exact: true })).toBeVisible();
      await expectAccessible(page, { within: preview, label: "Paste a set checklist" });
      checklistOnSet = true;
      await preview.getByRole("button", { name: "Save checklist" }).click();
      await expect(preview).toBeHidden();
      await expect(page.getByText("Checklist saved: 1 section, 2 cards.")).toBeVisible();
      await expect(panel.getByText("Pasted checklist", { exact: true })).toBeVisible();
      // And away again, so the next run starts with none.
      await panel.getByRole("button", { name: "Remove checklist" }).click();
      await expect(removeConfirm).toBeVisible();
      await removeConfirm.getByRole("button", { name: "Yes, remove it" }).click();
      await expect(removeConfirm).toBeHidden();
      checklistOnSet = false;
      await expect(panel.getByText(/^Got the official checklist\?/)).toBeVisible();
    } finally {
      if (checklistOnSet) {
        try {
          await removeSetChecklistUnderAllBrands(page, env, { year: "2026", set: SET });
        } catch (error) {
          // The body's own error stays the one the report shows.
          test.info().annotations.push({ type: "cleanup", description: `set checklist not removed: ${String(error)}` });
        }
      }
    }
  },
);
