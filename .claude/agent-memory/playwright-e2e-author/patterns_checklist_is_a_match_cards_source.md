---
name: checklist-is-a-match-cards-source
description: Since NEO-496 an official (publisher's) checklist (pasted, or the set's stored one) is a Match Cards source; BSC + a checklist opens Match Cards even with SportLots paused, and "Kept all N cards from BSC" is gone from those fetches
metadata:
  type: patterns
---

Since NEO-496 the sources of a card fetch are the marketplace sides fetched
plus the checklist (a pasted one via `usePublishersChecklist`, or the set's
stored checklist sections linked to the row). Two or more sources open Match
Cards; one source auto-keeps (`soloKeptMessage`).

What that means for specs:
- A BSC-only fetch with a checklist is TWO sources: Match Cards opens even
  with SportLots paused. The old `Kept all N cards from BSC` line and the
  `if (env.SL_PAUSED) expect(matchCards).toBeHidden()` guard are wrong there.
- A BSC card the file leaves out sits in "BSC only (n)" and is DISCARDED at
  Confirm unless kept. A spec whose subject is that left-out card (the one
  live lookup, NEO-489) must keep it. `confirmChecklistMatchCards` in
  `support/published-checklist.ts` waits, proves the teams line, keeps every
  marketplace single, keeps no checklist-only row, confirms.
- "Teams from your checklist: N of M cards" is on the page while Match Cards
  is open; after Confirm into the wizard it is gone until the saved line
  repeats it. Assert it before Confirm.
- After Confirm the pairing session is parked: the wizard offers "Back to
  Match Cards" on a BSC + checklist fetch too.
- The checklist column heading is "Checklist only (n)" (was "Your checklist
  (n to link)" / "(all linked!)"); every row found: "Every checklist row
  found its card."
- A checklist-only set (no marketplace ids) is one source: "Kept all N cards
  from your checklist. Nothing to match, no marketplace attached.", and with
  every name known the commit is direct, its "Saved N cards. Teams from your
  checklist: N of N cards." replacing the kept line: gate on `kept.or(saved)`
  then assert the saved line.

- "Teams from your checklist: N of M" is ONE definition
  (`lib/checklists/checklist-teams-tally.ts`): at fetch N counts marketplace
  cards whose team came from the checklist (a number on two rows pairs
  nothing, D2), M the marketplace cards; at save, kept checklist-only rows
  join both. A short-lived D10 build counted every row naming a team; it was
  reverted, so read the tally file before trusting a remembered count.
- Server pairs live in the COLLAPSED "Matched (n)" list: click "Expand matched
  cards" before asserting a chip or its "Unlink card ... from checklist row"
  button. Unlinking a one-marketplace server pair puts the card on the keep
  shelf ("Keeping (n)") and the row back in "Checklist only (n)".
- Keeping a card in Match Cards is not a wizard decision: Cancel in a wizard
  with nothing decided leaves at once ("Fetch cancelled — no cards saved."),
  with no "Discard N decisions?" confirm, so `cancelAndDiscard` would go red.

- Match Cards' pick controls are `role="radio"` with `aria-checked` inside the
  radiogroups "Pick a BSC card to link" / "Pick a checklist row to link"
  (names unchanged: "Select BSC card #..", "Select #<n> <player> ..."; a picked
  BSC card renames to "#.. , selected. Press to deselect."). Query
  `getByRole("radio", ...)`, never "button" + aria-pressed.
- Server-pair chip text is "Checklist: #N" (or "On checklist"); the near-name
  chip reads "Name match NN%" to the accessibility tree (sr-only prefix), so
  match `/^Name match [0-9]{2}%$/`, not `/^[0-9]{2}%$/`.

Reaching the SET's attributes panel (where the set checklist lives) after a
deeper drill: re-picking the selected set keeps everything below it (a repick
only collapses the column), so go `page.goBack()` through the picks (each pick
is a URL push; a delete is a replace), asserting each view, until the Variant
Types list is open with nothing picked.

Parser gotcha for per-attempt sections in a built checklist: a heading is an
ALL-CAPS line of two or more words; a single word containing a digit reads as
a card number, so a token heading is `E2E <TOKEN uppercased>`, and Reconcile
titles it with `checklistSetTitle` ("E2e Pw8d...").

A PASTED checklist is stricter: `E2E <TOKEN>` still has digits and the paste
dialog shows "No sections found." with Save aria-disabled. Paste a plain
ALL-CAPS heading with no digit ("ROOKIE DEBUT").

Dead no-checklist branches: since NEO-489 every fetch helper caller and every
set-history insert uploads a checklist, so a `facts === undefined` /
`published === undefined` branch never runs, and an assertion added there
passes against any break. The solo line "Kept all N cards from BSC. Nothing to
match, no other marketplace attached." has no live E2E coverage (only
CardChecklist.test.tsx). Before adding an assert to a branch, plant a break on
it and watch it go RED; a pass means the branch is dead.
