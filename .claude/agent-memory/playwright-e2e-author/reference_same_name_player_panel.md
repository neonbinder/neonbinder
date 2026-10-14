---
name: same-name-player-panel
description: NEO-332 same-name PICK STEP ("Which <name> is this?") — inserted READY with no lookup, bulk create skips it, bulk skip decides it; locators, why to click the TOP candidate, why it HOLDS its place since NEO-339 (and blocks a team drain), how to detect it, and why a second dated fork beside an undated catalogue row is refused
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

**It is usually the step on screen when the wizard opens** (READY, no
lookup, while every other staged name is pending), and since NEO-339 it
HOLDS its place, touched or not (`holdPresentedRow` = `pinnedRowHasEdits ||
pickStep`, gating only the teams-first yield): teams and leagues settling
elsewhere no longer take it away. `Create new` holds via `pinnedRowHasEdits`;
`Back to the list` returns to the held list. Answering it (link or skip)
hands control back to the walk: leagues → teams → players. Dependency
surfacing still comes first: a row waiting on its own staged teams/league
still moves the walk (not gated by the hold).

Consequences for specs:
- A pick step is a player row (`Skip <name> — not a person`), so any drain
  that exits on that control exits at once under a held pick step and
  answers no team. Skip it first (the Maestro suite had
  `util-wizard-skip-held-pick-step`, called by the walk util after its
  lookup wait; `walkToPlayerRow` in `support/wizard.ts` needs the same).
  Only the one presented before teams settle can block; others come up
  after the teams.
- Detect it by the footer: every live step has exactly one of `Create new`,
  `Add as New Player( anyway)?`, `Skip . (not a team|no league)`, `Next
  (Enter)` or `Confirm & Save`; `Create new` means a pick step. Branch on
  one `.or()` locator, never a timed visibility probe.
- A spec that must stay ON the pick step must not call the walk helper.
  With the batch settled the step is still there, so steps on it need no
  drain; waiting the lookups out first makes the post-link `Back to
  previous decision` deterministic (with lookups out the walk may present
  nothing, and that footer control renders only with a presented row).

Related: [[catalogue-seeded-wizard-staging]].
