---
name: same-name-player-panel
description: NEO-332 same-name PICK STEP ("Which <name> is this?") — inserted READY with no lookup, bulk create skips it, bulk skip decides it; selectors, why to tap the TOP candidate, why it HOLDS its place since NEO-339 (and blocks a team drain), how to detect it in one read, and why a second dated fork beside an undated catalogue row is refused
metadata:
  type: reference
---

Since NEO-332 a player row that 2+ NB players answer to (and the card's year
and team do not narrow to one) is its own wizard step, the PICK step. The old
"Same name, different people" panel inside the New Player step is gone.

Selectors (all user-visible):
- heading, the `<h3>`'s direct text: `text: "Which .* is this\\?"`
- intro line: `We've got N on file under that name. Pick the one on this card.`
  (capped: `More than N answer to that name — …`)
- list: `id: "Players already filed under this name"`, each candidate
  `id: "Link to <name>, [On a roster that year, ]b. YYYY · <career>"`. One tap
  = a link decision. Footer `Link to existing instead` also matches `Link to .*`,
  so scope with `childOf` the list.
- footer: `Create new` (NOT `Add as New Player`), `Link to existing instead`,
  `Skip <name> — not a person`. `Create new` opens the New Player step
  (`Add as New Player` + `Back to the list`) and only then runs the lookup.
- read-back: `Linked to <name>, b. YYYY` (Decided list, which collapses past 5,
  and the `Decision for <name>` panel). After a walk's skips the list is
  usually folded: link, then tap the next step's footer `id: "Back to previous
  decision"` and read `text: "Linked to …"` `childOf: id: "Decision for <name>"`
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
  candidate with `id: "Link to <name>, (?!b\\. ).+"` (Java lookahead works)
  rather than pinning catalogue career text.

Bulk: `Add remaining players as new (N)` excludes these rows and can read (0)
while they remain; `Skip remaining names (N)` decides them.

Tap `index: 0` (top): rows lower down can fall under the dialog footer
([[inner-scroller-clip-is-invisible-to-maestro]], [[guard-a-tap-at-a-footer-buttons-x]]).

**It is usually the step on screen when the wizard opens** (READY, no
lookup, while every other staged name is pending), and since NEO-339 it
HOLDS its place, touched or not (`holdPresentedRow` = `pinnedRowHasEdits ||
pickStep`, gating only the teams-first yield): teams and leagues settling
elsewhere no longer take it away. `Create new` holds via `pinnedRowHasEdits`;
`Back to the list` returns to the held list. Answering it (link or skip)
hands control back to the walk: leagues → teams → players. Dependency moves
(a row waiting on its own staged teams/league) are NOT gated by the hold.

Consequences for flows:
- A pick step is a player row (`Skip <name> — not a person`), so any drain
  that exits on that control exits at once under a held pick step and
  answers no team. Skip it first: `util-wizard-skip-held-pick-step` (the
  walk util calls it after its lookup wait). Only the one presented before
  teams settle can block; others come up after the teams.
- Detect it in ONE read: every live step's footer has exactly one node whose
  direct text matches `Create new|Add as New Player( anyway)?|Skip . (not a
  team|no league)` — `Create new` means a pick step. Branch with
  `when: true`, never a `when: visible` probe (7s on a miss).
- A flow that must stay ON the pick step must not call the walk util. With
  the batch settled the step is still there, so STEPS on it need no drain;
  waiting the lookups out first makes the post-link `Back to previous
  decision` deterministic (with lookups out the walk may present nothing,
  and that footer control renders only with a presented row).

Related: [[wizard-drain-loop-one-footer-guard]], [[catalogue-seeded-wizard-staging]].
