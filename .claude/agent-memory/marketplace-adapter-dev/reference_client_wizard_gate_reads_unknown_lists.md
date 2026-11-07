---
name: client-wizard-gate-reads-unknown-lists
description: The set-builder client opens the review wizard from unknownPlayers/unknownTeams, not batchId; a server batch holding only decided (auto-linked) rows is committed silently
metadata:
  type: reference
---

`resolveChecklistEntities` can return a `batchId` with empty `unknownPlayers` and
`unknownTeams` (auto-linked names are in neither list; NEO-221's "Back to
matching" batch too). `CardChecklist.resolveAndCommit` computes
`noNames = unknownPlayers.length === 0 && unknownTeams.length === 0` and, with no
teams/titles/autograph step owed, calls `runCommit(preview)` straight away. The
commit still consumes the batch, so its `link` decisions land, unseen.

**How to apply:** a server-side rule that "opens the batch" (NEO-424 D4) is not
visible until the client's wizard gate knows about it. When adding a decided-row
kind, add a field to the action result and read it in `noNames`. To tell "rule
never fired" from "fired but silent" on dev, check the committed card's
`teamOnCardIds` / `playerLinks`: the commit's own fast path uses the same
lookup as the gate, so a link it could not make itself came from a decision.
Related: [[pure-router-rows-carry-nb-value]].
