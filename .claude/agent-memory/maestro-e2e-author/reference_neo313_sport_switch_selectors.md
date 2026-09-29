---
name: neo313-sport-switch-selectors
description: NEO-313 cross-sport selectors (wizard/picker SportSwitch, Players admin Sports field + Cards list) and the traps — the switch's list is unbounded and opens downward, and the admin "Also:" tag / multi-sport picker pool were both unreachable at authoring time
metadata:
  type: reference
---

Selectors (read from the components, 2026-09-28; flows: checklist-wizard-link-commits,
card-player-picker-cross-sport, admin/player-sports-multi-sport-membership):

- Wizard row switch: `id: "Sport for this name: <Sport>"` — it lives in the
  wizard BODY (beside the `<h3>` name), not the pinned header. Picker switches:
  `Sport to search for players: <Sport>` / `Sport to search for teams: <Sport>`,
  last element of the portalled popover. List: `id: "Choose a sport"`; option =
  `text: "<Sport>"` + `childOf: {id: "Choose a sport"}` (the button has no
  direct text; its first span does).
- After a switch the row goes `pending` and re-runs its Wikidata lookup; a hit
  with career teams STAGES New Team steps that outrank even a pinned row. Re-run
  `util-wizard-walk-to-player-row` after the switch, then assert the row's switch
  reads the new sport (the only row that does).
- Players admin: "Add sport" (TEXT, no aria) → `id: "Add sport <Sport>"`; chip
  `id: "Remove sport <Sport>"`; list `id: "Cards for <name>"` (li: `#<number>`,
  card name, breadcrumb, a `<Sport>` tag only when the card's sport ≠ home).
  Refusal: "N card(s) in <Sport> sets still link to <name>. Unlink those first…".
  Guest chip on a card: `<Sport>` text inside the picker ROOT
  (`Players on the new card` / `Player picker`), never in the portalled popover.

Traps:
- **The sport list is unbounded and opens DOWNWARD.** In CI every runner's
  `E2E Test Sport <w>` sorts before Football (~10 rows × 28px). In the wizard it
  can end under the pinned footer (clip invisible to Maestro — a tap would hit a
  DECISION control), so guard with `above: {id: "Decision for .*"}` in the same
  selector as `childOf` (parse-verified to combine). In a picker the popover is
  `fixed` and follows its trigger on window scroll, so `scrollUntilVisible` on the
  option is the one way to reach it.
- At authoring time `players.search` returned no `alsoSportIds` (admin "Also:"
  tag absent in search mode) and `playersInSport` read members only while home
  players < limit (a multi-sport member missing from a 500+ sport's picker pool).
  Check whether those were fixed before trusting a red on them.
