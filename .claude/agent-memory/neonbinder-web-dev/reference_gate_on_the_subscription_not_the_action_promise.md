---
name: gate-on-the-subscription-not-the-action-promise
description: A commit button that waits for an action's runMutation writes must gate on a marker the SUBSCRIPTION shows, latched in the same reducer step that absorbs the data — never on the action promise
metadata:
  type: reference
---

An action's promise resolves before `useQuery` subscribers necessarily see the
writes it made through `ctx.runMutation` (and before any `runAfter` retry it
scheduled even runs). NEO-341: the Match Cards Confirm unlocked on the
`fetchCardChecklist` promise, so the last 50-card chunk of BSC teams could be
confirmed away.

Shape that worked:
- Make the data itself the marker. Candidate rows are `pending` ONLY while a
  team lookup is owed (`teamPending` input flag); everything else lands
  `ready`. So `ready === total === candidateCount` (batch id moved) means the
  client has seen every lookup, retries included. Pure check:
  `lib/cards/streamed-batch.ts`.
- Any "settled" marker that counts rows must be reachable: a last-wins
  `Map<ref,row>` left a duplicate-ref row pending forever. Map ref → rows[].
- In the modal, carry the flag INTO the reducer on the same `ABSORB` action
  that merges the data, and latch it. A prop read at click time can be true
  while the reducer still lacks the teams (ABSORB runs in an effect).
- A prop that is OMITTED means "not gated", so legacy callers/tests stay green;
  the one real caller always passes it.

Related: [[convex-mutation-resolves-after-queries-reflect-it]] (mutations are
the opposite: their promise waits for the subscription).
