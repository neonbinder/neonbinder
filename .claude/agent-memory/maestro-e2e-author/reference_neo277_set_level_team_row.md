---
name: neo277-set-level-team-row
description: "NEO-277 set-level Team row in SetAttributesPanel — the four renamed picker handles, the pending-empty state (× saves nothing; 'Clear team' / 'Keep <team>'), the ONE-gesture change that reaches the cascade confirm, the cards-only confirm copy, and why the transient 'Saved Team…' toast cannot be asserted (assert 'Team applied to cards')."
metadata:
  type: reference
---

# NEO-277 — Team as a set-level attribute (SetAttributesPanel › `SetTeamRow`)

Owned by `set-selector/set-team-carries-down-to-cards.yaml`. Read
`SET_TEAM_PICKER_LABELS` in `SetAttributesPanel.tsx` for the live strings.

## Handles (set-row picker only; card pickers keep the defaults)
root `Whole-set team` · trigger `Add set team` (visible `+ Add set team`) ·
search `Find a team for the set` · listbox `Set team matches`. Chip/option/
create-row labels are NOT renamed (`Remove team <full>`, `New team <typed>`,
`Create team <full>`), so keep the drawer CLOSED while driving the set row or
`Remove team X` is ambiguous.

## State machine a flow must respect
* A non-empty pick → cascade PREVIEW → confirm only if `cardsFollowing > 0`
  (nodes beneath do not count and are not in the copy) → save → the row is
  stamped and the picker is DISABLED with `Applying to cards…` until the
  cascade's last chunk clears it. A save during that window is refused
  ("Still applying the last team change…").
* **× on the LAST chip saves nothing.** Pending-empty: `Clear team` and
  `Keep <stored full name>` appear under the picker. The CHANGE gesture is
  × then `+ Add set team` + pick: the pick is previewed against the still-
  stored old team, so inheriting cards follow and overrides stay — one
  confirm, one cascade. (Picker appends; there is no replace-in-place.)
* Confirm copy (cards only, exact): title `Apply <A and B> to this set?`,
  body `1 card under this set will get <names>.` + ` 1 card carries a
  different team — these will not change.` (staying reasons joined by ", ",
  noun only on the first). Button `Yes, apply`. Clear path: `Take <team> off
  this set?` / `Yes, clear` / toast `Cleared Team · cards unchanged`.

## Toasts — assert the TERMINAL one
`Saved Team` / `Saved Team · applying to N cards` is raised on the save and
REPLACED by `Team applied to cards` when the stamp clears — sub-second for a
handful of cards — so a visible-text wait on the transient string is a race.
`extendedWaitUntil "Team applied to cards"` (7000) is the honest assertion and
the stronger fact (cascade landed, picker unlocked). Same panel toast region
as `Saved <feature>` (6 s, each message replaces the last).

## Fixture choices that matter
* Use `E2E Test Sport <w>` ancestors, not Baseball, when a flow must answer
  the New Team dialog's League row: under Baseball every league (including
  ones other runners mint) renders in a `max-h-40` inner scroller maestro-web
  cannot drive; under the synthetic sport the only pill is `No league`.
* Card rows print the COMPOSED name on one text node (`Loc<t> STA<t>`, or
  `A, B` for two teams, in set order); the collapsed panel bar prints the
  SHORT name in livery as its own span — full-match the composed string to
  hit a row and not the bar.
* To re-scope the panel to the set after drilling deeper: tap the collapsed
  `Sets: <name> — change` card, wait for `Collapse sets`, tap the row (NEO-276
  opens it centred on the selection) — `handleSetSelect` clears deeper levels.
