---
name: name-bounds-three-tiers
description: NEO-246/NEO-251 roster-name bounds live in three places with three different answers (adapter drops, boundary refuses, chunk drops) - which answer is correct depends on who authored the payload
metadata:
  type: project
---

Roster/player-name bounds (`MAX_CARD_PLAYERS` = 20, `MAX_CARD_TEAMS` = 8 in
`convex/features/cardAttention.ts`; `MAX_PLAYER_NAME_LENGTH` = 120 in
`lib/players/name-limits.ts`) are enforced at three tiers, deliberately with
three different behaviours:

1. **Adapter parse** (`convex/adapters/buysportscards.ts:boundParsedNames`,
   `convex/adapters/sportlots.ts:SL_MAX_SUBJECTS/SL_MAX_SUBJECT_LENGTH`) —
   **drops**. an over-long NAME is dropped (never truncated); an over-cap COUNT is
   refused as a whole roster (`[]`) and counted into `fetchBscChecklist`'s
   `message` beside `collisions` (count only). SportLots rejects the whole row
   on any doubt.
2. **Commit boundary** (`convex/selectorOptions.ts:assertCardBatchWithinLimits`,
   called from `commitCardChecklist`, `resolveChecklistEntities`,
   `diffChecklistAgainstExisting`, always AFTER `requireAdmin`) — **refuses**,
   whole batch, before any write. Client-authored payload, so refusal is right.
3. **Commit chunk** (`selectorOptions.ts:boundPendingNames`) — **drops**. Covers
   the two cases the boundary cannot see: the merge of a row's stored backlog
   with the names this sync stamped (15 + 10 = 25 with neither side wrong), and
   legacy rows already over-cap in the DB.

**Why:** refusing a client payload is honest; refusing a real upstream row would
fail an operator's whole sync over a page NB merely read.

**How to apply:** when auditing a new bound, ask who authored the value. Caller
input → refuse. Marketplace page or a merge → drop. Also two standing rules from
this work, both worth enforcing in review:
- An error message names the LENGTH and the NB card number, never the offending
  text (it reaches Sentry and the browser console).
- An over-long name is **dropped, never truncated** — a truncated name is a
  person who does not exist and reaches `players.findOrCreate` looking real.

**Settled on PR #234 (2026-09-06):** the count cap no longer trims; a roster NB
cannot represent is refused and surfaced as a count. The chunk-tier drop now
reports `droppedPendingNameCount` so `unreviewedNameCount` is exact.

Related: [[checklist-commit-trust-boundary]], [[convex-auth-boundary]]
