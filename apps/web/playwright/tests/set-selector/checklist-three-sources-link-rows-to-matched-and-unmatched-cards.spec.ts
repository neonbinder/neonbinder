// NEO-490 (R1): WRITTEN, PAUSED UNTIL SPORTLOTS RESUMES. With both marketplaces
// and a publisher's checklist in the mix, Match Cards is a three-source screen:
// BSC only, SportLots only and "Checklist only" side by side, and a checklist row
// can be linked onto a card in any state: an unmatched card (which moves onto the
// keep shelf), or a card of a matched pair (whose BSC half keeps its chip when the
// pair is broken). Taking a kept, linked card off the save list returns its row.
//
// WHY IT IS PAUSED, and how: SportLots is paused everywhere the suite runs today
// (PAUSED_PLATFORMS=sportlots, GUIDE -> "Operator switches"). Paused, this set's
// fetch has two sources, BSC and the checklist (NEO-496), not the three this spec
// is about; the two-source screen is proved by set-checklist-pdf-topps-chrome-2026
// and checklist-published-numbers-differ-pairs-by-player, which own their sets. The suite's way of sitting out is a branch on `env.SL_PAUSED`, never
// a skip: the paused branch below proves what the pause shows on this set and
// returns; the live branch is the flow, and it returns by itself the day the
// variable is unset. The live branch has NOT been run (it cannot be: nothing may
// contact SportLots). It is written against the code and its unit-tested names
// (CardPairingModal.checklist.test.tsx), and the first live run is its test.
// Switch-on: with the SportLots resume steps (SET-REGISTRY.md -> "SportLots pause",
// NEO-339's parked PR) done, run this spec once live on its own deployment.
//
// FIXTURE: the seed's 2024 Topps Chrome > Insert > Future Stars (20 cards, BSC +
// SportLots ids), READ-ONLY like checklist-pairing-dialog-cancel: the flow only ever
// cancels, so the seller specs' anchor is untouched. The publisher's checklist is
// Future Stars as a publisher would number it, 101-119 (fixtures/checklists): its
// numbers match neither side's and 19 rows against 20 cards means the counts differ,
// so nothing is applied by the fetch and every unique name pair is only SUGGESTED.
//
// NOT COVERED (open, see the report): the "Teams from your checklist" line after
// Confirm. It is said on the line the save lands with, and a save would write to the
// shared anchor, so it needs a set this spec is the sole writer of.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToSet,
  pick,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import {
  CHECKLISTS,
  nameFallbackFacts,
  publishersChecklistButton,
  publishersChecklistChip,
  usePublishersChecklist,
} from "../../support/published-checklist";

const WHOLE = nameFallbackFacts(CHECKLISTS.futureStars2024PublisherNumbering, CHECKLISTS.futureStars2024);
/**
 * The checklist column's heading: how many rows still wait for a card or a Keep. NEO-496 renamed it
 * from "Your checklist (N to link)" / "(all linked!)" to "Checklist only (N)", in the words of the
 * "BSC only (N)" column beside it (CardPairingModal `checklistColumnHeading`).
 */
const yourChecklist = (unlinked: number) => `Checklist only (${unlinked})`;

test(
  "Checklist — with both marketplaces, Match Cards is three columns and a checklist row links to an unmatched card, keeps a broken pair's BSC half, and returns when its card is removed",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── Drill to the pre-synced 2024 Topps Chrome > Insert > Future Stars (read-only).
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Insert", { search: false });
    await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 20_000 });
    await expect(columnSearch(page, "Inserts")).toBeVisible({ timeout: 60_000 });
    await columnSearch(page, "Inserts").fill("Future Stars");
    const futureStars = columnOption(page, "Inserts", "Future Stars");
    await expect(futureStars).toBeVisible({ timeout: 15_000 });
    await futureStars.click();

    if (env.SL_PAUSED) {
      // PAUSED BRANCH. Nothing is synced (a one-marketplace sync would commit onto the shared anchor).
      // The cards are BSC-only with no SportLots ref and the operator is told why, so the three-source
      // screen has nothing to show.
      await expect(page.getByText(/#FS-[0-9]/).first()).toBeVisible();
      await expect(page.getByText("BSC only", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("SL", { exact: true })).toBeHidden();
      await expect(page.getByText("SportLots is on pause.")).toBeVisible();
      await expect(page.getByRole("dialog", { name: /^Match Cards/ })).toBeHidden();
      await expectAccessible(page, { label: "Future Stars checklist, SportLots on pause (three-source checklist spec)" });
      return;
    }

    // LIVE BRANCH. The set may already hold the seed's own checklist chip (20 rows); the new file replaces
    // it. Either state is fine (chip on screen, or the add button), and the next hard assert needs the
    // button back.
    expect(WHOLE.equalCounts).toBe(false);
    expect(WHOLE.suggested).toBe(WHOLE.rows);
    const seedChip = publishersChecklistChip(page, WHOLE.cards);
    await expect(publishersChecklistButton(page).or(seedChip).first()).toBeVisible();
    if (await seedChip.isVisible()) {
      await page.getByRole("button", { name: "Remove the official checklist" }).click();
    }
    await expect(publishersChecklistButton(page)).toBeVisible();
    await usePublishersChecklist(page, CHECKLISTS.futureStars2024PublisherNumbering);

    // ── Sync opens Match Cards instead of committing. A live BSC + SportLots round trip: the budget the
    // sibling spec uses for the same set (unmeasured here; measure it on the first live run and replace it
    // with the measured time plus 7 s).
    await syncChecklistButton(page).click();
    const dialog = page.getByRole("dialog", { name: /^Match Cards/ });
    await expect(dialog).toBeVisible({ timeout: 90_000 });
    await expect(dialog.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible({ timeout: 90_000 });

    // The 19 name pairs are pre-linked on the matched pairs (the counts differ, so nothing was applied by
    // the fetch): the checklist column reads "Checklist only (0)" and Brayan Rocchio's card has no row.
    await expect(dialog.getByRole("heading", { name: yourChecklist(WHOLE.rows - WHOLE.suggested) })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Unlink checklist row #101 .* from #FS-1 / })).toBeVisible();

    // ── STEP 1: pull #FS-2's row off its card and break its pair, so a BSC-only card (#FS-2), a
    // SportLots-only card and an unlinked row (#102) are all on screen: three columns.
    await dialog.getByRole("button", { name: /^Unlink checklist row #102 .* from #FS-2 / }).click();
    await expect(dialog.getByRole("radio", { name: /^Select #102 Gunnar Henderson/ })).toBeVisible();
    await dialog.getByRole("button", { name: /^Unlink #FS-2 / }).click();
    await expect(dialog.getByRole("heading", { name: /^BSC only \(1\)$/ })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^SportLots only \(1\)$/ })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: yourChecklist(1) })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Filter checklist rows" })).toBeVisible();

    // ── STEP 2: link the row onto the unmatched BSC card; the card moves onto its keep shelf.
    await dialog.getByRole("radio", { name: /^Select #102 Gunnar Henderson/ }).click();
    await dialog.getByRole("button", { name: /^Link selected checklist row to #FS-2 / }).click();
    await expect(dialog.getByRole("heading", { name: /^BSC only \(0\)$/ })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^Keeping \(1\)$/ })).toBeVisible();
    const kept = dialog.getByRole("listitem").filter({ hasText: /^BSC: #FS-2 / });
    await expect(kept).toContainText("Checklist: #102");
    await expect(dialog.getByRole("heading", { name: yourChecklist(0) })).toBeVisible();

    // ── STEP 3: break a linked pair. #FS-1's pair carries row #101; Unlink splits it, and the BSC half
    // keeps its "Checklist #101" chip (on the keep shelf), while the SportLots half waits in its column.
    await dialog.getByRole("button", { name: /^Unlink #FS-1 / }).click();
    await expect(dialog.getByRole("heading", { name: /^Keeping \(2\)$/ })).toBeVisible();
    await expect(dialog.getByRole("listitem").filter({ hasText: /^BSC: #FS-1 / })).toContainText("Checklist: #101");
    await expect(dialog.getByRole("button", { name: /^Unlink checklist row #101 .* from #FS-1 / })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^SportLots only \(2\)$/ })).toBeVisible();

    // ── STEP 5 (axe) on the three-column layout, light and dark (expectAccessible runs both).
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, three sources side by side" });

    // ── STEP 4: take the kept, linked #FS-2 card off the save list; its row returns to the list.
    await dialog.getByRole("button", { name: /^Remove #FS-2 .* from save list$/ }).click();
    await expect(dialog.getByRole("heading", { name: /^Keeping \(1\)$/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Select #102 Gunnar Henderson/ })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: yourChecklist(1) })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^BSC only \(1\)$/ })).toBeVisible();

    // ── END: nothing is saved. Cancel asks to discard (the session has edits), and discarding writes nothing.
    await dialog.getByRole("button", { name: "Cancel card matching" }).click();
    await page.getByRole("button", { name: /^Discard [0-9]+ pairings?$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Sync cancelled — no cards saved.")).toBeVisible();
  },
);
