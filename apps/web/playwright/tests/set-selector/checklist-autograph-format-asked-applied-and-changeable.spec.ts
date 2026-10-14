// NEO-345: a synced part's AUTOGRAPH FORMAT is the operator's answer, never a
// marketplace's. Proved on live data through the operator's own path: Sync card
// checklist -> the "Tidy up this set" wizard's required "Autographed cards"
// step -> Confirm & Save, then the card's drawer, Set details and the checklist
// header's prompt.
//   (a) the step is asked (BSC tags every card of this insert AU, and the part
//       has no format yet): both tiles unchecked, Next held, and pressing the
//       held Next says why and puts focus on a tile;
//   (b) after the save the cards read autographed ON CARD in their drawer, with
//       Signed By holding the player and the print run 99 (BSC's SN99 token);
//   (c) Set details' "Autograph format" row holds the answer, and changing it
//       to Sticker carries the part's cards to sticker, Signed By unchanged;
//   (d) a stored part with no format and an AU card that reads "None" shows the
//       checklist header's prompt, and answering it formats that card.
// The four are one spec because they are one fresh-only fixture: a second spec
// would be a second writer of the same cards (R7a).
//
// FIXTURE (SET-REGISTRY.md -> "Baseball -> 2025 -- the NEO-345 autograph
// fixture"; approved by Jason): Baseball -> 2025 -> Bowman > Bowman Draft >
// Insert > Bowman Draft Nights Autographs, five cards, every one tagged
// AU + SN99 in BSC's attribute field (probed 2026-10-14; the dual-team insert
// next door lists its numbering only in the product name, which is why it
// cannot serve). SOLE WRITER of those five cards. It shares the YEAR and the
// Insert column's reconcile with the dual-team spec, which owns a different
// insert (different rows): either may run first, so the reconcile is reached
// through `openInsertsReconcile`. FRESH-ONLY (a re-run finds the checklist
// committed and fails at "No cards in this checklist yet.": re-seed first).
// It mints no player, team or league: every name step the wizard stages is
// skipped. The per-project run only differs in the signed-in worker.
//
// NOT PROVED HERE (no existing fixture can prove it live; unit/component tests
// are the proof, named so a reader can find them):
//  * the missing-team fixer's case line ("We couldn't get a team ..." / "The
//    listing has no team ..."): it needs a synced BSC card whose team check
//    ANSWERED with no hint (or gave up after three live failures), and no
//    registered fixture yields a card the walker can be pinned to. The walker
//    opens on the lowest-numbered flagged card, and BSC names a team (so a hint)
//    for every card of every set the suite commits, bar a handful on the Line
//    Up Venezuelan set (#279, #292, #296 ...) that the sole-writer alias spec
//    leaves among hundreds of hinted flagged cards. Covered by
//    components/SetSelector/MissingTeamFixer.test.tsx (outcomeHeading and the
//    rendered line), convex/cardChecklist.bscTeamEnrichment.test.ts,
//    convex/bscTeamEnrichmentQueue.test.ts and convex/fetchBscCardTeamNames.test.ts
//    (the outcome stamps).
//  * a BSC attribute label read as a team ("AU  SN1") and RELIC/MEM/JSY tokens:
//    none of the fixtures' cards carries one live (public catalogue, 2026-10-14).
//    Covered by convex/adapters/buysportscards.test.ts,
//    convex/fetchBscCardTeamNames.test.ts and convex/backfillBscAttributeFeatures.test.ts.
//    The RC token IS carried by the seeded Topps Chrome Base: its drawer flag is
//    asserted in checklist-renders-rich-fields.
//  * the cascade's skips (an operator's own autographed value is left alone) and
//    the armed backfill: convex/autographFormat.test.ts and
//    convex/backfillBscAttributeFeatures.test.ts.
//
// ALL NEO-345 copy (subtitle, question, tiles, hint, row, prompt) is
// PLACEHOLDER wording, matched here as it reads today (`support/wizard.ts`
// holds the wizard's) and it WILL change: update the strings, not the asserts.
import type { Locator } from "@playwright/test";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { editCardButton } from "../../support/cards";
import {
  COLD_SYNC,
  columnHeading,
  columnOption,
  columnSearch,
  drillToColdManufacturer,
  drillToSet,
  INSERT_FETCH,
  openInsertsReconcile,
  pick,
  setBuilderReady,
  syncChecklistButton,
  VARIANT_TYPES_SYNC,
} from "../../support/set-builder";
import {
  advanceToSave,
  AUTOGRAPH_BLOCKED_HINT,
  AUTOGRAPH_STEP_SUBTITLE,
  answerAutographStep,
  autographChoice,
  autographChoices,
  confirmSaveButton,
  expectStepLeft,
  personSkip,
  readStep,
  reviewWizard,
  walkToAutographStep,
} from "../../support/wizard";

const INSERT = "Bowman Draft Nights Autographs";
const CARD = "BDNA-KA"; // Kade Anderson, Seattle Mariners: AU + SN99
const PLAYER = "Kade Anderson";
const BOWMAN_DRAFT = { sport: "Baseball", year: "2025", manufacturer: "Bowman", set: "Bowman Draft" };
/** A live BSC (+ SportLots) checklist round trip. */
const CHECKLIST_FETCH = 120_000;
/** The wizard opens behind the live lookups the batch queues. */
const WIZARD_OPENS = 60_000;
/** A live Wikidata round trip per unknown name, five-wide over a shared pool. */
const LOOKUPS = 180_000;

const PILL = {
  onCard: /Value for Autographed: Auto \(On Card\)/,
  sticker: /Value for Autographed: Auto \(Sticker\)/,
};

test(
  "Checklist — a synced part's autograph format is asked in Tidy up this set, applied to its AU cards, changeable in Set details and asked again from the header (NEO-345)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const wizard = reviewWizard(page);
    const reconcile = page.getByRole("dialog", { name: "Reconcile Inserts" });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: drill to Baseball / 2025 / Bowman, pick `Bowman Draft`, open Insert ──
    // The year may be cold (this spec ran first) or already synced by the
    // dual-team spec; the helper's waits are ceilings, not sleeps.
    await drillToColdManufacturer(page, env, { sport: "Baseball", year: "2025", manufacturer: "Bowman" });
    await expect(page.getByRole("listbox", { name: "Sets" })).toBeVisible({ timeout: COLD_SYNC });
    await pick(page, "Sets", "Bowman Draft");
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    const insertType = columnOption(page, "Variant Types", "Insert");
    await expect(insertType).toBeVisible({ timeout: VARIANT_TYPES_SYNC });
    await insertType.click();

    // ── STEP 2: make the insert an NB set: the Inserts reconcile ──
    if (!env.SL_PAUSED) {
      await openInsertsReconcile(page);
      // Narrow both lists to the insert. Its refractor siblings share the words,
      // so the set is made by its own exact button, never "Keep all" (that would
      // make every sibling a set too).
      await reconcile.getByRole("textbox", { name: "Filter NeonBinder sets" }).fill(INSERT);
      await reconcile.getByRole("textbox", { name: "Filter BSC items" }).fill(INSERT);
      const insertSet = reconcile.getByRole("textbox", { name: `NeonBinder set name for ${INSERT}`, exact: true });
      const makeOwn = reconcile.getByRole("button", { name: `Make its own set: ${INSERT}`, exact: true });
      await expect(insertSet.or(makeOwn)).toBeVisible();
      if (await makeOwn.isVisible()) await makeOwn.click();
      await expect(insertSet).toBeVisible();
      await expectAccessible(page, { within: reconcile, label: "Reconcile Inserts dialog (Bowman Draft Nights Autographs)" });
      await reconcile.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
      await expect(reconcile).toBeHidden();

      // Saving leaves the columns at the offset the dialog opened from: re-drill
      // (every level is warm now) and reopen the Insert column.
      await drillToSet(page, env, BOWMAN_DRAFT);
      await columnOption(page, "Variant Types", "Insert").click();
    } else {
      // Paused: one marketplace, nothing to reconcile; the column fills straight from BSC.
      await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: INSERT_FETCH });
      await expect(reconcile).toBeHidden();
    }

    // ── STEP 3: select the insert and fetch its checklist ──
    await columnSearch(page, "Inserts").fill(INSERT);
    await columnOption(page, "Inserts", INSERT).click();
    // The empty-checklist assert makes the saved cards below THIS fetch's.
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await syncChecklistButton(page).click();

    // A SportLots set paired with the insert opens "Match Cards"; one source
    // takes the one-marketplace path ("Kept all N cards from BSC"). A live round trip.
    const matchCards = page.getByText(/Match Cards/).first();
    const kept = page.getByText(/Kept all [0-9]+ cards? from BSC/);
    await expect(matchCards.or(kept).or(wizard).first()).toBeVisible({ timeout: CHECKLIST_FETCH });
    // NEO-287: paused, nothing was asked of SportLots, so the pairing dialog is the bug.
    if (env.SL_PAUSED) await expect(matchCards).toBeHidden();
    if (await matchCards.isVisible()) {
      // The dialog OPENING is not the fetch FINISHING: Confirm reads "Loading…" and is inert until it resolves.
      const confirm = page.getByRole("button", { name: "Confirm card matches", disabled: false });
      await expect(confirm).toBeVisible({ timeout: CHECKLIST_FETCH });
      await expectAccessible(page, {
        within: page.getByRole("dialog", { name: /^Match Cards/ }),
        label: "Match Cards dialog (Bowman Draft Nights Autographs)",
      });
      await confirm.click();
      await expect(page.getByText(/Match Cards/)).toBeHidden();
    }

    // ── STEP 4: the wizard opens, and (a) its Autographed cards step is asked ──
    // REQUIRED (R2): every card of this insert is tagged AU and the part has no
    // format, so the save is never direct. The wizard opens behind the entity
    // check's batch (a live round trip). A fetch that saved without it did not
    // see AU, and fails here by name.
    await expect(wizard, "the sync opens Tidy up this set for AU cards on a part with no autograph format").toBeVisible({
      timeout: WIZARD_OPENS,
    });

    // Names first, when the catalogue lacks any (it may hold all five draftees;
    // then the wizard opens straight onto the autograph step). Lookups settle
    // before anything is skipped, since team rows are presented only once settled.
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });
    const person = personSkip(page);
    const confirmSave = confirmSaveButton(page);
    const next = wizard.getByRole("button", { name: "Next (Enter)", exact: true });
    const namesDone = next.or(confirmSave);
    const stepSkip = wizard.getByRole("button", {
      name: /^Skip .* — (not a team|this team has no league)$/,
      disabled: false,
    });
    await expect(person.or(namesDone).or(stepSkip)).toBeVisible();
    // This spec is not about names: skip every staged team/league step (two
    // passes, as walkToPlayerRow: rows behind a step settle once it is decided),
    // then every player in one press. Skipping creates nothing.
    for (let pass = 0; pass < 2; pass++) {
      await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });
      for (let i = 0; i < 40; i++) {
        await expect(person.or(namesDone).or(stepSkip)).toBeVisible({ timeout: LOOKUPS });
        if ((await person.isVisible()) || (await namesDone.isVisible())) break;
        const name = (await stepSkip.first().getAttribute("aria-label")) ?? "";
        await stepSkip.first().click();
        // The step's own skip names it, so its going away means the step moved on.
        await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
      }
      await expect(person.or(namesDone)).toBeVisible();
    }
    // A late staged career-team row can leave one name undecided, so the press
    // repeats until the names-done footer is offered.
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    await expect(async () => {
      if (await skipRemaining.isVisible()) await skipRemaining.click();
      await expect(namesDone).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 7_000 });

    await walkToAutographStep(page);
    await expect(wizard.getByText(AUTOGRAPH_STEP_SUBTITLE, { exact: true })).toBeVisible();
    const onCard = autographChoice(page, "On card");
    const sticker = autographChoice(page, "Sticker");
    await expect(autographChoices(page)).toBeVisible();
    // Two answers, neither pre-picked (no marketplace says which), the way on held.
    await expect(onCard).toBeVisible();
    await expect(sticker).toBeVisible();
    await expect(onCard).not.toBeChecked();
    await expect(sticker).not.toBeChecked();
    await expect(next).toBeDisabled();
    // Reachable on a phone too: each tile and the way on can be brought into view.
    for (const control of [onCard, sticker, next]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }
    await expectAccessible(page, { within: wizard, label: "Tidy up this set wizard, Autographed cards step" });

    // Pressing the held Next does nothing but explain: the line appears and
    // focus goes to a tile. By keyboard (Enter on the focused control): the
    // control is aria-disabled, so an ordinary click would wait for it to be
    // enabled, and the wizard is keyboard-first anyway.
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(wizard.getByRole("status").filter({ hasText: AUTOGRAPH_BLOCKED_HINT })).toBeVisible();
    await expect(onCard).toBeFocused();
    await expect(next).toBeDisabled();
    await expectAccessible(page, { within: wizard, label: "Autographed cards step, Next pressed with nothing picked" });

    // "On card": the pick releases Next, and Next moves the counter on.
    await answerAutographStep(page, "On card");
    await expect(next).toBeEnabled();
    const { x } = await readStep(page);
    await next.click();
    await expectStepLeft(page, x);
    await expect(autographChoices(page)).toBeHidden();
    // Titles (when a title needs a look) and Save: the answer travels with the commit.
    await advanceToSave(page);
    await confirmSave.click();
    // The commit: our own write, the 7 s bar.
    await expect(page.getByText(/Saved 5 cards/)).toBeVisible();

    // ── STEP 5: (b) the drawer reads the card autographed ON CARD ──
    // Read off the stored row (the drawer is built from getCardChecklist), not
    // off the wizard's draft.
    const openCard = async () => {
      await editCardButton(page, CARD).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible();
      await expect(drawer.getByText(new RegExp(`Card #${CARD}`))).toBeVisible();
      return drawer;
    };
    const closeDrawer = async (drawer: Locator) => {
      await drawer.getByRole("button", { name: "Done editing card" }).click();
      await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();
      await expect(syncChecklistButton(page)).toBeVisible();
    };
    const expectSignedBy = async (drawer: Locator) => {
      const showFeatures = drawer.getByRole("button", { name: "Show features editor" });
      const hideFeatures = drawer.getByRole("button", { name: "Hide features editor" });
      // The editor remembers whether it was left open, so open it only if needed.
      await expect(showFeatures.or(hideFeatures)).toBeVisible();
      if (await showFeatures.isVisible()) await showFeatures.click();
      await expect(drawer.getByRole("textbox", { name: "Value for Signed By" })).toHaveValue(PLAYER);
    };

    let drawer = await openCard();
    await expect(drawer.getByRole("button", { name: PILL.onCard })).toHaveAttribute("aria-pressed", "true");
    await expect(drawer.getByRole("button", { name: PILL.sticker })).toHaveAttribute("aria-pressed", "false");
    await expect(drawer.getByRole("spinbutton", { name: "Print run" })).toHaveValue("99");
    await expectSignedBy(drawer);
    await expectAccessible(page, { within: drawer, label: "Card drawer, autographed on card, Signed By seeded, print run 99" });
    await closeDrawer(drawer);

    // ── STEP 6: (c) Set details' "Autograph format" row ──
    // The row holds the wizard's answer (a stored value, read back), and changing
    // it carries the part's AU cards: the same card now reads sticker.
    const editAttributes = page.getByRole("button", { name: "Edit attributes" });
    const hideAttributes = page.getByRole("button", { name: "Hide attributes" });
    // The panel remembers whether it was left open, so open it only if needed.
    await expect(editAttributes.or(hideAttributes)).toBeVisible();
    if (await editAttributes.isVisible()) await editAttributes.click();
    await expect(hideAttributes).toBeVisible();
    const format = page.getByRole("combobox", { name: "Value for Autograph format" });
    const formatShown = format.getByRole("option", { selected: true });
    await expect(format).toBeVisible();
    await expect(formatShown).toHaveText("On card");
    await expectAccessible(page, { label: "Set details open on the insert, Autograph format row" });

    await format.selectOption({ label: "Sticker" });
    await expect(page.getByText(/Saved Autograph format/)).toBeVisible();
    await expect(formatShown).toHaveText("Sticker");
    drawer = await openCard();
    // The cascade is our own server write behind the select: the 7 s bar.
    await expect(drawer.getByRole("button", { name: PILL.sticker })).toHaveAttribute("aria-pressed", "true");
    await expect(drawer.getByRole("button", { name: PILL.onCard })).toHaveAttribute("aria-pressed", "false");
    await expectSignedBy(drawer);
    await closeDrawer(drawer);

    // ── STEP 7: (d) a stored part with an unformatted AU card prompts ──
    // The part is put in the state a stored, never-answered part is in by the
    // operator's own controls: clear the format ("No value" touches no card),
    // then take one card's autograph off by hand. Exactly one AU card reads
    // "None" on a part with no format, so the header asks, for that one card.
    await format.selectOption({ label: "No value" });
    await expect(page.getByText(/Cleared Autograph format/)).toBeVisible();
    await expect(formatShown).toHaveText("No value");
    drawer = await openCard();
    await drawer.getByRole("button", { name: PILL.sticker }).click();
    await expect(drawer.getByRole("button", { name: PILL.sticker })).toHaveAttribute("aria-pressed", "false");
    await expect(drawer.getByRole("button", { name: PILL.onCard })).toHaveAttribute("aria-pressed", "false");
    await closeDrawer(drawer);

    const prompt = page.getByRole("group", { name: "1 autographed card — on card or sticker?", exact: true });
    await expect(prompt).toBeVisible();
    // Reachable on a phone too: both answers can be brought into view.
    for (const answer of ["On card", "Sticker"]) {
      const button = prompt.getByRole("button", { name: answer, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
    await expectAccessible(page, { within: prompt, label: "Checklist header, autograph format prompt" });
    await prompt.getByRole("button", { name: "On card", exact: true }).click();
    // The answer is saved in place: the prompt says so and the part's row holds it.
    await expect(page.getByRole("status").filter({ hasText: "Autographs saved as on card." }).first()).toBeVisible();
    await expect(prompt).toBeHidden();
    await expect(formatShown).toHaveText("On card");
    drawer = await openCard();
    await expect(drawer.getByRole("button", { name: PILL.onCard })).toHaveAttribute("aria-pressed", "true");
    await expect(drawer.getByRole("button", { name: PILL.sticker })).toHaveAttribute("aria-pressed", "false");
    await expectSignedBy(drawer);
    await closeDrawer(drawer);
  },
);
