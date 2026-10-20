/**
 * The Match Cards dialog's conflict hold (NEO-339), for every spec that
 * fetches a two-marketplace checklist and has to get through the dialog.
 *
 * "Confirm card matches" is `aria-disabled` while any name or players conflict
 * is unanswered, no pill starts checked, and the footer says why: "Hold up —
 * N conflict(s) still need(s) your pick before these cards save." with a
 * "Go to the next conflict" button beside it. A spec whose feature is NOT the
 * conflict decision calls `settleMatchCards` instead of waiting on Confirm
 * itself: it waits for the dialog to settle, answers whatever conflicts the
 * live data raised (the first offered value on each, a deliberate answer), and
 * returns the released Confirm. A spec whose feature IS the decision drives
 * the pills itself and uses the locators below.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** The footer button that moves focus to the first open conflict. */
export const NEXT_CONFLICT = "Go to the next conflict";

/** The footer line while a conflict is unanswered (visible only then). */
export function conflictsHoldLine(dialog: Locator): Locator {
  return dialog.getByText(/^Hold up — [0-9]+ conflicts? still needs? your pick before these cards save\.$/);
}

/** "Hold up — N …" read as the number N. */
export async function openConflictCount(dialog: Locator): Promise<number> {
  const text = (await conflictsHoldLine(dialog).textContent()) ?? "";
  return Number(/Hold up — ([0-9]+) /.exec(text)?.[1]);
}

/**
 * The Confirm button once it is usable (not `aria-disabled`): not while the
 * stream still loads, not while a conflict is open.
 */
export function releasedConfirm(dialog: Locator): Locator {
  return dialog.getByRole("button", { name: "Confirm card matches", disabled: false });
}

/**
 * Every conflict row's radiogroup that has no checked pill (the matched list
 * must be open to see them: "Go to the next conflict" opens it).
 */
export function unansweredConflicts(page: Page, dialog: Locator): Locator {
  return dialog
    .getByRole("radiogroup", { name: /^(Name|Players) for / })
    .filter({ hasNot: page.getByRole("radio", { checked: true }) });
}

/**
 * Answer every open conflict with the first value each offers, one at a time,
 * and prove the hold went. Contract: ENTRY the footer's hold line is showing
 * (asserted by reading its count). EXIT the hold line is gone. Returns how many
 * conflicts it answered.
 */
export async function answerOpenConflicts(page: Page, dialog: Locator): Promise<number> {
  const open = await openConflictCount(dialog);
  expect(open, "the hold line names a number of open conflicts").toBeGreaterThan(0);
  // Opens the matched list (collapsed on a set with unpaired cards) so the rows exist.
  await dialog.getByRole("button", { name: NEXT_CONFLICT }).click();
  const unanswered = unansweredConflicts(page, dialog);
  await expect(unanswered, "one unanswered pill group per open conflict").toHaveCount(open);
  for (let left = open; left > 0; left--) {
    await unanswered.first().getByRole("radio").first().click();
    await expect(unanswered).toHaveCount(left - 1);
  }
  await expect(conflictsHoldLine(dialog)).toHaveCount(0);
  return open;
}

/**
 * Wait for the Match Cards dialog to finish loading, answer any conflicts the
 * live data raised, and return the released "Confirm card matches" (the caller
 * clicks it). The dialog OPENING is not the fetch FINISHING: Confirm reads
 * "Loading…" (`aria-disabled`) until the stream resolves, and only then does
 * the hold line, if any, appear. `timeout` is that live round trip, passed by
 * the caller with its justification (GUIDE hard rule 3).
 *
 * Both outcomes end in the same hard assertion (R2): the released Confirm.
 */
export async function settleMatchCards(
  page: Page,
  dialog: Locator,
  { timeout }: { timeout: number },
): Promise<Locator> {
  const confirm = releasedConfirm(dialog);
  const hold = conflictsHoldLine(dialog);
  await expect(confirm.or(hold)).toBeVisible({ timeout });
  if (await hold.isVisible()) await answerOpenConflicts(page, dialog);
  await expect(confirm).toBeVisible();
  return confirm;
}
