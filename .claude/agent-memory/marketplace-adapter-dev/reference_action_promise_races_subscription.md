---
name: action-promise-races-subscription
description: a Convex action's promise resolves independently of the query subscription carrying its internal mutations' writes; UI gated on the promise can act on a snapshot missing the last writes; empty-as-absent must never become a diff claim
metadata:
  type: reference
---

Unlike a mutation (whose promise waits for the client to observe its commit),
an ACTION's promise resolves on the action response alone. Writes the action
made through `ctx.runMutation` reach `useQuery` subscribers on their own
schedule, possibly after the promise. So anything gated on the action promise
(the pairing dialog's Confirm via `fetchInFlight`) can read a reactive snapshot
that lacks the action's final mutation.

Signature seen in the checklist fetch: the BSC team lookup patches candidates
in 50-card chunks; a re-sync review showed exactly the LAST chunk (a
contiguous 20-card run) with no team, while every other run of the same code
was clean. Contiguous last-chunk loss = this race; scattered losses = per-card
lookup failures (`fetchBscCardTeamNames` folds a failed fetch and "no team on
file" into the same absent entry).

**How to apply:** never let an empty marketplace value become a diff
suggestion that clears NB data — absence is not a claim (the diff skips
`teamOnCardIds` when the incoming list is empty, and the commit chunk refuses
to write an empty team list). When adding a field enriched after streaming,
assume the confirmed card may lack it. Related: [[sync-action-message-is-log-only]].
