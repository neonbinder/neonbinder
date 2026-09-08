---
name: reference_quick_add_form_teampicker_neo208
description: "NEO-208 — the CardChecklist quick-add form's free-text Team box is now the same TeamPicker as the drawer/walker. The handle sequence, the MANDATORY centered scroll (the picker is below the 629px fold when the form opens), how to close the popover before Submit, and why no existing flow hits a duplicate-handle collision."
metadata:
  type: reference
---

# Quick-add form's Team field is a TeamPicker (NEO-208)

`CardChecklist`'s add-card form no longer has a free-text `aria-label="Team"` textbox.
In its place, under a visible `Team (optional)` **label** (a `<label>` with no `htmlFor`,
so it is text, not a handle), is the SAME `TeamPicker` the card drawer and the attention
walker's `MissingTeamFixer` use, wrapped in the `fieldClass("team")` div.

Picked teams go to `addCustomCard` as `teamOnCardIds`, so the card is **born LINKED** —
which means it shows its team in the row sub-line and is NOT badged `missingTeam`. The
`pendingTeamNames` path is no longer reachable from this form; a legacy row's typed name
renders as `<name> (unconfirmed)` appended to the same single sub-line.

## The handle sequence (identical to the drawer's picker)

```yaml
# R8 — MANDATORY. See "the fold trap" below.
- scrollUntilVisible:
    element: { id: "Add team" }
    centerElement: true
    timeout: 10000
- tapOn: { id: "Add team" }
- assertVisible: { id: "Search teams" }
- tapOn: { id: "Search teams" }
- inputText: "New York Mets"          # FULL name, not "Mets" — see below
- tapOn: { id: "Add New York Mets" }  # option aria-label is `Add ${team.name}`
- assertVisible: { id: "Remove team New York Mets" }   # the chip
# close the popover BEFORE Submit
- tapOn: { id: "Card name" }
- extendedWaitUntil: { notVisible: { id: "Search teams" }, timeout: 7000 }
- scrollUntilVisible:
    element: { id: "Submit new card" }
    centerElement: true
    timeout: 10000
- tapOn: { id: "Submit new card" }
```

Unlike the drawer's picker, this one is **not a draft** — its value goes straight into
`addCustomCard` on Submit. `openAddForm`/`closeAddForm` clear it at both edges, so a
picked team never carries into the next card.

## THE FOLD TRAP — the #1 way to get this wrong

On the 1024×629 headless viewport the add-card form opens with its lower half **below the
fold**: measured, the Players input sits at y≈595, which puts the whole Team picker and
the Add/Cancel row off screen. Maestro reads an off-screen element as ABSENT, so an
unscrolled `tapOn: { id: "Add team" }` fails with:

```
Element not found: Id matching regex: Add team
```

…which looks exactly like a picker that never rendered. It is not. Scroll with
`centerElement: true` first (that is also why every existing flow scrolls to
`Submit new card` before tapping it). Centering the trigger at y≈315 leaves the Card name
input two rows above and the Add/Cancel row just below, so the whole block then runs in
one viewport with no further scrolling.

## Closing the popover before Submit

The popover is `absolute top-full z-10`, and in THIS form the picker sits directly above
the Add/Cancel row — so an open popover covers `Submit new card`. `TeamPicker`'s
outside-`pointerdown` effect closes it; tap `id: "Card name"` (in the form, outside the
picker root). **Never Escape** — it is the drawer's "discard draft" and the walker's
"defer this card".

## Type the FULL team name, not a distinctive token

The candidate pool is every team in the sport, and other flows' player commits
get-or-create farm clubs in it mid-run (see [[patterns_per_worker_data_isolation]]).
`"Mets"` can in principle be crowded out of the popover's top-8 `.slice(0, 8)`;
`"New York Mets"` is a prefix match and ranks first by construction.

## Duplicate handles — audited 2026-09-03, nothing broken

The form now renders `Team picker` / `Add team` / `Search teams` **while open**, which are
the same handles the drawer's and the walker's pickers use. Every flow that opens the add
form (`checklist-attention-badge-and-filter`, `checklist-attention-walker-missing-team`,
`checklist-title-length-limits-and-fixer`, `features-propagation`, `team-picker`,
`util-add-custom-card`, `variation-link-group-and-unlink`) **submits or cancels it before
opening a drawer or the walker**, so no two pickers are ever mounted at once. `Card name`
is likewise shared between the add form's input and the drawer's, and is safe for the same
reason. A NEW flow that opened the drawer with the add form still up would collide on all
four — check for that before writing one.

## Row sub-line is ONE text node

`CardChecklistItem` renders `{subParts.join(" · ")}` as a single direct text node, so
`getNodeText` returns e.g. exactly `New York Mets` for a hand-added card whose only fact
is its team. Use a plain `assertVisible: ".*New York Mets.*"`; do NOT reach for a
relational matcher (`below:` compares top edges only — see
[[reference_maestro_web_driver_primitives]] §5 — and is untrustworthy inside Virtuoso).
To make such an assertion single-row, give the card a team no OTHER card in the flow gets.

## Title generation is unchanged by the cutover

`assessListingTitle` takes one `teamNames: string[]`. `addCustomCard` now fills it from
`resolveTeamOnCardIdsForWrite`'s returned linked-team names instead of the typed
`pendingTeamNames`, and `previewListingTitle` (behind Regenerate) already preferred
resolved names over pending ones. Since the seeded team's stored `name` is exactly the
string the picker's `Add <name>` option is named after, expected title strings do **not**
change when a flow switches from typing a team to picking it.
