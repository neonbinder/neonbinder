---
name: admin-teams-selects-are-unreachable
description: "/admin/teams renders three <select>s, so only the FIRST (league-filter) is tappable — the team-league dropdown is still unreachable. The Franchise control was rebuilt as a pill radiogroup in 4666a57 and IS drivable; its selectors are here."
metadata:
  type: reference
---

# `/admin/teams`: which controls a flow can actually drive

An `<option>` gets synthetic tap bounds from **its index inside its own parent
only**; `tapOnSyntheticElement` scans `document.querySelectorAll('option')` in
DOCUMENT ORDER and acts on the FIRST bounds match. Mechanism in
[[native-select-option-taps]]. Consequence on this screen: a select is reachable
only when every select above it in the DOM has fewer options than the target
index — which nothing can arrange.

| control | shape | drivable? |
|---|---|---|
| `league-filter` (list header) | `<select>`, first in the DOM | yes |
| `team-league` (detail) | `<select>`, second | **no — still broken, deferred** |
| Franchise (detail) | `role="radiogroup"` of pills since **4666a57** | yes |

So: never try to set a team's League from a flow. `team-management-edit-a-team`
has never touched it, and that is why.

## Driving the Franchise picker (NEO-254)

Pills are `role="radio"` buttons inside `<div id="team-franchise"
role="radiogroup">`, labelled by a `Franchise` span. Match them by their VISIBLE
TEXT — the label is the text:

* `No franchise` — the "none" pill (NOT "— none —"; renamed for exactly this).
* one pill per franchise in the SELECTED TEAM'S SPORT, label = franchise name,
  sorted alphabetically, with anything just started here appended unsorted.
* `+ Start a new franchise…` is a **disclosure button OUTSIDE the group** (it is
  a command, not an option). Match it as `".*Start a new franchise.*"` — a
  leading `+` is an invalid regex quantifier, so do not write the literal.
  It reveals `New franchise name` (a `primitives/Input`, so tap the LABEL text —
  see [[input-primitive-has-no-resource-id]]) plus a `Start` button.
* `Start` is find-or-create and only sets the DRAFT. **`Save` commits the link.**
  Status: `Started the <name> franchise. Save the team to put it on there.` /
  `<name> was already a franchise. …`. Team save says `Saved <full name>.`
* `See the franchise` deep-links to `/admin/franchises?franchise=<id>` — the
  cheapest way into the franchise view, and it proves the save stored an id.

**`FRANCHISE_PILL_CAP` is 24.** Past 24 franchises in one sport the group renders
a filtered slice and grows its own `Filter franchises` box; the checked pill is
always force-kept, an unchecked one can be sliced out. Fine on a per-PR preview
(only the two admin franchise flows ever create one), but that is the failure
mode to recognise. The group is also `max-h-40 overflow-y-auto`, so centre the
pill before tapping.

## The other side

`/admin/franchises` can only REMOVE (`Remove <full team name>` →
`Took <label> off this franchise.`); `NewTeamForm` has no franchise field. So
membership is set from the team side and cut from the franchise side, and
`admin-franchises-link-teams.yaml` covers that round trip.
