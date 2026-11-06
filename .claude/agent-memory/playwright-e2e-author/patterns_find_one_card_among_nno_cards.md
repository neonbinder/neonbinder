---
name: pattern-find-one-card-among-nno-cards
description: How to reach a specific committed card in a set whose cards are all numbered NNO (Roanoke fixture) without a DOM handle
metadata:
  type: feedback
---

In an all-`NNO` set the checklist rows are a Virtuoso list (only visible rows
render), so a card cannot be located by number, and a row far down may not be
in the DOM at all.

**How to apply:** open the drawer from a row that is always rendered (the
hand-added card sorts first, `editCardButton(page, card)`), then press the
drawer's `Next card` / `Previous card` (native `disabled` at the ends) until the
`Card name` textbox holds the wanted name (case-insensitive contains). Prove each
press moved the drawer (`not.toHaveValue(before)`). A name to look for can be
read off the wizard's `Skip <name> — not a person` aria-label while the row is
presented. A teams-step line is the radiogroup `Team for <name>` (exact).

A sport row the suite flips a flag on is global state: normalise a leftover at
the start (clear if pressed) and clear it at the end, since sole-writer specs
on dev run against a deployment nobody resets.
