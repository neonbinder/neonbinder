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
// THE PUBLISHER'S CHECKLIST (Jason, 2026-11-10: prefer prebuilt checklists over
// live calls while BSC is unstable, keeping a small live read as the coverage).
// The spec uploads fixtures/checklists/1995-hockey-halifax-mooseheads-qmjhl-base-
// five-live.csv: the set's own BSC answers for 21 of its 26 cards, with cards
// #1, #2, #3, #24 and #25 left OUT. So BSC is asked per card for exactly five:
// the three stalled ones (#1-#3), which this spec is about, and two that
// answer (#24, #25), which prove a lookup that is NOT stalled still lands.
//

// WHAT IT PROVES, IN ORDER:
//   1. The fetch lands within 7 s of our own time plus any seconds the screen
//      says it is "Waiting on BuySportsCards..." (`expectAfterMarketplace`); with
//      the checklist uploaded it lands in Match Cards (NEO-496), where the five
//      BSC-only cards are kept and confirmed. A
//      stall that were retried card by card would blow the 7 s; a stall is
//      instant, so the only time left is ours. The result line then says the
//      checklist supplied the teams of 21 cards ("Teams from your checklist").
//   2. Every name is skipped, so the wizard's "Cards with no team" step lists the
//      whole set (it cannot tell a stalled card from an answered one whose team
//      name was skipped); the spec only proves the step is reached.
//   (A stalled card reaches the operator from the background lane only after
//   about 6 minutes, so the spec asserts the queued state, never the give-up.)
//   3. After the save the split is on the checklist: the 23 cards that have an
//      answer (21 from the checklist and the 2 BSC answered live; their team name
//      was skipped, so they end teamless) are the operator's, "23 need you", and
//      the 3 it did not answer are not in that count: they wait in the queue, and
//      the checklist says so in its own words, "Still looking up teams for 3
//      cards. Nothing for you to do yet." (a status line; its number moves at
//      most every 5 s, so the first value after the save is the full three). The
//      "23" is also the proof of the two live answers: had either met a BSC 429
//      or an open cooldown it would wait in the queue too, and the line would
//      say 4 (or 5) cards. NEO-489 (Jason, 2026-11-11): that is a pass, not a
//      red. The spec reads M off the line (3 to 5), asserts exactly 26 - M need
//      you, and annotates which branch ran (`bsc-lookup`). A missing line is the
//      only red. Both are positives; neither can be read off a dead page. Axe runs on the
//      saved checklist with the status line showing.
//
// FIXTURE (SET-REGISTRY.md -> "Hockey -> 1995 -> Halifax Mooseheads QMJHL",
// one of the registered spares, needs Jason's approval to take): SOLE WRITER of
// that set (BSC only, 26 cards, reached through the All Brands view); FRESH-ONLY (it commits the
// checklist), so a re-run on the same seed fails at "No cards in this checklist
// yet." by name. Every name is skipped: no player and no team is minted.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { editCardButton } from "../../support/cards";
import { bscLookupOutcome } from "../../support/marketplace-wait";
import { CHECKLISTS, confirmChecklistMatchCards, usePublishersChecklist } from "../../support/published-checklist";
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

    // ── 1. The fetch, with the trimmed checklist: BSC is asked per card for five only ──
    const facts = await usePublishersChecklist(page, CHECKLISTS.halifaxMooseheads1995FiveLive);
    await syncChecklistButton(page).click();
    // NEO-496 (D10, NQ1): BSC plus the uploaded checklist are two sources, so Match Cards opens.
    // The helper waits on it with `expectAfterMarketplace` (7 s of ours plus BSC's), proves the
    // teams line, keeps the five BSC cards the file leaves out and confirms: all 26 go on.
    await confirmChecklistMatchCards(page, { facts, what: "the Halifax fetch" });
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
    // The queue's own words: the status line names the cards that wait, and says it is not the operator's yet.
    // No line at all means the stall switch is unset (every card answered): red, by name.
    const lookupStatus = page.getByRole("status").filter({ hasText: /^Still looking up teams for [0-9]+ cards?\./ });
    await expect(
      lookupStatus,
      "no 'Still looking up teams' line: the deployment's NEONBINDER_TEST_BSC_STALL_CARD_IDS is unset or lists other ids, so the three stalled cards were never queued",
    ).toBeVisible();
    // NEO-489 (Jason, 2026-11-11: a BSC 429 or an open cooldown on a live card is a pass). The three
    // stalled cards always wait. The two live lookups (#24, #25) wait too when BSC rate-limits them
    // or its cooldown is open, so M is 3 (both answered) up to 5 (neither). Whatever M is, the
    // cards BSC DID answer end teamless and are the operator's, exactly CARDS - M.
    // The line and the button are read TOGETHER and retried together: the queue drains while the
    // page is open, so a count read once and a button asserted a moment later could straddle a
    // drain and disagree about the same instant. Each pass reads M, then asserts 26 - M need you
    // (a count that is not CARDS - M fails by its number). Exact, positive.
    let queued = 0;
    await expect(async () => {
      queued = Number((((await lookupStatus.textContent({ timeout: 1_000 })) ?? "").match(/for ([0-9]+) cards?/) ?? [])[1]);
      expect(queued, "the stalled cards plus at most the two live ones wait in the queue").toBeGreaterThanOrEqual(STALLED);
      expect(queued, "the stalled cards plus at most the two live ones wait in the queue").toBeLessThanOrEqual(STALLED + 2);
      await expect(page.getByRole("button", { name: `${CARDS - queued} need you`, exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 7_000 });
    bscLookupOutcome(queued === STALLED ? "answered" : "cooldown", `Halifax #24, #25 (${queued} cards waiting)`);
    await expectAccessible(page, { label: "Halifax checklist saved, the unanswered cards waiting in the background" });
  },
);
