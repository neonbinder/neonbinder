---
name: reference_neo335_teams_on_cards_section
description: NEO-335 Phase 2 wizard chrome ("Tidy up this set", "Step x of y", subtitles), the teams/titles/Save post-name steps and their footers, teams-line handles (radio `<choice> — <owner>`, "Other team…" picker), no-names entry, the `N need you` pill and card walker, and the drawer Next-card walk
metadata:
  type: reference
---

Written 2026-10-11 from the working tree while Phase 2 was still landing, NOT from a
green run. Trust a green CI run over this.

**Chrome (wizard AND post-save walker).** h2 `Tidy up this set`; one status text
`Step x of y`; subtitle per screen: `New league`, `New team`, `New player`, `Which
player is this?`, `Cards with no team`, `Card titles`, `Ready to save`. On a NAME step
x = decided + 1 (`Step 1 of …` = old `0 of … reviewed`; one decision = `Step 2 of …`).
y grows with staged steps, so pin x only. Save is always `Step y of y`. Old strings
(`Confirm New Players & Teams`, `N of M reviewed`, `· N still being looked up`, `All
reviewed — save N cards?`, `K cards have no team yet`) are gone. The footer `N still
looking up — wait or skip` line still exists.

**Post-name steps.** Teams (only if a card would save teamless) and Card titles (only
if a NEW card's title needs a look) each have footer `Next (Enter)` (handles its own
Enter) and NO Confirm & Save; `Back` is named `Back to previous step`. Save: h3 `Save N
cards?`/`Save 1 card?`, Confirm & Save autofocused. "Names done" = the footer shows
`Next (Enter)` or `Confirm & Save`; then the advance-to-save helper. The Decided list
renders on names and Save only, never on teams/titles.

**No-names entry (teams-only / D7 titles-only).** No unknown names but a teamless
card, or a new card with a trimmed title: the wizard opens straight on that step
(`Step 1 of 2`), no bulk links. Re-syncs of stored rows never get the titles step.
Branch on `Tidy up this set` vs `Saved N …` appearing first; assert subtitle `Cards
with no team|Card titles`.

**Teams lines.** Intro `Pick a team for each card, or leave it for later.` Radio group
named `Team for <owner>` (multi-player line: `Teams for <owner>`, checkbox chips);
radios `<choice> — <owner>` for chips, `No team on this card`, `Leave for later`;
owner = `A & B[, N cards]` or `#<number> <card name>`. Every teamless card with NO
players (skipped names included) shares ONE line owned `Cards with no players (N)`,
never pre-filled; N is an exact count. CHECKED is a `✓` inside the radio (or
`toBeChecked()`). A grouped line's expander is a button whose text is `#5 · #407 · 2
cards` (past four numbers: `#a, #b, #c +K · N cards`); inside, `Just this card… —
#<n> <name>` gives a card its own row (owner `#<n> <name>`), flipping to `Match the
others — …`. `Other team… — <owner>` opens ONE focused search field (name `Team name
to find`, placeholder `Search or add a team…`, last option `+ New team “X”…`); `No
matches.` + Enter opens the New Team dialog; `Create team <name>` joins the row
selected (chip reads `Loading…` first). Pre-fill = exactly ONE career team covering
`[setYear-1, setYear]`; a skipped team string never counts.

**Each step opens scrolled to the top** (fixed in Phase 2 after the body kept the
previous step's scroll). Assert the intro text before clicking lines. Footer: `Back to
Match Cards` (text link, was `Back to matching`) and an outlined `Back` (`Back to
previous step`) sit in the right-hand group before Cancel.

**The needs-attention pill and card walker.** The header control is ONE amber button,
text `<N> need you` / `1 needs you` (the visible text is the accessible name; its DOM
id is never a handle). The count is the label, so an exact-text assertion IS the
exact-count assert, and clicking it opens the walker. It replaced the `<N> need
attention` chip, the `Show only cards needing attention` filter, the `Fix them one at
a time` link and the post-save banner CTA (none of those strings exist now). A sibling
sr-only status reads `N cards need you on this checklist`. "Which rows are flagged" is
now proved by opening the walker: it opens on the lowest-numbered flagged card and its
counter is the queue length. Walk order: missing team, then unlinked names, then
titles, then card number. The row badge keeps its accessible name `Card <number>
needs attention: no team on this card yet`. Walker chrome is the wizard's (`Tidy up
this set`, subtitle `Cards with no team` / `Names not yet linked` / `Card titles`, one
`Step x of y` where y = cards seen this sitting and never shrinks, NO "fixed" count:
prove writes by the row badge/pill after close). Its footer `Skip for now, card
<number>` is the only card-specific handle (it tells the walker from the wizard, which
shares the title). Close button text flips `Close (Esc)` to `Done (Esc)` when nothing
is left; all-clear is `All clear — nothing on this checklist needs attention.`, or
`All clear for now. Still looking up teams for K cards.` while BSC-linked cards await
their lookup (never on a hand-made card, which has no BSC ref). The old Fill teams
control and its `N cards need a team` header are gone.

**Reaching identically-numbered cards:** open any drawer, click `Next card` until no
`Remove team …` chip is present; read which chip from the `Team: <name>…` node; click
Next once and wait the chip gone before walking to the next teamed card. Order is
`compareCardNumbers`.

**Titles + short name (Phase 2, "old script title builder").** An insert row's name
joins the title core after the set's, so long insert names cut titles and raise the
Card titles step. Step field named `Shorter set name for titles`, `Suggested: X` +
`Use suggestion`; status `Every title fits now.` / `N titles still trimmed.`; 50 rows
then `And N more, kept as trimmed.` Panel row `Value for Short name for titles`
(setName + card-prefix levels), toast `Saved Short name for titles`. Drawer cut note:
`Auto title was cut short — rewrite it`. A short name replaces set AND insert names;
the maker stays.
