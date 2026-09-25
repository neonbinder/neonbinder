---
name: neo307-league-combobox
description: NEO-307 New Team form League combobox (replaced the pill radiogroup) — `id: "League"`, option labels, the Create-option split between dialog (opens NewLeagueForm → "Add league") and wizard (stages a New League step), why the read-back is decisive, and the unverified dialog-body clip risk
metadata:
  type: reference
---

`NewTeamForm` (wizard team step + `NewTeamDialog`) answers League with the
shared `primitives/Autocomplete` combobox. Written 2026-09-25 from the builder's
code, NOT yet from a green run. Check the component before trusting it.

**Selectors**
- Input: `id: "League"` (aria-label). The wizard's `leagueGroupId` sits on the
  WRAPPER on purpose; an id on the input would shadow the aria-label. The visible
  caption `<span>League</span>` is text, so never `tapOn: "League"`.
- Placeholder: "Pick a league or type a new one" (or "Pick a league"). An empty
  box reads back as that ([[test-value-must-not-overlap-placeholder]]).
- Options (`li`, label is the only direct text node; a ✓ span is aria-hidden):
  league name · `<name> (new)` (staged in the batch, DECIDED league rows only) ·
  `Create <name>` (enrichment suggestion) · `Create “<typed>”` (ONLY when the
  typed text is a substring of nothing: no name, alias, abbreviation, staged
  league or suggestion) ·
  `No league` (always last, never filtered). Match curly quotes with `.`.
- Opens on focus with nothing typed (`openOnEmpty`); `selectOnFocus` means
  typing replaces a displayed label.

**Driving it:** tap `id: "League"`, type a STRICT substring (the bare token,
`No lea`), tap the option by full text, read back `{id: "League", text: <label>}`.

**Create splits by host:**
- Dialog: the option opens `NewLeagueForm` pre-filled (`id: "New league name"`),
  `tapOn: "Add league"` writes the row. Picking the option clears the typed text,
  so the box shows the placeholder until the league lands. The read-back of the
  name is therefore decisive, not an echo of the typing.
- Wizard: the option stages a `New League: <name>` step. The team waits on it
  (`waitingOnStagedLeagues` makes an implicit pin stale), the league lookup goes
  runs, but Jason ruled the flow must NOT wait on it (NEO-307): gate on the
  `New League:` heading at 7000 and tap `Add as New League` at once. That
  button is usable while the lookup runs. `Add as New League` hands back to the
  team, which reads `<name> (new)`.

**A minted name that must offer Create needs a NON-DIGIT END.** "Matches
nothing" is a substring test, and ATTEMPT_TOKEN's random tail varies in length,
so `STL<token>` can sit inside an older attempt's `STL<longer-token>` left in the
same sport. That would silently remove the create option. End the name with a
letter (`STL<token>L`) and filter for `<token>L`.

**Dialog body clip:** the body is `overflow-y-auto`, and the opened league form's
"Add league" row could sit under the footer. Maestro cannot see that clip
([[inner-scroller-clip-is-invisible-to-maestro]]). The builder scrolls the form
into view before focusing it. If a run shows the team created with no league,
read the Add-league tap bounds against the body's bottom first.

Worked examples: `set-team-carries-down-to-cards.yaml` (STA create / STB
existing / STC No league), `checklist-wizard-career-team-entry.yaml` (wizard
create + staged pick).

**Team steps link through "Search all teams" (same ticket).** There are no
near-match Link buttons or "Link to Existing…" for TEAMS any more; players and
leagues keep theirs. Every team step has a combobox `id: "Search all teams"`,
pre-filled with the row's name and selecting it on focus. Option direct text is
"Location Name", with a separate "League · years" line. Read the typed value
back (`{id: "Search all teams", text: <typed>}`) before tapping the option, so
that typing into the pre-fill instead of replacing it fails where it happened.
Worked example: `checklist-wizard-link-team-saves-alias.yaml` PART 4.

**Retro rule proof (`allowPastEra`) and the commit fast path.** At commit,
`commitCardChecklistPrelude` links any name that resolves to exactly one row
BEFORE it reads the row's decision. So a linked card cannot tell "never raised"
from "raised and skipped". Prove "not raised" in the wizard itself: walk each
team step, `copyTextFrom "New Team: .*"`, compare, and skip. A card's sub-line
prints an unresolved team as "<name> (unconfirmed)", so match the link with a
negative lookahead. Cached Wikidata career stints (for sizing an era so the
strict stint resolver stages nothing) are in
`convex/adapters/__fixtures__/enrichment-lookups.json`. Worked example: the
alias flow's R2(h).
