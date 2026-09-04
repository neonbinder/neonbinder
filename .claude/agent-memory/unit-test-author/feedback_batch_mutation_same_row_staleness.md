---
name: feedback_batch_mutation_same_row_staleness
description: A batch mutation that OCC-checks baseVersion per decision, using a workingVersion map it updates after each write, will falsely mark every decision after the first on the SAME entity "stale" — even within one call, even for a no-op repeat. Found on NEO-211's applySelectorSyncSuggestions.
metadata:
  type: feedback
---

**The pattern to look for:** a mutation that accepts an array of
per-row/per-field "decisions" (each carrying the same `baseVersion` snapshot
read once by a reactive query), loops over them in one transaction, and
enforces optimistic concurrency by comparing `decision.baseVersion` against a
`workingVersion` map it **itself bumps after every write** in the same loop
(`convex/selectorOptions.ts`'s `applySelectorSyncSuggestions`, NEO-211).

**The defect:** any SECOND decision touching the same row in that call reads
`workingVersion` as already advanced by the FIRST decision's write, so it is
counted "stale" — indistinguishable in the response from an actual concurrent
edit by someone else — even when:
- the two decisions are about different fields/sides of the same row (the
  exact shape the UI's own review modal invites: "accept BSC's rename, decline
  SportLots'" in one Apply click), or
- the two decisions are an EXACT repeat of each other (proven with
  `[decision, decision]` — the second still goes stale, because the version
  check runs before the decline branch's own "already recorded, no-op"
  short-circuit).

**How I found it:** the ticket's own review-modal component test asserted
"accepting one side and declining the other is a normal outcome" as a
FRONTEND behavior (payload shape correct), but no backend test exercised what
`applySelectorSyncSuggestions` actually does with two decisions naming the
same `existingId` in one call. Whenever a UI test says "these two things
happen together normally," check whether the MUTATION they both feed has an
integration test proving the SAME combination — a payload-shape test and an
effect test are not the same test.

**How to apply:** whenever a batch mutation does OCC via a self-mutating
in-memory version map, add a test with 2+ decisions against the SAME entity
in ONE call and assert the actual outcome (not just that the call doesn't
throw). If a "second decision, same entity, same call" property is desired,
the fix is comparing against the ORIGINAL per-entity snapshot version (captured
once before the loop) rather than the just-written `workingVersion`, while
still using `workingVersion`/`workingValue` for cross-field derived state
(e.g. the clash check) that legitimately needs to see earlier writes in the
same call.

See [[project_convex_test_patterns]] for the general convex-test setup this
used (calling the public mutation directly, `t.run` seeding, `lastUpdated`
sentinels).
