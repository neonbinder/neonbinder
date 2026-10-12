---
name: reference_neo335_teams_on_cards_section
description: NEO-335 Phase 2 wizard chrome ("Tidy up this set", "Step x of y", subtitles), the teams/titles/Save post-name steps and their footers, teams-line selectors (radio `<choice> — <owner>`, ✓ = checked, "Other team…" picker), no-names entry, and the drawer Next-card walk
metadata:
  type: reference
---

Written 2026-10-11 from the working tree while Phase 2 was still landing, NOT
from a green run. Trust a green CI run over this.

**Chrome (wizard AND post-save walker).** h2 `Tidy up this set`; one
`role=status` text node `Step x of y`; subtitle per screen: `New league`,
`New team`, `New player`, `Which player is this?`, `Cards with no team`,
`Card titles`, `Ready to save`. On a NAME step x = decided + 1 (`Step 1 of …`
= old `0 of … reviewed`; one decision = `Step 2 of …`). y grows with staged
steps, so pin x only. Save is always `Step y of y`. Old strings
(`Confirm New Players & Teams`, `N of M reviewed`, `· N still being looked
up`, `All reviewed — save N cards?`, `K cards have no team yet`) are gone. The
footer `N still looking up — wait or skip` line still exists.

**Post-name steps.** Teams (only if a card would save teamless) and Card
titles (only if a NEW card's title needs a look) each have footer
`Next (Enter)` (marker class btn-next-step, handles its own Enter) and NO
Confirm & Save; `Back` is aria `Back to previous step`. Save: h3
`Save N cards?`/`Save 1 card?`, Confirm & Save autofocused. "Names done" =
`text: "Next \\(Enter\\)|.*Confirm & Save.*"`; then
`set-selector/util-wizard-advance-to-save.yaml`. The Decided list renders on
names and Save only, never on teams/titles.

**No-names entry (teams-only / D7 titles-only).** No unknown names but a
teamless card, or a new card with a trimmed title → wizard opens straight on
that step (`Step 1 of 2`), no bulk links. Re-syncs of stored rows never get
the titles step. Branch with gate `Tidy up this set|.*Saved N.*` +
copyTextFrom + `when: true:`; assert subtitle `Cards with no team|Card titles`.

**Teams lines.** Intro `Pick a team for each card, or leave it for later.`
Radio group `id: "Team for <owner>"` (multi-player line: `Teams for <owner>`,
checkbox chips); radios `<choice> — <owner>` for chips, `No team on this
card`, `Leave for later`; owner = `A & B[, N cards]` or `#<number> <card
name>`. Every teamless card with NO players (skipped names included)
shares ONE line owned `Cards with no players (N)` — never pre-filled; N is an
exact count. CHECKED = `text: "✓"` + `childOf:` the radio. A grouped line's
expander is a button whose text is `#5 · #407 · 2 cards` (past four numbers:
`#a, #b, #c +K · N cards`); inside, `Just this card… — #<n> <name>` gives a
card its own row (owner `#<n> <name>`), flipping to `Match the others — …`.
`Other team… — <owner>` (match the ellipsis with `.`) opens ONE focused
search field (aria `Team name to find`, placeholder `Search or add a team…`,
last option `+ New team “X”…`); `No matches.` + `pressKey: Enter` opens the
New Team dialog; `Create team <name>` joins the row selected (chip reads
`Loading…` first). Pre-fill = exactly ONE career team covering
`[setYear-1, setYear]`; a skipped team string never counts.

**Each step opens scrolled to the top** (fixed in Phase 2 after the body kept
the previous step's scroll). Keep asserting the intro `below:` the subtitle
before tapping lines. Footer: `Back to Match Cards` (text link, was `Back to
matching`) and an outlined `Back` (aria `Back to previous step`) sit in the
right-hand group before Cancel.

**Reaching identically-numbered cards:** open any drawer, walk `id: "Next
card"` in `repeat while notVisible: id: "Remove team .*"`; read which chip via
`copyTextFrom id: "Team: <name>…"`; tap Next once and wait the chip gone
before walking to the next teamed card. Order is `compareCardNumbers`.
