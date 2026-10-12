---
name: same-name-player-panel
description: NEO-332 same-name PICK STEP ("Which <name> is this?") — inserted READY with no lookup, bulk create skips it, bulk skip decides it; locators, why to click the TOP candidate, why an untouched pick step yields to a settled team, and why a second dated fork beside an undated catalogue row is refused
metadata:
  type: reference
---

Since NEO-332 a player row that 2+ NB players answer to (and the card's year
and team do not narrow to one) is its own wizard step, the PICK step. The old
"Same name, different people" panel inside the New Player step is gone.

Locators (all user-visible):
- heading, the `<h3>`'s direct text: a heading matching `Which .* is this?`
- intro line: `We've got N on file under that name. Pick the one on this card.`
  (capped: `More than N answer to that name — …`)
- list: labelled `Players already filed under this name`, each candidate
  named `Link to <name>, [On a roster that year, ]b. YYYY · <career>`. One click
  = a link decision. Footer `Link to existing instead` also matches `Link to .*`,
  so scope to the list.
- footer: `Create new` (NOT `Add as New Player`), `Link to existing instead`,
  `Skip <name> — not a person`. `Create new` opens the New Player step
  (`Add as New Player` + `Back to the list`) and only then runs the lookup.
- read-back: `Linked to <name>, b. YYYY` (Decided list, which collapses past 5,
  and the `Decision for <name>` panel). After a walk's skips the list is
  usually folded: link, then click the next step's footer `Back to previous decision` and read `Linked to …` inside the `Decision for <name>` group
  (the read-only panel; the live footer group of the same name is not
  rendered then).
- the catalogue holds real same-name rows, often UNDATED. You cannot fork a
  name twice beside one: `createByAdmin` (`adoptOrForkOnCreate`) forks past
  ONE undated rival but REFUSES a dated create once there are several and any
  is undated ("2 players are already filed under X. Pick the right one…").
  The refusal renders in the add form's button row (below the fold) and the
  form stays filled, so the flow sees only "no Added line"; the proof is a
  `ConvexError` on `players:createByAdmin` in convex-logs. NPB `Shuya Yamada`
  is therefore ONE fork (b. 1851) + the catalogue's row = 2 on file (CI run
  38197074499 lost a whole run to the 3-on-file plan). Assert the undated
  candidate with a name pattern `Link to <name>, (?!b\. ).+` (a negative lookahead)
  rather than pinning catalogue career text.

Bulk: `Add remaining players as new (N)` excludes these rows and can read (0)
while they remain; `Skip remaining names (N)` decides them.

Click the TOP candidate (`.first()`): rows lower down can fall under the dialog footer.

**It can be the step on screen when the wizard opens** (READY, no lookup), and
an UNTOUCHED pick step is an implicit player pin: it yields to the first
settled undecided team/league (`resolveNav`), including career teams staged
by OTHER rows' lookups. `Create new` pins it (an edit); `Back to the list`
unpins. So a flow that must hold the pick step for several steps needs the
batch's other lookups to be slow or already drained — on a catalogue-loaded
preview a set with a handful of unknowns stages and settles career teams in
seconds. Any drain loop must wake on the heading too, or it parks.
Related: [[catalogue-seeded-wizard-staging]].
