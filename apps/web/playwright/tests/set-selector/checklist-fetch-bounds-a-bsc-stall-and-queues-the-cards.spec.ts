// NEO-487 (R1): when BuySportsCards stops answering for some cards during a
// checklist fetch, the fetch still finishes inside the budget (a stall ends
// within one wave of lookups, it is never waited out card by card), and after
// the save the cards BSC did not answer wait in the background queue for
// another try instead of being put to the operator.
//
// HOW THE STALL IS MADE (D7, Jason 2026-11-10). A test-only switch on the
// deployment: it works only where TESTING_RESET_SECRET is set AND the env flag
// NEONBINDER_TEST_BSC_STALL_CARD_IDS is set. The flag holds a comma list of BSC
// card ids; each is treated as an immediate stall (a timeout, never a 429).
// DEVOPS SETS THIS ON THE PR'S PREVIEW, to exactly these three ids, which are
// cards #1, #2 and #3 of Hockey 1995 Halifax Mooseheads QMJHL on BSC
// (read from BSC's storefront search, 2026-11-10; each is the card's own id):
//
//   STALL_IDS: 96f9a87adeb7d02c275e117ef10d569c,9dba15716322d30fc94e4bd96034e4bf,adf14c41cda48abecf2b69b0faa399ae
//
// A deployment without the flag answers every card, so the spec goes RED at the
// "23 need you" assert, by name: that is the switch being unset, not a product bug.
//
// WHAT IS DELIBERATELY NOT USED: the publisher's checklist. This spec is about
// the per-card lookups a fetch makes WITHOUT one, so no file is uploaded.
//
// WHAT IT PROVES, IN ORDER:
//   1. The fetch lands within 7 s of our own time plus any seconds the screen
//      says it is "Waiting on BuySportsCards..." (`expectAfterMarketplace`). A
//      stall that were retried card by card would blow the 7 s; a stall is
//      instant, so the only time left is ours.
//   2. Every name is skipped, so the wizard's "Cards with no team" step lists the
//      whole set (it cannot tell a stalled card from an answered one whose team
//      name was skipped); the spec only proves the step is reached.
//   (A stalled card reaches the operator from the background lane only after
//   about 6 minutes, so the spec asserts the queued state, never the give-up.)
//   3. After the save the split is on the checklist: the 23 cards BSC answered
//      (their team name was skipped, so they end teamless) are the operator's,
//      "23 need you", and the 3 it did not answer are not in that count: they
//      wait in the queue, and the checklist says so in its own words, "Still
//      looking up teams for 3 cards. Nothing for you to do yet." (a status line;
//      its number moves at most every 5 s, so the first value after the save is
//      the full three). Both are positives; neither can be read off a dead page.
//
// FIXTURE (SET-REGISTRY.md -> "Hockey -> 1995 -> Halifax Mooseheads QMJHL",
// one of the registered spares, needs Jason's approval to take): SOLE WRITER of
// that set (BSC only, 26 cards, reached through the All Brands view); FRESH-ONLY (it commits the
// checklist), so a re-run on the same seed fails at "No cards in this checklist
// yet." by name. Every name is skipped: no player and no team is minted.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { editCardButton } from "../../support/cards";
import { expectAfterMarketplace } from "../../support/marketplace-wait";
import { setBuilderReady, syncChecklistButton } from "../../support/set-builder";
import {
  advanceToSave,
  confirmSaveButton,
  openOneMarketplaceSetBase,
  reviewWizard,
} from "../../support/wizard";

const SET = "Halifax Mooseheads QMJHL";
/** The set's card count on BSC. */
const CARDS = 26;
/** How many of them the preview's stall switch swallows (the ids in the header). */
const STALLED = 3;

test(
  "Checklist fetch — a BSC stall on some cards ends within one wave: the fetch lands and the unanswered cards wait in the background queue, not in the operator's count (NEO-487)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await openOneMarketplaceSetBase(page, env, { set: SET });
    // The precondition for a FIRST fetch (fresh-only): a re-run fails here, by name.
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();

    // ── 1. The fetch, with no publisher's checklist: every card is asked of BSC ──
    await syncChecklistButton(page).click();
    await expectAfterMarketplace(page, page.getByText(new RegExp(`Kept all ${CARDS} cards from BSC`)), {
      platform: "BuySportsCards",
      what: "the fetch's kept-cards line",
    });
    const wizard = reviewWizard(page);
    await expect(wizard).toBeVisible();

    // ── 2. Every name skipped; the teams step is reached ──
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    const next = wizard.getByRole("button", { name: "Next (Enter)", exact: true });
    await expect(skipRemaining.or(next).first()).toBeVisible();
    if (await skipRemaining.isVisible()) await skipRemaining.click();
    await expect(next).toBeVisible();
    await expect(wizard.getByText("Cards with no team", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, Cards with no team after a BSC stall" });

    // ── 3. Save: the answered cards are the operator's, the three unanswered wait in the background ──
    await advanceToSave(page);
    await confirmSaveButton(page).click();
    await expect(page.getByText(new RegExp(`Saved ${CARDS} cards`))).toBeVisible();
    await expect(wizard).toBeHidden();
    // The set's cards are on screen, so what follows is read off a live checklist.
    await expect(editCardButton(page, "1")).toBeVisible();
    // The 23 BSC answered ended teamless and are the operator's; the 3 it did not answer are not in that count.
    await expect(
      page.getByRole("button", { name: `${CARDS - STALLED} need you` }),
      `the attention count is not ${CARDS - STALLED}: the preview's NEONBINDER_TEST_BSC_STALL_CARD_IDS is unset or lists other ids`,
    ).toBeVisible();
    // The queue's own words: the status line names the three, and says it is not the operator's yet.
    await expect(
      page.getByRole("status").filter({ hasText: new RegExp(`^Still looking up teams for ${STALLED} cards\\.`) }),
    ).toBeVisible();
  },
);
