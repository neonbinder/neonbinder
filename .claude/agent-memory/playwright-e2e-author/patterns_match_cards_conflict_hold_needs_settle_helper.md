---
name: match-cards-conflict-hold-needs-settle-helper
description: NEO-339 — Match Cards Confirm is aria-disabled while any conflict is unanswered, so waiting on `Confirm card matches` with disabled:false stalls on any set with a conflict; use support/pairing.ts settleMatchCards
metadata:
  type: reference
---

Since NEO-339 `CardPairingModal`'s Confirm is `aria-disabled` while any name or
players conflict is unanswered; no pill starts checked; the footer says "Hold up
— N conflict(s) still need(s) your pick before these cards save." beside a "Go
to the next conflict" button (focus to the first open conflict's first pill;
pressing the held Confirm does the same). Clicking ANY pill, even the default
value, or typing a name/roster answers it.

- A spec that merely needs to get through the dialog calls
  `settleMatchCards(page, dialog, { timeout })` (support/pairing.ts). It waits on
  `released Confirm OR the hold line` (live data decides which), answers every
  open conflict with the first value each offers, returns the released Confirm.
  Never wait on `getByRole("button", { name: "Confirm card matches", disabled: false })`
  alone: on a set that raises a conflict it never resolves.
- The released-Confirm locator (`disabled:false`) matches NOTHING while held, so a
  spec asserting the held state needs a plain `getByRole("button", { name:
  "Confirm card matches" })` for `toBeDisabled()`; `released` is only for the click.
- Unanswered pill groups: `radiogroup` named `Name for …`/`Players for …`
  `.filter({ hasNot: page.getByRole("radio", { checked: true }) })`. The inner
  locator of `hasNot` must be rooted at `page`, not at the dialog (it is queried
  relative to each outer match).
- Hold a held Confirm by keyboard: `confirm.focus()` then `keyboard.press("Enter")`;
  `click()` waits forever on an aria-disabled button.
