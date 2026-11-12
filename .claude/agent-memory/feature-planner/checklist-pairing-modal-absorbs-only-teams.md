---
name: checklist-pairing-modal-absorbs-only-teams
description: CardPairingModal's ABSORB merges only `teams` from later candidate-row updates; anything else patched onto checklistCandidates after the dialog opened (teamLookup, checklistConflict, players) never reaches the commit, so post-fetch operator answers apply to the PairingResult cards client-side
metadata:
  type: project
---
`fetchCardChecklist` stamps every per-card answer (publisher-checklist teams,
`teamLookup`, `checklistConflict`) on the candidate rows server-side, in step
3c, before `startCandidateBatch`. The Match Cards dialog then absorbs rows
append-only and, for rows it already holds, adopts a late `teams` and nothing
else. The one-marketplace path converts the live rows once
(`candidatesToPairingCards`) and commits.

So a step that adds answers AFTER the stream has been absorbed (NEO-490's
operator checklist matching) cannot patch candidate rows and expect them to
arrive. It sits between the pairing result and `handlePairingConfirm`, edits
the `PairingResult.cards`, and gets any server-only resolution (comma team
texts) from an admin action that returns answers rather than writing rows.

**Why:** found planning NEO-490 (2026-11-11).

**How to apply:** check where in fetch -> pairing -> diff -> resolve ->
commit a new answer is produced; if after the stream, apply it to the
PairingCards and keep the server rule in one pure helper both sides call.
