---
name: patterns-ready-at-insert-preselect-has-no-career-editor
description: A player row inserted READY with a preselect shows no career editor, so a helper or spec that needs a creatable player must skip past it; real-name fixtures can gain a namesake from seeded data in another sport
metadata:
  type: project
---

A player with one namesake on file, in any sport, is inserted READY with no
lookup. Its footer primary reads `Link to <name> (<sport>)`, and it offers no
career editor, no "Decide team" and no automatic staging. "Add as New Player
anyway" is the press that requests the lookup and opens the New Player step.

**Why:** a person row is not a creatable row. A real-name fixture has no fixed
set of namesakes: seeded reference data in another sport can give any name one,
so a row that was creatable on one seed can be a preselect on the next.

**How to apply:**
- A caller that must create the player it lands on uses
  `walkToPlayerRow(page, { readyToCreate: true })`, which skips preselected
  rows as well as held ones.
- Match the preselect by its trailing `(<sport>)`: a plain exact match reads
  `Link to <name>` and a pick-step row reads `Link to <name>, ...`.
- A skip can land on a team step or a lookup wait, so re-run the walk over the
  team/league steps after it rather than asserting the next player at once.
- A pick step ("Which <name> is this?") has no career editor either.
- See [[patterns-button-name-substring-hides-demoted-variants]].
