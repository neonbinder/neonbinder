---
name: action-result-beats-subscription
description: A Convex ACTION's promise resolves before the client's subscriptions show the action's writes (mutations wait, actions do not); a client gate that reads a useQuery ref right after awaiting an action can act on a pre-write snapshot
metadata:
  type: reference
---

`convex/src/browser/sync/request_manager.ts`: a MutationResponse is held until
the client transitions past its `ts` (read-your-writes); an ActionResponse
resolves immediately ("Actions are intentionally decoupled"). So
`await fetchChecklist(...)` then reading `liveCandidatesRef.current` can see
the snapshot from BEFORE the action's last internal mutation.

Seen in NEO-330 diagnosis: the NEO-255 one-marketplace auto-keep
(`CardChecklist.awaitStreamedBatch`) gated on batchId + total only, so on a
36-card BSC-only set (one team-lookup chunk, patched ~50ms before the action
returned) every card's `teams` was still empty in the snapshot it promoted.
`resolveChecklistEntities` then saw no team names (no `teams:findByNameAndSport`
in the logs) and the post-commit BSC queue resolved teams with no review gate.
Large sets hide it: only the LAST chunk's patch races.

**How to apply:** when a client continues after an action, gate on a value
the action's writes set (a per-row status, a stamped version), never on
counts the pre-write snapshot already satisfies. Proof in logs: the reactive
query's re-run Completion lands AFTER the action's Completion. See
[[sync-action-message-is-log-only]].
