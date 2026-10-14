// Origin: .maestro/flows/set-selector/topps-chrome-insert-known-roster-no-wizard.yaml (NEO-339; Maestro suite retired in NEO-341)
//
// R1 — ONE FEATURE: A FETCH WHOSE NAMES ARE ALL KNOWN SAVES WITH NO NAMES
// REVIEW. Baseball -> 2024 -> Topps -> Topps Chrome › Insert › Youthquake:
// every player and team on the insert is already an NB row (the seed's Base
// commit), so after Match Cards -> Confirm there is NO names review (no player,
// team or league step) and the checklist reads `Saved 50 cards.`
//
// NEO-335 restated the contract: the gate is `Saved N cards.` OR `Tidy up this
// set`. The pre-save review may still open with every name known, when a card
// would save with no team ("Cards with no team") or a new card's title gets
// trimmed ("Card titles"), straight onto that step. If it opens it must hold
// no bulk-name controls (nothing is undecided); the spec presses through the
// teams / titles steps on their defaults (`advanceToSave`) and saves all 50.
//
// This was the retired seed's Future Stars "no wizard" contract; the scripted
// seed commits Future Stars itself, so the screen is proved here on an insert
// nothing else reads.
//
// NOT PROVED HERE: the pairing dialog's `Keep all … -only cards`: no Topps
// Chrome insert has a one-sided card (measured 2026-10-11), so they are covered
// at component level only (CardPairingModal.test.tsx; SET-REGISTRY.md says why).
// R3: the dialog's cancel path (checklist-pairing-dialog-cancel), the
// one-marketplace path (checklist-one-marketplace-skips-match-dialog), a review
// that does open on names (the checklist-wizard-* specs).
//
// R7a — SOLE WRITER of Youthquake's cards (SET-REGISTRY.md): 50 cards, both
// marketplaces, left EMPTY by the seed's Insert reconcile. The commit creates
// no player, team or league. Fresh-only: a re-run finds `Refresh` and fails by
// name at the first-fetch precondition. Each CI pass runs on its own seed.
//
// PAUSED (NEO-287): SportLots is never asked, so the fetch takes the NEO-255
// one-marketplace path (no dialog) and the claim is unchanged.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnOption,
  columnSearch,
  drillToSet,
  pick,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { advanceToSave, confirmSaveButton, reviewWizard, stepCounter } from "../../support/wizard";

const INSERT = "Youthquake";
/** A live BSC (+ SportLots) checklist fetch nothing pre-synced (R5 marketplace exception). */
const CHECKLIST_FETCH = 90_000;

test(
  "2024 Topps Chrome Insert — fetching an insert whose whole roster NB already holds saves every card with no names review (NEO-339)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: drill to Topps Chrome › Insert › Youthquake ──
    // The Inserts column is populated by the seed, so it never auto-opens a
    // reconcile; a dialog here means the seed did not save the Insert rows,
    // and the row pick fails by name.
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Insert", { search: false });
    await columnSearch(page, "Inserts").fill(INSERT);
    await columnOption(page, "Inserts", INSERT).click();

    // ── STEP 2: fetch the EMPTY checklist ──
    // R2 precondition: a FIRST fetch (the label reads "Refresh" once a
    // checklist has cards).
    const sync = syncChecklistButton(page);
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await expect(sync).toHaveText("Fetch from Marketplaces");
    await expectAccessible(page, { label: "Youthquake, empty checklist" });
    await sync.click();

    const wizard = reviewWizard(page);
    const saved = page.getByText(/^Saved [0-9]+ cards\./);
    const matchCards = page.getByRole("dialog", { name: /^Match Cards/ });

    if (!env.SL_PAUSED) {
      // ── STEP 3 (live): Match Cards, Confirm ──
      // The dialog opens on the first streamed candidates and names the set
      // (R5 marketplace exception, checklist-pairing-dialog-cancel's 90 s for
      // the same fetch on Future Stars; measured ~6 s).
      await expect(matchCards).toBeVisible({ timeout: CHECKLIST_FETCH });
      await expect(matchCards.getByRole("heading", { name: `Match Cards — ${INSERT}` })).toBeVisible();
      // Confirm is inert ("Loading…") while the fetch streams (same exception).
      const confirm = matchCards.getByRole("button", { name: "Confirm card matches", disabled: false });
      await expect(confirm).toBeVisible({ timeout: CHECKLIST_FETCH });
      await expect(confirm).toHaveText("Confirm");
      // What Confirm will save: every one of the 50.
      await expect(matchCards.getByText(/50 cards will be saved/)).toBeVisible();
      await expectAccessible(page, { within: matchCards, label: "Match Cards dialog (Youthquake)" });
      await confirm.click();
      // THE CLAIM's gate: the save, or a names-free review, is next. An NB write
      // (resolve + commit, no marketplace): 7 s (measured 1.06 s + 0.36 s on
      // 2026 Bowman).
      await expect(saved.or(wizard).first()).toBeVisible();
      await expect(matchCards).toHaveCount(0);
    } else {
      // ── STEP 3 (paused): one marketplace, no dialog; every BSC card kept ──
      await expect(saved.or(wizard).first()).toBeVisible({ timeout: CHECKLIST_FETCH });
      await expect(matchCards).toHaveCount(0);
    }

    // ── STEP 4: no names; a teams / titles review is pressed through (NEO-335) ──
    // The two never coexist (the banner is cleared when a sync starts, and the
    // review is open until its commit writes "Saved N"), so which is up is
    // settled and read once.
    if (await wizard.isVisible()) {
      await expectAccessible(page, { within: wizard, label: "Tidy up this set, known roster" });
      // Still no names: neither bulk control is offered, because nothing is
      // undecided. A names review fails here, by name (paired with the
      // positives right after).
      await expect(wizard.getByRole("button", { name: /Skip remaining names|Add remaining players as new/ })).toHaveCount(0);
      // A no-names sitting opens ON its first post-name step, with no name step before it.
      await expect(wizard.getByText(/^(Cards with no team|Card titles)$/)).toBeVisible();
      await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);
      await advanceToSave(page);
      // The Save step, for all 50; the strict count below then pins the save.
      await expect(wizard.getByRole("heading", { name: "Save 50 cards?" })).toBeVisible();
      await confirmSaveButton(page).click();
      // Our own write (R5): the same 7 s bar as the direct save.
      await expect(saved).toBeVisible();
    }
    await expect(page.getByText(/^Saved 50 cards\./)).toBeVisible();
    await expectAccessible(page, { label: "Youthquake, 50 cards saved" });
  },
);
