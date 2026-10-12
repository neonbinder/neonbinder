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
name>` for a skipped-name card. CHECKED = `text: "✓"` + `childOf:` the radio.
`Other team… — <owner>` (match the ellipsis with `.`) opens a TeamPicker with
search `Team name to find`; `No matches.` + `pressKey: Enter` opens the New
Team dialog; `Create team <name>` joins the line selected (chip reads
`Loading…` first). Grouped line: `Different team… — #<n> <name>` /
`Match the others — …` per card. Pre-fill = exactly ONE career team covering
`[setYear-1, setYear]`; a skipped team string never counts.

**Body scroll is shared across steps** (one `overflow-y-auto` div, not keyed),
so a step can open scrolled if the previous one was. Assert the intro
`below:` the subtitle before tapping lines; red there is a product finding.

**Reaching identically-numbered cards:** open any drawer, walk `id: "Next
card"` in `repeat while notVisible: id: "Remove team .*"`; read which chip via
`copyTextFrom id: "Team: <name>…"`; tap Next once and wait the chip gone
before walking to the next teamed card. Order is `compareCardNumbers`.
