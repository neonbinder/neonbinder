---
name: neo248-manual-stint
description: NEO-248 made a hand-typed career stint durable on entityReviewQueue.source.manualStint — auth is clean, but the two paths that DON'T read it (bulk create, and dialog remount) are where operator input is silently lost or resurrected
metadata:
  type: project
---

`entityReviewQueue.source.manualStint {fromYear, toYear?}` is where a
hand-typed career stint lives (NEO-248, fixing a NEO-236 regression). Written
only by `stageCareerTeamRows`'s new `careerTeams` arg; a Wikidata proposal
deliberately writes NONE, and that absence is the discriminator the wizard
uses to rebuild exactly the manual chips.

**Why:** the years used to live only in `EntityReviewWizard`'s per-row React
state, and staging the team's New Team step is itself a row change, so the
wipe fired on the way to the very step the operator asked for.

**How to apply — the audit lens for anything touching this field:**

- Auth on the staging mutation is solid and is not the interesting part:
  `requireAdmin` + `assertOwnsRow`, and the fill-in patch path re-checks
  `source.kind === "careerTeamOf" && source.playerRowId === playerRow._id &&
  manualStint === undefined`, on a row already scoped to the owned row's
  (selectorOptionId, batchId). No arg-supplied id reaches a write.
- The real class of defect is **a durable store that only ONE consumer
  reads.** Two paths decide a player row without going through the wizard's
  chip list, and both drop the years even though they are sitting on the
  staged row:
  - `decideAllRemaining` ("Add All Remaining as New") writes a bare
    `{action:"create"}` per player row and never gathers `manualStint`.
    Worse than a gesture: `EntityReviewWizard`'s auto-add loop re-fires that
    mutation on a debounce once armed and checks neither `pinnedRowHasEdits`
    nor `careerEntryDirty`, so a background timer can decide a row the
    operator is still typing on.
  - The wizard is conditionally mounted in `CardChecklist.tsx`, so closing
    the dialog clears `stagedCareerTeamsByRow`. Addition is now durable
    (server-side) but REMOVAL is session-only — a deleted chip rehydrates
    from `manualStint` on reopen and rides into `players.teamYears`.
- Career-team names are bounded at 120 in `stageCareerTeamRowsImpl` (silent
  `continue`, not a throw) but **not** in `recordDecision`, which stores
  `decision.manualCareerTeams[].name` verbatim with no length check. Match-
  only resolution at commit keeps it from minting a team, so it is a storage
  gap, not a creation one.
- `.slice(0, MAX_CAREER_TEAM_CREATES)` is applied per-array, so
  `careerTeamNames` + `careerTeams` together carry up to 128 extras into one
  call. Writes stay capped at 64 per player by the loop's
  `alreadyStagedForPlayer + added.length` guard; reads and patches do not.
- The 64 cap `break`s at the TOP of the loop, ahead of the fill-in patch, so
  a player already at 64 steps silently drops a typed stint's years with
  `added === 0`.

Related: [[neo220-review-session-safety]] (resume/delete driven by client card
data), [[name-bounds-three-tiers]] (adapter/commit/chunk name caps).
