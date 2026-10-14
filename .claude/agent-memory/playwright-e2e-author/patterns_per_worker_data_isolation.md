---
name: patterns_per_worker_data_isolation
description: "HARD RULE for every spec: CI runs 8 shards concurrently against ONE Convex preview and selectorOptions+cardChecklist+teams are GLOBAL (not per-user). Specs write only to a per-worker hand-made set and never to a shared real set; never assert a filtered result COUNT on a shared admin list. SET-REGISTRY.md is the authority."
---

# Per-worker data isolation (concurrent shards) — HARD RULE

**Why:** CI runs 8 shards at once, each its own VM and its own signed-in test
user (`worker=<n>`), against ONE shared Convex preview. `selectorOptions` (the
set catalog) and `cardChecklist` are **GLOBAL**: no per-user scoping field. If
two specs edit the **same real set** (metadata, features, cards) they stomp each
other and contend on the same docs (OCC retries, slow mutations, assertion
timeouts, list races). This is the root cause of "a different spec flakes every
CI run."

**`ATTEMPT_ID` does NOT make a shared-set write safe**: it protects against a
PRIOR attempt's debris, never against a CONCURRENT shard.

## The rule for EVERY spec you write or touch (GUIDE R7a)
1. **Default = a per-worker hand-made set** under real ancestors (Baseball /
   2024 keeps seeded teams and players warm), suffixed with the worker index.
   Do all editing there: metadata, features, card CRUD, grouping, panels.
2. **Never write to a shared REAL set. At all.** Only the seed provisions them;
   every other spec reads. `SET-REGISTRY.md` lists the sole writers and the
   read-only visitors. There is no serial/"isolated" lane to put a shared-set
   writer on; if a spec seems to need a shared-set write, that is a finding to
   raise, not a licence.
3. Reads of a shared set are concurrent-safe; WRITES are not.

## Hand-made set specifics
- Use the drill helpers (`drillToCustomSet` etc., R9) rather than inlining.
- For CARD tests, add a hand-made variant type under the hand-made set, then add
  cards in ITS checklist.
- TeamPicker / team search is **sport-scoped**: the seeded teams exist for
  BASEBALL only, so TeamPicker specs drill Baseball/2024 or "Yankees" returns
  no matches.

## `teams` is global too, and other specs create rows in it MID-RUN
Teams are globally-shared rows (dedup key = normalized name + sportId).
Committing a player in the entity-review/checklist path resolves that player's
Wikidata career and get-or-creates every club in it, so a spec on another shard
can insert e.g. "Gulf Coast League Yankees" seconds into yours. So **any
assertion of the form "filtering by X narrows to exactly 1" must filter on a
FULL unique minted name, never a distinctive-looking token** (a CI run failed on
"Yankees" matching 2 of 105 teams; nothing was broken, the needle was too short).

## NEVER assert a filtered RESULT COUNT on a shared admin list
`{n} of {N} teams` is fine when you filter to a name only this attempt owns.
**`{n} matches` on `/admin/players` is not**: that counter appears only while a
search term is present, and the search runs through Convex's search index, which
is **word-wise**. A minted name that is a bag of tokens collides with other
shards' fixtures on shared tokens (a measured run reported "3 matches" for one
exact minted string). The fix is the minted-single-token rule (GUIDE) plus waiting
on **the row** by its perceivable name (the Open/Create control for that name)
rather than on a count. Teams and leagues use `{n} of {N}`, a client-side
substring filter, which IS safe to compose with a count.

See [[feedback_no_secrets_via_env]] for the other hard authoring rule.
