---
name: neo313-sport-switch-selectors
description: NEO-313 cross-sport selectors (wizard/picker SportSwitch, Players admin Sports field + Cards list) and the traps — capped inner-scrolling sport list reached by a ONE-key typeahead, and the wizard switch is refused once the walk has answered the row's staged team steps
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
- **`id: "Choose a sport"` never resolved at c5431c9**: the listbox carried
  `id={useId()}` beside its aria-label, and maestro-web's resource-id is
  `node.id || ariaLabel`, so the hierarchy showed `resource-id: "_r_1c_"` on
  the list (both CI reds, step "assertCondition Choose_a_sport", list visibly
  open in the screenshot). The component's own header said the id belonged on a
  non-interactive WRAPPER; fix is product-side (id on a wrapper div, label on
  the listbox). See [[auto-id-shadows-aria-label]].
- **The sport list is a `max-h-48` INNER scroller** (set's sport first, then
  alphabetical; in CI `E2E Test Sport <w>` rows sort before Football). A tap on
  a row below its fold lands on whatever the box covers (clip invisible to
  Maestro). Reach it with the component's typeahead: open → wait `id: "Choose a
  sport"` → `inputText: "F"` (ONE char — see [[maestro-web-driver-primitives]]
  §6) → the row is focused and scrolled into the fold → tap its text. In the
  wizard guard with `below:` the switch + `above: {id: "Decision for .*"}` and NO childOf (it scopes the anchors), then tap with childOf;
  in a picker a centred `scrollUntilVisible` carries the `fixed` popover
  (it follows its trigger on window scroll). The post-pick trigger label is
  the only proof — Maestro exposes no focus/active attribute.
- **Wizard switch refusal:** `switchRowSport` refuses a row whose STAGED team
  steps carry any decision ("Undo the team steps this name raised…"). Career
  teams are staged when the LOOKUP lands and teams-first presents them before
  any player, so after `util-wizard-walk-to-player-row` the presented player's
  own staged steps are already skipped — the switch is refused on any row that
  raised one. Reported as a product gap 2026-09-28; check whether it was fixed
  before reading a red at "Sport for this name: Football".
- Guest chip tag (`PlayerGuestTag`) renders nothing until its own query
  answers and nothing at all for a multi-sport member: wait for it with
  `extendedWaitUntil` 7000; never assert its absence on a chip. The admin
  Cards list tag is deterministic (derived from the loaded player doc) — assert
  a member's card has no tag there.
