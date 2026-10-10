---
name: reference_neo335_teams_on_cards_section
description: NEO-335 wizard final-step "K cards have no team yet" section selectors (radio `<choice> — <owner>`, checked = ✓ child, count is a child span) and the teams-only wizard shape every sync-and-commit flow must tolerate; branch on which terminal state a gate found with copyTextFrom + `when: true:`
metadata:
  type: reference
---

Read from the working tree (`TeamsOnCardsSection.tsx`, `teams-on-cards.ts`)
2026-10-10; first used in `checklist-one-marketplace-skips-match-dialog`
STEP 6b — not yet run live when written, so trust a green CI run over this.

**The section** (wizard body, below "All reviewed — save N cards?" + its dl):
- Heading `<h3>`: `<span>K</span> cards have no team yet` — the count is a
  CHILD span, so the h3's own text is ` cards have no team yet`
  ([[maestro-web-getnodetext-form-values]]). Assert `text: ".*cards? ha(s|ve)
  no team yet"`, then the count as `text: "K"` + `childOf:` that heading.
- One line per player set; a card whose names were all SKIPPED is its own
  line, owner `#<number> <card name>` (players → `A & B`, plus `, N cards`
  when collapsed). Radio group `id: "Team for <owner>"`; radios
  `id: "<choice> — <owner>"` (em dash) for each team chip, `No team on this
  card`, `Leave for later`. Default = the pre-filled suggestion, else Leave
  for later.
- CHECKED is a `✓` span inside the checked radio only → `text: "✓"` +
  `childOf: {id: "<radio>", index: n}`. When card numbers repeat (`NNO`) pick
  lines by `index:` (position).
- Never gates Confirm & Save; it is BODY content, so guard a tap with a
  lower line `above: {text: ".*Confirm & Save.*"}`
  ([[guard-a-tap-at-a-footer-buttons-x]]).

**Teams-only wizard.** A sync with no unknown names but a card that would save
with no team (SportLots-only, true BSC blank) now OPENS the wizard — same
title `Confirm New Players & Teams`, straight onto the final step, no
`Skip remaining names`/`Add remaining players as new`, no "N of M reviewed".
Any flow that waited for `Saved N cards` after a known-names sync, or
asserted the wizard absent, must accept it (setup's Future Stars step,
bowman STEP 7, inserts-1996 STEP 7d were patched for it).

**Branch on which terminal state, for free:** gate on `A|B`, then
`copyTextFrom` the same pattern, `evalScript` a boolean off
`maestro.copiedText`, `runFlow when: true:`. No missed `when: visible`
7s lookup on either path (R10). Only valid when A and B never coexist (the
names wizard's bulk links and Confirm & Save are mutually exclusive; a sync
clears the previous "Saved N" banner when it starts).

After save the header pill (`N need you`) is FINAL at "Saved N cards." — the
commit stamps cards whose fetch-time BSC lookup answered.

**Pre-fill from a created player:** a player row decided "Add as New Player"
with ONE staged career team (CareerTeamEntry → its New Team step → "Add as
New Team") pre-fills his card's line (`createdPlayerVerdict`: one-team career
= answer; else the single stint covering the set year). Chip radio id is
`<team full name> — <printed player name>`.

**Re-sync of a committed set:** the NEO-203 content review ALWAYS opens when a
stored card's team or player link differs from the incoming card (a stored
team vs a blank marketplace team, a skipped name vs no player link) — tap
`id: "Skip reviewing changes and continue"`. With every name known or skipped
for the set (skip records are consulted), the review then opens teams-only and
asks only about stored-teamless cards (rows with a team / "no team" / pending
team name are settled via the diff's `existingId`).

**Reaching one of many identically-numbered cards:** open any drawer and walk
`id: "Next card"` in a `repeat while notVisible` on what only the target
shows (e.g. `id: "Remove team .*"` when it is the only teamed card). Display
order is `compareCardNumbers` (digits before text; "NB…" before "NNO").
