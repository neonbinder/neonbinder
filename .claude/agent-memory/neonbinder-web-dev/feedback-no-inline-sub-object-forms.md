---
name: no-inline-sub-object-forms
description: Owner rejects inline fields that create a DIFFERENT object inside a form; use a modal that completes the sub-object first, then selects it
metadata:
  type: feedback
---

When a picker needs an option that does not exist yet, do not reveal inline
fields for the missing object underneath the picker and create it as a side
effect of the parent form's Save. Present a modal that creates the object and
then selects it, or navigate to that object's own screen and come back.

**Why:** reviewing PR #228 (NEO-240) on the Vercel preview, the owner called
Team Management's inline `New league name` / `New league abbreviation` fields —
captioned "Created for this team's sport when you save." — "confusing", and
chose the modal of the two options they named. The confusion is structural: the
fields describe a LEAGUE while sitting in a form whose Save button is about a
TEAM, so nothing on screen says which object a press commits, or when the league
comes into existence. The inline path had also skipped the near-match duplicate
guard that the object's own screen uses, which is how duplicate spellings get
into shared reference tables.

**How to apply:** any "+ Add a new …" option inside a select. Extract the real
add form from the entity's own admin screen and render it in both places rather
than writing a second, thinner one — the shared form is what keeps the duplicate
guard on both surfaces. The sentinel option value stays a COMMAND: never let it
land in the draft's state, so the select reverts to its previous value while the
modal is open and cancelling costs nothing to undo. Also keep a local copy of
the just-created row in the dropdown's options — a controlled `<select>` whose
value names an option the reactive query has not returned yet renders blank.
