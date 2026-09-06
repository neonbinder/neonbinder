---
name: neo254-same-name-panel-unreachable-from-ui
description: NEO-254's "Same name, different people" panel cannot be reached by any Maestro flow — every UI path that creates a player REFUSES to mint a second row under an existing normalized name, so the two-or-more state only arrives from the terminal-only bulk preload.
metadata:
  type: reference
---

# The same-name candidate panel has no E2E-reachable fixture

`SameNamePlayerPanel` renders only when `enrichment.existingCandidates` holds
**two or more** `players` rows sharing one `(nameNormalized, sportId)` key
(`players.buildExistingPlayerCandidates` returns `[]` below two). Read live on
2026-09-06, **every** UI route into `players` refuses to produce that state:

| route | behaviour with 1 existing same-name row |
|---|---|
| `/admin/players` → "Add a player" → `players.createByAdmin` | `candidates.length === 1` → returns the existing id, `created: false`, page says *"That player already exists — opened it."* |
| PlayerPicker "+ Create" (card drawer, quick-add, `UnreviewedNameFixer`) → `players.findOrCreate` | same early `return candidates[0]._id` |
| the review wizard's "Add as New Player" → `commitCardChecklistPrelude` | never reached: `resolveUnknownsAndStartBatch` queues a name only when `resolveNameForReview` says `matchCount !== 1`, so a name with exactly one row is never presented at all |
| `/admin/players` rename → `players.savePlayerFields` | throws `NAME_TAKEN:<id>` on a normalized-key collision |
| delete + re-create under another sport | **there is no delete-player mutation anywhere** |

## A birth-year field does NOT change this (checked again 2026-09-06, commit 8df17e0)

`/admin/players` gained a `Birth year (optional)` field and a "Create anyway"
button, and it is tempting to read those as "so now you can add the second one".
You cannot. `createByAdmin` returns on `candidates.length === 1` **before** the
birth year is read; `candidateForBirthYear` only ever picks *between rows that
already exist*, so the year is a tiebreaker and never a fork. The branch's own
test `"createByAdmin still reports created: false for the single existing row"`
pins it, and a convex-test probe of A(1960) → B(none) → B(1975) ends with ONE
row. "Create anyway" therefore cannot do what it says while exactly one
same-name row exists — a product finding, raised on NEO-254.

The ambiguity comes from `convex/preloadPlayers.ts` — an `internalAction`
behind `ALLOW_PRELOAD_PLAYERS` + a confirmation literal, reachable only from a
terminal, and `docs/operations/neo254-player-preload.md` says explicitly never
to run it on a deployment anyone is testing a preview against.

**So do not try to write this flow.** Covered instead by
`SameNamePlayerPanel.test.tsx`, `EntityReviewWizard.test.tsx`,
`playersAmbiguity.test.ts` and `commitCardChecklist.entityReview.test.ts`.
If E2E coverage is ever required, it needs a *product* decision first — a
`/testing/seed-*` page (the precedent is `seed-placeholder-run` /
`seed-placeholder-upload`), or a birth-year field on the admin form that lets
`createByAdmin` fork a genuinely second person.

Related: [[neo254-undated-career-teams-surfaces]],
[[e2e-fixtures-come-from-the-ui-not-seeds]].
